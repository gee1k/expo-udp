package expo.modules.udp

import android.os.Bundle
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.DatagramPacket
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class ExpoUdpModule : Module() {
  private val nextSocketId = AtomicInteger(1)
  private val sockets = ConcurrentHashMap<Int, UdpSocketState>()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  override fun definition() = ModuleDefinition {
    Name("ExpoUdp")

    Events("onMessage", "onError", "onListening", "onClose")

    AsyncFunction("createSocket") Coroutine { options: SocketOptions? ->
      withContext(Dispatchers.IO) {
        val socketId = nextSocketId.getAndIncrement()
        val socket = MulticastSocket(null)
        val socketType = options?.type ?: "udp4"

        if (socketType != "udp4" && socketType != "udp6") {
          socket.close()
          throw udpException(ERR_INVALID_ARGUMENT, "Unsupported UDP socket type '$socketType'.")
        }

        socket.reuseAddress = options?.reuseAddress ?: false
        socket.broadcast = options?.broadcast ?: false
        sockets[socketId] = UdpSocketState(
          id = socketId,
          type = socketType,
          socket = socket
        )
        socketId
      }
    }

    AsyncFunction("bind") Coroutine { socketId: Int, options: BindOptions? ->
      withContext(Dispatchers.IO) {
        val state = getOpenSocket(socketId)
        state.lock.withLockCompat {
          if (state.closed.get()) {
            throw udpException(ERR_SOCKET_CLOSED, "Socket $socketId is closed.")
          }
          if (state.bound.get()) {
            return@withLockCompat addressMap(state)
          }

          val port = validPort(options?.port ?: 0, allowZero = true)
          val address = options?.address ?: anyAddressForType(state.type)

          try {
            options?.reuseAddress?.let { state.socket.reuseAddress = it }
            state.socket.bind(InetSocketAddress(parseAddressForType(address, state.type), port))
            state.bound.set(true)
            startReceiving(state)
            addressMap(state).also { boundAddress ->
              sendEvent("onListening", bundleFromMap(boundAddress))
            }
          } catch (error: Throwable) {
            closeSocket(socketId, emitClose = true)
            throw udpException(ERR_BIND_FAILED, "Failed to bind socket $socketId.", error)
          }
        }
      }
    }

    AsyncFunction("send") Coroutine { socketId: Int, bytes: ByteArray, remote: RemoteAddress ->
      withContext(Dispatchers.IO) {
        val state = getOpenSocket(socketId)
        val remoteHost = remote.host ?: remote.address
          ?: throw udpException(ERR_INVALID_ARGUMENT, "Remote host is required.")
        val address = parseAddressForType(remoteHost, state.type)
        val port = validPort(remote.port, allowZero = false)
        val packet = DatagramPacket(bytes, bytes.size, address, port)

        try {
          state.socket.send(packet)
        } catch (error: Throwable) {
          if (state.closed.get() || state.socket.isClosed) {
            throw udpException(ERR_SOCKET_CLOSED, "Socket $socketId is closed.", error)
          }
          throw udpException(ERR_SEND_FAILED, "Failed to send UDP packet from socket $socketId.", error)
        }
      }
    }

    AsyncFunction("close") Coroutine { socketId: Int ->
      withContext(Dispatchers.IO) {
        closeSocket(socketId, emitClose = true)
      }
    }

    AsyncFunction("address") Coroutine { socketId: Int ->
      withContext(Dispatchers.IO) {
        val state = sockets[socketId] ?: return@withContext null
        if (state.closed.get() || state.socket.isClosed || !state.bound.get()) {
          null
        } else {
          addressMap(state)
        }
      }
    }

    AsyncFunction("setBroadcast") Coroutine { socketId: Int, enabled: Boolean ->
      withContext(Dispatchers.IO) {
        val state = getOpenSocket(socketId)
        try {
          state.socket.broadcast = enabled
        } catch (error: Throwable) {
          throw udpException(ERR_INVALID_ARGUMENT, "Failed to set broadcast on socket $socketId.", error)
        }
      }
    }

    AsyncFunction("joinMulticastGroup") Coroutine { socketId: Int, group: String, iface: String? ->
      withContext(Dispatchers.IO) {
        val state = getOpenSocket(socketId)
        val groupAddress = parseMulticastAddress(group, state.type)
        val networkInterface = resolveNetworkInterface(iface)

        try {
          joinOrLeaveMulticast(state, groupAddress, networkInterface, join = true)
        } catch (error: Throwable) {
          throw udpException(ERR_MULTICAST_UNSUPPORTED, "Failed to join multicast group '$group'.", error)
        }
      }
    }

    AsyncFunction("leaveMulticastGroup") Coroutine { socketId: Int, group: String, iface: String? ->
      withContext(Dispatchers.IO) {
        val state = getOpenSocket(socketId)
        val groupAddress = parseMulticastAddress(group, state.type)
        val networkInterface = resolveNetworkInterface(iface)

        try {
          joinOrLeaveMulticast(state, groupAddress, networkInterface, join = false)
        } catch (error: Throwable) {
          throw udpException(ERR_MULTICAST_UNSUPPORTED, "Failed to leave multicast group '$group'.", error)
        }
      }
    }

    AsyncFunction("setMulticastTTL") Coroutine { socketId: Int, ttl: Int ->
      withContext(Dispatchers.IO) {
        val state = getOpenSocket(socketId)
        if (ttl !in 0..255) {
          throw udpException(ERR_INVALID_ARGUMENT, "Multicast TTL must be between 0 and 255.")
        }
        try {
          state.socket.timeToLive = ttl
        } catch (error: Throwable) {
          throw udpException(ERR_MULTICAST_UNSUPPORTED, "Failed to set multicast TTL on socket $socketId.", error)
        }
      }
    }

    AsyncFunction("setMulticastLoopback") Coroutine { socketId: Int, enabled: Boolean ->
      withContext(Dispatchers.IO) {
        val state = getOpenSocket(socketId)
        try {
          state.socket.loopbackMode = !enabled
        } catch (error: Throwable) {
          throw udpException(ERR_MULTICAST_UNSUPPORTED, "Failed to set multicast loopback on socket $socketId.", error)
        }
      }
    }

    OnDestroy {
      closeAllSockets()
      scope.cancel()
    }

  }

  private fun startReceiving(state: UdpSocketState) {
    if (state.receiveJob != null) {
      return
    }

    state.receiveJob = scope.launch {
      val buffer = ByteArray(MAX_DATAGRAM_SIZE)
      while (!state.closed.get() && !state.socket.isClosed) {
        val packet = DatagramPacket(buffer, buffer.size)
        try {
          state.socket.receive(packet)
          val bytes = packet.data.copyOfRange(packet.offset, packet.offset + packet.length)
          sendEvent(
            "onMessage",
            Bundle().apply {
              putInt("socketId", state.id)
              putByteArray("data", bytes)
              putString("remoteAddress", packet.address.hostAddress)
              putInt("remotePort", packet.port)
              putString("family", addressFamily(packet.address))
            }
          )
        } catch (error: Throwable) {
          if (state.closed.get() || state.socket.isClosed) {
            break
          }
          emitError(state.id, ERR_RECEIVE_FAILED, "Failed to receive UDP packet.", error)
          closeSocket(state.id, emitClose = true)
          break
        }
      }
    }
  }

  private fun getOpenSocket(socketId: Int): UdpSocketState {
    val state = sockets[socketId]
      ?: throw udpException(ERR_SOCKET_CLOSED, "Socket $socketId is closed.")
    if (state.closed.get() || state.socket.isClosed) {
      throw udpException(ERR_SOCKET_CLOSED, "Socket $socketId is closed.")
    }
    return state
  }

  private fun closeSocket(socketId: Int, emitClose: Boolean) {
    val state = sockets.remove(socketId) ?: return
    if (!state.closed.compareAndSet(false, true)) {
      return
    }
    state.receiveJob?.cancel()
    state.socket.close()
    if (emitClose) {
      sendEvent("onClose", Bundle().apply { putInt("socketId", socketId) })
    }
  }

  private fun closeAllSockets() {
    sockets.keys.toList().forEach { socketId ->
      closeSocket(socketId, emitClose = true)
    }
  }

  private fun addressMap(state: UdpSocketState): Map<String, Any?> {
    val localAddress = state.socket.localAddress
    return mapOf(
      "socketId" to state.id,
      "address" to normalizeLocalAddress(localAddress, state.type),
      "port" to state.socket.localPort,
      "family" to state.type
    )
  }

  private fun joinOrLeaveMulticast(
    state: UdpSocketState,
    groupAddress: InetAddress,
    networkInterface: NetworkInterface?,
    join: Boolean
  ) {
    val socketAddress = InetSocketAddress(groupAddress, state.socket.localPort)
    if (networkInterface != null) {
      if (join) {
        state.socket.joinGroup(socketAddress, networkInterface)
      } else {
        state.socket.leaveGroup(socketAddress, networkInterface)
      }
      return
    }

    @Suppress("DEPRECATION")
    if (join) {
      state.socket.joinGroup(groupAddress)
    } else {
      state.socket.leaveGroup(groupAddress)
    }
  }

  private fun resolveNetworkInterface(iface: String?): NetworkInterface? {
    if (iface.isNullOrBlank()) {
      return null
    }

    NetworkInterface.getByName(iface)?.let { return it }
    val interfaces = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
    interfaces.firstOrNull { it.displayName == iface }?.let { return it }

    val ifaceAddress = InetAddress.getByName(iface)
    return NetworkInterface.getByInetAddress(ifaceAddress)
      ?: throw udpException(ERR_INVALID_ARGUMENT, "Network interface '$iface' was not found.")
  }

  private fun parseMulticastAddress(address: String, type: String): InetAddress {
    val inetAddress = parseAddressForType(address, type)
    if (!inetAddress.isMulticastAddress) {
      throw udpException(ERR_INVALID_ARGUMENT, "Address '$address' is not a multicast address.")
    }
    return inetAddress
  }

  private fun parseAddressForType(address: String, type: String): InetAddress {
    val inetAddress = InetAddress.getByName(address)
    if (type == "udp4" && inetAddress !is Inet4Address) {
      throw udpException(ERR_INVALID_ARGUMENT, "Expected an IPv4 address for udp4 socket.")
    }
    if (type == "udp6" && inetAddress !is Inet6Address) {
      throw udpException(ERR_INVALID_ARGUMENT, "Expected an IPv6 address for udp6 socket.")
    }
    return inetAddress
  }

  private fun anyAddressForType(type: String): String {
    return if (type == "udp6") "::" else "0.0.0.0"
  }

  private fun validPort(port: Int, allowZero: Boolean): Int {
    val minimum = if (allowZero) 0 else 1
    if (port !in minimum..65535) {
      throw udpException(ERR_INVALID_ARGUMENT, "Port must be between $minimum and 65535.")
    }
    return port
  }

  private fun normalizeLocalAddress(address: InetAddress?, type: String): String? {
    return when {
      address == null -> null
      address.isAnyLocalAddress -> anyAddressForType(type)
      type == "udp4" && address is Inet4Address -> address.hostAddress
      type == "udp6" && address is Inet6Address -> address.hostAddress
      else -> address.hostAddress
    }
  }

  private fun addressFamily(address: InetAddress?): String {
    return if (address is Inet6Address) "udp6" else "udp4"
  }

  private fun emitError(socketId: Int, code: String, message: String, cause: Throwable? = null) {
    sendEvent(
      "onError",
      Bundle().apply {
        putInt("socketId", socketId)
        putString("code", code)
        putString("message", cause?.localizedMessage?.let { "$message $it" } ?: message)
      }
    )
  }

  private fun bundleFromMap(values: Map<String, Any?>): Bundle {
    return Bundle().apply {
      values.forEach { (key, value) ->
        when (value) {
          null -> putString(key, null)
          is Int -> putInt(key, value)
          is String -> putString(key, value)
          is Boolean -> putBoolean(key, value)
          is ByteArray -> putByteArray(key, value)
          else -> putString(key, value.toString())
        }
      }
    }
  }

  companion object {
    private const val MAX_DATAGRAM_SIZE = 65535
    private const val ERR_SOCKET_CLOSED = "ERR_SOCKET_CLOSED"
    private const val ERR_BIND_FAILED = "ERR_BIND_FAILED"
    private const val ERR_SEND_FAILED = "ERR_SEND_FAILED"
    private const val ERR_RECEIVE_FAILED = "ERR_RECEIVE_FAILED"
    private const val ERR_MULTICAST_UNSUPPORTED = "ERR_MULTICAST_UNSUPPORTED"
    private const val ERR_INVALID_ARGUMENT = "ERR_INVALID_ARGUMENT"

    private fun udpException(code: String, message: String, cause: Throwable? = null): CodedException {
      return CodedException(code, message, cause)
    }
  }
}

class SocketOptions : Record {
  @Field
  var type: String = "udp4"

  @Field
  var reuseAddress: Boolean? = null

  @Field
  var reusePort: Boolean? = null

  @Field
  var broadcast: Boolean? = null
}

class BindOptions : Record {
  @Field
  var port: Int = 0

  @Field
  var address: String? = null

  @Field
  var host: String? = null

  @Field
  var reuseAddress: Boolean? = null
}

class RemoteAddress : Record {
  @Field
  var address: String? = null

  @Field
  var host: String? = null

  @Field
  var port: Int = 0
}

private class UdpSocketState(
  val id: Int,
  val type: String,
  val socket: MulticastSocket
) {
  val bound = AtomicBoolean(false)
  val closed = AtomicBoolean(false)
  val lock = Any()
  var receiveJob: Job? = null
}

private inline fun <T> Any.withLockCompat(block: () -> T): T {
  synchronized(this) {
    return block()
  }
}
