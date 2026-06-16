import Darwin
import ExpoModulesCore
import Foundation

private enum ExpoUdpFamily: String, Enumerable {
  case udp4
  case udp6

  var addressFamily: Int32 {
    switch self {
    case .udp4:
      return AF_INET
    case .udp6:
      return AF_INET6
    }
  }

  var label: String {
    return rawValue
  }
}

private struct ExpoUdpSocketOptions: Record {
  @Field var type: ExpoUdpFamily = .udp4
  @Field var reuseAddress: Bool = false
  @Field var reusePort: Bool = false
  @Field var broadcast: Bool = false
}

private struct ExpoUdpBindOptions: Record {
  @Field var port: Int = 0
  @Field var address: String?
  @Field var host: String?
  @Field var reuseAddress: Bool?
  @Field var reusePort: Bool?
}

private struct ExpoUdpRemote: Record {
  @Field var port: Int = 0
  @Field var address: String?
  @Field var host: String?
}

public class ExpoUdpModule: Module {
  private let queue = DispatchQueue(label: "expo.modules.udp.sockets")
  private var nextSocketId = 1
  private var sockets: [Int: ExpoUdpSocket] = [:]

  public func definition() -> ModuleDefinition {
    Name("ExpoUdp")

    Events("onMessage", "onError", "onListening", "onClose")

    AsyncFunction("createSocket") { (options: ExpoUdpSocketOptions) -> Int in
      return try self.queue.sync {
        try self.createSocket(options: options)
      }
    }

    AsyncFunction("bind") { (socketId: Int, options: ExpoUdpBindOptions) -> [String: Any] in
      return try self.queue.sync {
        let socket = try self.requireOpenSocket(socketId)
        try socket.applyReuseOptions(reuseAddress: options.reuseAddress, reusePort: options.reusePort)
        try socket.bind(options: options)
        self.startReadSource(for: socket)
        let address = try socket.localAddress()
        self.emitListening(socketId: socketId, address: address)
        return address
      }
    }

    AsyncFunction("send") { (socketId: Int, bytes: Data, remote: ExpoUdpRemote) -> Void in
      try self.queue.sync {
        let socket = try self.requireOpenSocket(socketId)
        try socket.send(bytes: bytes, remote: remote)
      }
    }

    AsyncFunction("close") { (socketId: Int) -> Void in
      self.queue.sync {
        self.closeSocket(socketId, emitClose: true)
      }
    }

    AsyncFunction("address") { (socketId: Int) -> [String: Any]? in
      return try self.queue.sync {
        let socket = try self.requireOpenSocket(socketId)
        return try socket.localAddress()
      }
    }

    AsyncFunction("setBroadcast") { (socketId: Int, enabled: Bool) -> Void in
      try self.queue.sync {
        let socket = try self.requireOpenSocket(socketId)
        try socket.setBroadcast(enabled)
      }
    }

    AsyncFunction("joinMulticastGroup") { (socketId: Int, group: String, iface: String?) -> Void in
      try self.queue.sync {
        let socket = try self.requireOpenSocket(socketId)
        try socket.updateMulticastMembership(group: group, iface: iface, join: true)
      }
    }

    AsyncFunction("leaveMulticastGroup") { (socketId: Int, group: String, iface: String?) -> Void in
      try self.queue.sync {
        let socket = try self.requireOpenSocket(socketId)
        try socket.updateMulticastMembership(group: group, iface: iface, join: false)
      }
    }

    AsyncFunction("setMulticastTTL") { (socketId: Int, ttl: Int) -> Void in
      try self.queue.sync {
        let socket = try self.requireOpenSocket(socketId)
        try socket.setMulticastTTL(ttl)
      }
    }

    AsyncFunction("setMulticastLoopback") { (socketId: Int, enabled: Bool) -> Void in
      try self.queue.sync {
        let socket = try self.requireOpenSocket(socketId)
        try socket.setMulticastLoopback(enabled)
      }
    }

    OnDestroy {
      self.closeAllSockets()
    }

    OnAppContextDestroys {
      self.closeAllSockets()
    }
  }

  private func createSocket(options: ExpoUdpSocketOptions) throws -> Int {
    let fd = Darwin.socket(options.type.addressFamily, SOCK_DGRAM, IPPROTO_UDP)
    guard fd >= 0 else {
      throw ExpoUdpException(.invalidArgument, "Failed to create \(options.type.label) UDP socket: \(lastErrnoMessage())")
    }

    do {
      try setNonBlocking(fd)
      let socket = ExpoUdpSocket(id: nextSocketId, fd: fd, family: options.type)
      try socket.applyReuseOptions(reuseAddress: options.reuseAddress, reusePort: options.reusePort)
      if options.broadcast {
        try socket.setBroadcast(true)
      }
      sockets[nextSocketId] = socket
      nextSocketId += 1
      return socket.id
    } catch {
      Darwin.close(fd)
      throw error
    }
  }

  private func requireOpenSocket(_ socketId: Int) throws -> ExpoUdpSocket {
    guard let socket = sockets[socketId], !socket.isClosed else {
      throw ExpoUdpException(.socketClosed, "Socket \(socketId) is closed or does not exist")
    }
    return socket
  }

  private func startReadSource(for socket: ExpoUdpSocket) {
    guard socket.readSource == nil else {
      return
    }

    let source = DispatchSource.makeReadSource(fileDescriptor: socket.fd, queue: queue)
    socket.readSource = source
    source.setEventHandler { [weak self, weak socket] in
      guard let self, let socket, !socket.isClosed else {
        return
      }
      self.readAvailableDatagrams(from: socket)
    }
    source.setCancelHandler { [weak socket] in
      guard let socket else {
        return
      }
      if socket.fd >= 0 {
        Darwin.close(socket.fd)
        socket.fd = -1
      }
    }
    source.resume()
  }

  private func readAvailableDatagrams(from socket: ExpoUdpSocket) {
    while !socket.isClosed {
      var storage = sockaddr_storage()
      var storageLength = socklen_t(MemoryLayout<sockaddr_storage>.size)
      var buffer = [UInt8](repeating: 0, count: 65_535)
      let received = withUnsafeMutablePointer(to: &storage) { storagePointer in
        storagePointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { addressPointer in
          Darwin.recvfrom(socket.fd, &buffer, buffer.count, 0, addressPointer, &storageLength)
        }
      }

      if received > 0 {
        let data = Data(buffer.prefix(received))
        var payload = sockaddrToRecord(storage)
        payload["socketId"] = socket.id
        payload["data"] = data
        payload["remoteAddress"] = payload["address"]
        payload["remotePort"] = payload["port"]
        sendEvent("onMessage", payload)
        continue
      }

      if received == 0 {
        return
      }

      let code = errno
      if code == EAGAIN || code == EWOULDBLOCK || code == EINTR {
        return
      }

      emitError(socketId: socket.id, code: .receiveFailed, message: "Failed to receive datagram: \(errnoMessage(code))")
      return
    }
  }

  private func closeSocket(_ socketId: Int, emitClose: Bool) {
    guard let socket = sockets.removeValue(forKey: socketId), !socket.isClosed else {
      return
    }

    socket.isClosed = true
    if let source = socket.readSource {
      socket.readSource = nil
      source.cancel()
    }

    if socket.fd >= 0 {
      Darwin.close(socket.fd)
      socket.fd = -1
    }

    if emitClose {
      sendEvent("onClose", ["socketId": socketId])
    }
  }

  private func closeAllSockets() {
    queue.sync {
      let ids = Array(sockets.keys)
      for id in ids {
        closeSocket(id, emitClose: true)
      }
    }
  }

  private func emitListening(socketId: Int, address: [String: Any]) {
    var payload = address
    payload["socketId"] = socketId
    sendEvent("onListening", payload)
  }

  private func emitError(socketId: Int, code: ExpoUdpErrorCode, message: String) {
    sendEvent("onError", [
      "socketId": socketId,
      "code": code.rawValue,
      "message": message
    ])
  }
}

private final class ExpoUdpSocket {
  let id: Int
  var fd: Int32
  let family: ExpoUdpFamily
  var readSource: DispatchSourceRead?
  var isClosed = false

  init(id: Int, fd: Int32, family: ExpoUdpFamily) {
    self.id = id
    self.fd = fd
    self.family = family
  }

  func applyReuseOptions(reuseAddress: Bool?, reusePort: Bool?) throws {
    if reuseAddress == true {
      try setSocketOption(fd: fd, level: SOL_SOCKET, name: SO_REUSEADDR, value: 1, code: .invalidArgument, action: "set SO_REUSEADDR")
    }

    #if os(iOS) || os(tvOS) || os(macOS) || os(watchOS)
    if reusePort == true {
      try setSocketOption(fd: fd, level: SOL_SOCKET, name: SO_REUSEPORT, value: 1, code: .invalidArgument, action: "set SO_REUSEPORT")
    }
    #endif
  }

  func bind(options: ExpoUdpBindOptions) throws {
    try validatePort(options.port)
    let bindHost = options.address ?? options.host ?? anyAddress

    switch family {
    case .udp4:
      var address = sockaddr_in()
      address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      address.sin_family = sa_family_t(AF_INET)
      address.sin_port = in_port_t(options.port).bigEndian
      guard inet_pton(AF_INET, bindHost, &address.sin_addr) == 1 else {
        throw ExpoUdpException(.invalidArgument, "Invalid IPv4 bind address: \(bindHost)")
      }
      let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
      }
      guard result == 0 else {
        throw ExpoUdpException(.bindFailed, "Failed to bind socket \(id) to \(bindHost):\(options.port): \(lastErrnoMessage())")
      }

    case .udp6:
      var address = sockaddr_in6()
      address.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
      address.sin6_family = sa_family_t(AF_INET6)
      address.sin6_port = in_port_t(options.port).bigEndian
      guard inet_pton(AF_INET6, bindHost, &address.sin6_addr) == 1 else {
        throw ExpoUdpException(.invalidArgument, "Invalid IPv6 bind address: \(bindHost)")
      }
      let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in6>.size))
        }
      }
      guard result == 0 else {
        throw ExpoUdpException(.bindFailed, "Failed to bind socket \(id) to [\(bindHost)]:\(options.port): \(lastErrnoMessage())")
      }
    }
  }

  func send(bytes: Data, remote: ExpoUdpRemote) throws {
    try validatePort(remote.port)
    guard let host = remote.address ?? remote.host, !host.isEmpty else {
      throw ExpoUdpException(.invalidArgument, "Remote address is required")
    }

    let sent: Int
    switch family {
    case .udp4:
      var address = sockaddr_in()
      address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      address.sin_family = sa_family_t(AF_INET)
      address.sin_port = in_port_t(remote.port).bigEndian
      guard inet_pton(AF_INET, host, &address.sin_addr) == 1 else {
        throw ExpoUdpException(.invalidArgument, "Invalid IPv4 remote address: \(host)")
      }
      sent = bytes.withUnsafeBytes { bytesPointer in
        withUnsafePointer(to: &address) { addressPointer in
          addressPointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.sendto(fd, bytesPointer.baseAddress, bytes.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
          }
        }
      }

    case .udp6:
      var address = sockaddr_in6()
      address.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
      address.sin6_family = sa_family_t(AF_INET6)
      address.sin6_port = in_port_t(remote.port).bigEndian
      guard inet_pton(AF_INET6, host, &address.sin6_addr) == 1 else {
        throw ExpoUdpException(.invalidArgument, "Invalid IPv6 remote address: \(host)")
      }
      sent = bytes.withUnsafeBytes { bytesPointer in
        withUnsafePointer(to: &address) { addressPointer in
          addressPointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.sendto(fd, bytesPointer.baseAddress, bytes.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in6>.size))
          }
        }
      }
    }

    guard sent == bytes.count else {
      throw ExpoUdpException(.sendFailed, "Failed to send datagram from socket \(id): \(lastErrnoMessage())")
    }
  }

  func localAddress() throws -> [String: Any] {
    var storage = sockaddr_storage()
    var length = socklen_t(MemoryLayout<sockaddr_storage>.size)
    let result = withUnsafeMutablePointer(to: &storage) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.getsockname(fd, $0, &length)
      }
    }
    guard result == 0 else {
      throw ExpoUdpException(.socketClosed, "Failed to read socket \(id) address: \(lastErrnoMessage())")
    }
    return sockaddrToRecord(storage)
  }

  func setBroadcast(_ enabled: Bool) throws {
    guard family == .udp4 else {
      throw ExpoUdpException(.invalidArgument, "Broadcast is only supported for udp4 sockets")
    }
    try setSocketOption(fd: fd, level: SOL_SOCKET, name: SO_BROADCAST, value: enabled ? 1 : 0, code: .invalidArgument, action: "set SO_BROADCAST")
  }

  func updateMulticastMembership(group: String, iface: String?, join: Bool) throws {
    switch family {
    case .udp4:
      var request = ip_mreq()
      guard inet_pton(AF_INET, group, &request.imr_multiaddr) == 1 else {
        throw ExpoUdpException(.invalidArgument, "Invalid IPv4 multicast group: \(group)")
      }
      request.imr_interface = try ipv4InterfaceAddress(iface)
      var mutableRequest = request
      let option = join ? IP_ADD_MEMBERSHIP : IP_DROP_MEMBERSHIP
      let result = withUnsafePointer(to: &mutableRequest) {
        Darwin.setsockopt(fd, IPPROTO_IP, option, $0, socklen_t(MemoryLayout<ip_mreq>.size))
      }
      guard result == 0 else {
        throw ExpoUdpException(.multicastUnsupported, "Failed to \(join ? "join" : "leave") IPv4 multicast group \(group): \(lastErrnoMessage())")
      }

    case .udp6:
      var request = ipv6_mreq()
      guard inet_pton(AF_INET6, group, &request.ipv6mr_multiaddr) == 1 else {
        throw ExpoUdpException(.invalidArgument, "Invalid IPv6 multicast group: \(group)")
      }
      request.ipv6mr_interface = ipv6InterfaceIndex(iface)
      var mutableRequest = request
      let option = join ? IPV6_JOIN_GROUP : IPV6_LEAVE_GROUP
      let result = withUnsafePointer(to: &mutableRequest) {
        Darwin.setsockopt(fd, IPPROTO_IPV6, option, $0, socklen_t(MemoryLayout<ipv6_mreq>.size))
      }
      guard result == 0 else {
        throw ExpoUdpException(.multicastUnsupported, "Failed to \(join ? "join" : "leave") IPv6 multicast group \(group): \(lastErrnoMessage())")
      }
    }
  }

  func setMulticastTTL(_ ttl: Int) throws {
    guard (0...255).contains(ttl) else {
      throw ExpoUdpException(.invalidArgument, "Multicast TTL must be between 0 and 255")
    }

    switch family {
    case .udp4:
      var value = UInt8(ttl)
      let result = Darwin.setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &value, socklen_t(MemoryLayout<UInt8>.size))
      guard result == 0 else {
        throw ExpoUdpException(.multicastUnsupported, "Failed to set IPv4 multicast TTL: \(lastErrnoMessage())")
      }

    case .udp6:
      try setSocketOption(fd: fd, level: IPPROTO_IPV6, name: IPV6_MULTICAST_HOPS, value: ttl, code: .multicastUnsupported, action: "set IPv6 multicast hops")
    }
  }

  func setMulticastLoopback(_ enabled: Bool) throws {
    switch family {
    case .udp4:
      var value = UInt8(enabled ? 1 : 0)
      let result = Darwin.setsockopt(fd, IPPROTO_IP, IP_MULTICAST_LOOP, &value, socklen_t(MemoryLayout<UInt8>.size))
      guard result == 0 else {
        throw ExpoUdpException(.multicastUnsupported, "Failed to set IPv4 multicast loopback: \(lastErrnoMessage())")
      }

    case .udp6:
      try setSocketOption(fd: fd, level: IPPROTO_IPV6, name: IPV6_MULTICAST_LOOP, value: enabled ? 1 : 0, code: .multicastUnsupported, action: "set IPv6 multicast loopback")
    }
  }

  private var anyAddress: String {
    switch family {
    case .udp4:
      return "0.0.0.0"
    case .udp6:
      return "::"
    }
  }
}

private enum ExpoUdpErrorCode: String {
  case socketClosed = "ERR_SOCKET_CLOSED"
  case bindFailed = "ERR_BIND_FAILED"
  case sendFailed = "ERR_SEND_FAILED"
  case receiveFailed = "ERR_RECEIVE_FAILED"
  case multicastUnsupported = "ERR_MULTICAST_UNSUPPORTED"
  case invalidArgument = "ERR_INVALID_ARGUMENT"
}

private final class ExpoUdpException: Exception, @unchecked Sendable {
  private let errorCode: ExpoUdpErrorCode
  private let errorReason: String

  init(_ code: ExpoUdpErrorCode, _ reason: String) {
    self.errorCode = code
    self.errorReason = reason
    super.init()
  }

  override var code: String {
    return errorCode.rawValue
  }

  override var reason: String {
    return errorReason
  }
}

private func validatePort(_ port: Int) throws {
  guard (0...65_535).contains(port) else {
    throw ExpoUdpException(.invalidArgument, "Port must be between 0 and 65535")
  }
}

private func setNonBlocking(_ fd: Int32) throws {
  let flags = Darwin.fcntl(fd, F_GETFL, 0)
  guard flags >= 0 else {
    throw ExpoUdpException(.invalidArgument, "Failed to read socket flags: \(lastErrnoMessage())")
  }
  guard Darwin.fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else {
    throw ExpoUdpException(.invalidArgument, "Failed to set socket nonblocking mode: \(lastErrnoMessage())")
  }
}

private func setSocketOption(fd: Int32, level: Int32, name: Int32, value: Int, code: ExpoUdpErrorCode, action: String) throws {
  var option = Int32(value)
  let result = Darwin.setsockopt(fd, level, name, &option, socklen_t(MemoryLayout<Int32>.size))
  guard result == 0 else {
    throw ExpoUdpException(code, "Failed to \(action): \(lastErrnoMessage())")
  }
}

private func sockaddrToRecord(_ storage: sockaddr_storage) -> [String: Any] {
  var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
  var service = [CChar](repeating: 0, count: Int(NI_MAXSERV))
  var mutableStorage = storage
  let family = Int32(storage.ss_family)

  let result = withUnsafePointer(to: &mutableStorage) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      Darwin.getnameinfo($0, socklen_t(sockaddrLength(for: family)), &host, socklen_t(host.count), &service, socklen_t(service.count), NI_NUMERICHOST | NI_NUMERICSERV)
    }
  }

  if result == 0 {
    let address = String(cString: host)
    let port = Int(String(cString: service)) ?? 0
    return [
      "address": address,
      "host": address,
      "port": port,
      "family": family == AF_INET6 ? "udp6" : "udp4"
    ]
  }

  return [
    "address": family == AF_INET6 ? "::" : "0.0.0.0",
    "host": family == AF_INET6 ? "::" : "0.0.0.0",
    "port": 0,
    "family": family == AF_INET6 ? "udp6" : "udp4"
  ]
}

private func sockaddrLength(for family: Int32) -> Int {
  switch family {
  case AF_INET6:
    return MemoryLayout<sockaddr_in6>.size
  default:
    return MemoryLayout<sockaddr_in>.size
  }
}

private func ipv4InterfaceAddress(_ iface: String?) throws -> in_addr {
  var address = in_addr(s_addr: INADDR_ANY.bigEndian)
  guard let iface, !iface.isEmpty else {
    return address
  }

  if inet_pton(AF_INET, iface, &address) == 1 {
    return address
  }

  var interfaces: UnsafeMutablePointer<ifaddrs>?
  guard getifaddrs(&interfaces) == 0, let interfaces else {
    throw ExpoUdpException(.multicastUnsupported, "Failed to inspect network interfaces: \(lastErrnoMessage())")
  }
  defer {
    freeifaddrs(interfaces)
  }

  var cursor: UnsafeMutablePointer<ifaddrs>? = interfaces
  while let current = cursor {
    defer {
      cursor = current.pointee.ifa_next
    }

    guard String(cString: current.pointee.ifa_name) == iface,
          let socketAddress = current.pointee.ifa_addr,
          Int32(socketAddress.pointee.sa_family) == AF_INET else {
      continue
    }

    return socketAddress.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
      $0.pointee.sin_addr
    }
  }

  throw ExpoUdpException(.invalidArgument, "Could not find IPv4 address for interface \(iface)")
}

private func ipv6InterfaceIndex(_ iface: String?) -> UInt32 {
  guard let iface, !iface.isEmpty else {
    return 0
  }

  if let numericIndex = UInt32(iface) {
    return numericIndex
  }

  return if_nametoindex(iface)
}

private func lastErrnoMessage() -> String {
  return errnoMessage(errno)
}

private func errnoMessage(_ code: Int32) -> String {
  return String(cString: strerror(code))
}
