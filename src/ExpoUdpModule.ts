import { NativeModule, requireNativeModule } from 'expo';

import type {
  BindOptions,
  NativeCloseEvent,
  NativeErrorEvent,
  NativeListeningEvent,
  NativeMessageEvent,
  RemoteEndpoint,
  SocketAddress,
  UdpSocketOptions,
} from './ExpoUdp.types';

declare class ExpoUdpModule extends NativeModule<{
  onMessage: (event: NativeMessageEvent) => void;
  onError: (event: NativeErrorEvent) => void;
  onListening: (event: NativeListeningEvent) => void;
  onClose: (event: NativeCloseEvent) => void;
}> {
  createSocket(options: UdpSocketOptions): Promise<number>;
  bind(socketId: number, options: BindOptions): Promise<SocketAddress>;
  send(socketId: number, data: Uint8Array, remote: RemoteEndpoint): Promise<void>;
  close(socketId: number): Promise<void>;
  address(socketId: number): Promise<SocketAddress | null>;
  setBroadcast(socketId: number, enabled: boolean): Promise<void>;
  joinMulticastGroup(socketId: number, group: string, iface?: string): Promise<void>;
  leaveMulticastGroup(socketId: number, group: string, iface?: string): Promise<void>;
  setMulticastTTL(socketId: number, ttl: number): Promise<void>;
  setMulticastLoopback(socketId: number, enabled: boolean): Promise<void>;
}

export default requireNativeModule<ExpoUdpModule>('ExpoUdp');
