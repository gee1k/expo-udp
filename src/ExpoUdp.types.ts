import type { EventSubscription } from 'expo-modules-core';

export type UdpSocketType = 'udp4' | 'udp6';

export type UdpPayload = Uint8Array | ArrayBuffer | string;

export type UdpSocketOptions = {
  type?: UdpSocketType;
  reuseAddress?: boolean;
  reusePort?: boolean;
};

export type BindOptions = {
  port?: number;
  address?: string;
};

export type RemoteEndpoint = {
  host: string;
  port: number;
};

export type SocketAddress = {
  address: string;
  port: number;
  family: UdpSocketType;
};

export type MessageEvent = {
  data: Uint8Array;
  remoteAddress: string;
  remotePort: number;
  family: UdpSocketType;
};

export type UdpErrorCode =
  | 'ERR_SOCKET_CLOSED'
  | 'ERR_BIND_FAILED'
  | 'ERR_SEND_FAILED'
  | 'ERR_RECEIVE_FAILED'
  | 'ERR_MULTICAST_UNSUPPORTED'
  | 'ERR_INVALID_ARGUMENT';

export type ErrorEvent = {
  code: UdpErrorCode | string;
  message: string;
};

export type UdpEventMap = {
  message: MessageEvent;
  error: Error;
  listening: SocketAddress;
  close: undefined;
};

export type UdpSocketStatus = 'idle' | 'creating' | 'binding' | 'listening' | 'error' | 'closed';

export type UdpSocket = {
  readonly id: number;
  bind(options?: BindOptions): Promise<SocketAddress>;
  send(data: UdpPayload, remote: RemoteEndpoint): Promise<void>;
  close(): Promise<void>;
  address(): Promise<SocketAddress | null>;
  setBroadcast(enabled: boolean): Promise<void>;
  joinMulticastGroup(group: string, iface?: string): Promise<void>;
  leaveMulticastGroup(group: string, iface?: string): Promise<void>;
  setMulticastTTL(ttl: number): Promise<void>;
  setMulticastLoopback(enabled: boolean): Promise<void>;
  addListener<TEventName extends keyof UdpEventMap>(
    eventName: TEventName,
    listener: (event: UdpEventMap[TEventName]) => void
  ): EventSubscription;
};

export type UseUdpSocketOptions = {
  autoBind?: boolean;
  socket?: UdpSocketOptions;
  bind?: BindOptions;
  onMessage?: (event: MessageEvent) => void;
  onError?: (error: Error) => void;
  onListening?: (address: SocketAddress) => void;
  onClose?: () => void;
};

export type UseUdpSocketResult = {
  socket: UdpSocket | null;
  status: UdpSocketStatus;
  error: Error | null;
  localAddress: SocketAddress | null;
  bind(options?: BindOptions): Promise<SocketAddress>;
  send(data: UdpPayload, remote: RemoteEndpoint): Promise<void>;
  close(): Promise<void>;
};

export type NativeMessageEvent = MessageEvent & {
  socketId: number;
};

export type NativeErrorEvent = ErrorEvent & {
  socketId: number;
};

export type NativeListeningEvent = SocketAddress & {
  socketId: number;
};

export type NativeCloseEvent = {
  socketId: number;
};
