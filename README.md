# @isvend/expo-udp

A modern Expo native module for low-level UDP sockets on iOS and Android.

`@isvend/expo-udp` provides a small Promise-based socket API for unicast,
broadcast, multicast, IPv4, IPv6, and common UDP socket options. It also
exports a thin `useUdpSocket` hook for screen-local lifecycle management.

## Features

- Expo Modules API native implementation for iOS and Android.
- UDP4 and UDP6 sockets.
- Bind, send, receive, close, and local address lookup.
- Broadcast and multicast controls.
- Stable socket-level events: `message`, `error`, `listening`, and `close`.
- A small React hook for automatically creating, binding, and closing a socket
  inside a single screen or component.

## Installation

```sh
npm install @isvend/expo-udp
npx expo prebuild
```

Add the config plugin to your app config:

```json
{
  "expo": {
    "plugins": [
      [
        "@isvend/expo-udp",
        {
          "localNetworkUsageDescription": "This app uses the local network to discover and communicate with devices.",
          "multicast": true
        }
      ]
    ]
  }
}
```

`multicast` is optional. Enable it only when your app joins multicast groups.

## Raw Socket API

```ts
import { createSocket } from '@isvend/expo-udp';

const socket = await createSocket({ type: 'udp4', reuseAddress: true });

await socket.bind({ port: 12345, address: '0.0.0.0' });

const subscription = socket.addListener('message', (event) => {
  console.log(event.remoteAddress, event.remotePort, event.data);
});

await socket.send('hello', { host: '127.0.0.1', port: 12345 });

subscription.remove();
await socket.close();
```

Broadcast:

```ts
await socket.setBroadcast(true);
await socket.send('hello', { host: '255.255.255.255', port: 9999 });
```

Multicast:

```ts
await socket.bind({ port: 5353, address: '0.0.0.0' });
await socket.joinMulticastGroup('224.0.0.251');
await socket.setMulticastTTL(1);
```

## React Hook

`useUdpSocket` is a lifecycle helper for a single screen or component. It does
not share sockets globally, parse messages, route channels, reconnect, or own
app-level UDP services.

```ts
import { useUdpSocket } from '@isvend/expo-udp';

const { status, error, localAddress, send, close } = useUdpSocket({
  socket: { type: 'udp4', reuseAddress: true },
  bind: { port: 12345, address: '0.0.0.0' },
  onMessage(event) {
    console.log(event.data);
  },
});
```

Pass `autoBind: false` when you want to create the socket immediately but bind
it from a button or another user action:

```ts
const { bind, close } = useUdpSocket({
  autoBind: false,
  socket: { type: 'udp4', reuseAddress: true },
  bind: { port: 12345, address: '0.0.0.0' },
});

await bind();
await close();
```

## API

- `createSocket(options?)`
- `socket.bind(options?)`
- `socket.send(data, remote)`
- `socket.close()`
- `socket.address()`
- `socket.setBroadcast(enabled)`
- `socket.joinMulticastGroup(group, iface?)`
- `socket.leaveMulticastGroup(group, iface?)`
- `socket.setMulticastTTL(ttl)`
- `socket.setMulticastLoopback(enabled)`
- `socket.addListener('message' | 'error' | 'listening' | 'close', listener)`
- `useUdpSocket(options)`

## Types

```ts
type UdpSocketType = 'udp4' | 'udp6';
type UdpPayload = Uint8Array | ArrayBuffer | string;

type SocketAddress = {
  address: string;
  port: number;
  family: UdpSocketType;
};

type MessageEvent = {
  data: Uint8Array;
  remoteAddress: string;
  remotePort: number;
  family: UdpSocketType;
};
```

Binding to `0.0.0.0` or `::` means listening on all interfaces for that address
family. Bind to `127.0.0.1` or `::1` when you only want loopback traffic.

## Platform Notes

- iOS requires a local network usage description for local network traffic.
- iOS multicast may require Apple's multicast networking entitlement for App
  Store distribution.
- Android always needs `android.permission.INTERNET`.
- Android multicast over Wi-Fi may require
  `android.permission.CHANGE_WIFI_MULTICAST_STATE`; the config plugin adds it
  when `multicast: true`.
- Simulator and emulator networking differs from real devices, especially for
  broadcast and multicast. Validate those flows on hardware.

## Validation Status

Unicast, bind, send, receive, close, and close-then-rebind flows have been
exercised in the example app. Broadcast and multicast are implemented but should
be validated on the target physical networks and devices you plan to support.
