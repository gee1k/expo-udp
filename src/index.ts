import type { EventSubscription } from 'expo-modules-core';
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  BindOptions,
  ErrorEvent,
  MessageEvent,
  NativeErrorEvent,
  NativeListeningEvent,
  NativeMessageEvent,
  RemoteEndpoint,
  SocketAddress,
  UdpEventMap,
  UdpPayload,
  UdpSocket,
  UdpSocketOptions,
  UdpSocketStatus,
  UseUdpSocketOptions,
  UseUdpSocketResult,
} from './ExpoUdp.types';
import ExpoUdpModule from './ExpoUdpModule';

export * from './ExpoUdp.types';

const EVENT_NAMES = {
  message: 'onMessage',
  error: 'onError',
  listening: 'onListening',
  close: 'onClose',
} as const;

type NativeEventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

function makeSocketClosedError(): Error & { code: string } {
  const error = new Error('UDP socket is closed') as Error & { code: string };
  error.code = 'ERR_SOCKET_CLOSED';
  return error;
}

function makeNativeError(event: ErrorEvent): Error & { code: string } {
  const error = new Error(event.message) as Error & { code: string };
  error.code = event.code;
  return error;
}

function encodeString(value: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value);
  }

  const encoded = unescape(encodeURIComponent(value));
  const bytes = new Uint8Array(encoded.length);
  for (let index = 0; index < encoded.length; index += 1) {
    bytes[index] = encoded.charCodeAt(index);
  }
  return bytes;
}

function normalizePayload(data: UdpPayload): Uint8Array {
  if (typeof data === 'string') {
    return encodeString(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(data);
}

class ExpoUdpSocket implements UdpSocket {
  readonly id: number;
  private closed = false;

  constructor(id: number) {
    this.id = id;
  }

  async bind(options: BindOptions = {}): Promise<SocketAddress> {
    this.assertOpen();
    return await ExpoUdpModule.bind(this.id, options);
  }

  async send(data: UdpPayload, remote: RemoteEndpoint): Promise<void> {
    this.assertOpen();
    await ExpoUdpModule.send(this.id, normalizePayload(data), remote);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    await ExpoUdpModule.close(this.id);
  }

  async address(): Promise<SocketAddress | null> {
    if (this.closed) {
      return null;
    }
    return await ExpoUdpModule.address(this.id);
  }

  async setBroadcast(enabled: boolean): Promise<void> {
    this.assertOpen();
    await ExpoUdpModule.setBroadcast(this.id, enabled);
  }

  async joinMulticastGroup(group: string, iface?: string): Promise<void> {
    this.assertOpen();
    await ExpoUdpModule.joinMulticastGroup(this.id, group, iface);
  }

  async leaveMulticastGroup(group: string, iface?: string): Promise<void> {
    this.assertOpen();
    await ExpoUdpModule.leaveMulticastGroup(this.id, group, iface);
  }

  async setMulticastTTL(ttl: number): Promise<void> {
    this.assertOpen();
    await ExpoUdpModule.setMulticastTTL(this.id, ttl);
  }

  async setMulticastLoopback(enabled: boolean): Promise<void> {
    this.assertOpen();
    await ExpoUdpModule.setMulticastLoopback(this.id, enabled);
  }

  addListener<TEventName extends keyof UdpEventMap>(
    eventName: TEventName,
    listener: (event: UdpEventMap[TEventName]) => void
  ) {
    const nativeEventName = EVENT_NAMES[eventName] as NativeEventName;
    return ExpoUdpModule.addListener(nativeEventName, (event: unknown) => {
      const socketId = (event as { socketId?: number }).socketId;
      if (socketId !== this.id) {
        return;
      }

      if (eventName === 'message') {
        const message = event as NativeMessageEvent;
        listener({
          data: message.data,
          remoteAddress: message.remoteAddress,
          remotePort: message.remotePort,
          family: message.family,
        } as UdpEventMap[TEventName]);
      } else if (eventName === 'error') {
        listener(makeNativeError(event as NativeErrorEvent) as unknown as UdpEventMap[TEventName]);
      } else if (eventName === 'listening') {
        const listening = event as NativeListeningEvent;
        listener({
          address: listening.address,
          port: listening.port,
          family: listening.family,
        } as UdpEventMap[TEventName]);
      } else {
        this.closed = true;
        listener(undefined as UdpEventMap[TEventName]);
      }
    });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw makeSocketClosedError();
    }
  }
}

export async function createSocket(options: UdpSocketOptions = {}): Promise<UdpSocket> {
  const socketId = await ExpoUdpModule.createSocket(options);
  return new ExpoUdpSocket(socketId);
}

export function useUdpSocket(options: UseUdpSocketOptions = {}): UseUdpSocketResult {
  const autoBind = options.autoBind ?? true;
  const socketOptionsKey = JSON.stringify(options.socket ?? {});
  const bindOptionsKey = JSON.stringify(options.bind ?? null);
  const [socket, setSocket] = useState<UdpSocket | null>(null);
  const [status, setStatus] = useState<UdpSocketStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [localAddress, setLocalAddress] = useState<SocketAddress | null>(null);
  const socketRef = useRef<UdpSocket | null>(null);
  const subscriptionsRef = useRef<EventSubscription[]>([]);
  const handlersRef = useRef(options);

  useEffect(() => {
    handlersRef.current = options;
  });

  const clearSubscriptions = useCallback(() => {
    for (const subscription of subscriptionsRef.current) {
      subscription.remove();
    }
    subscriptionsRef.current = [];
  }, []);

  const createManagedSocket = useCallback(async () => {
    setStatus('creating');
    setError(null);

    const nextSocket = await createSocket(handlersRef.current.socket);
    socketRef.current = nextSocket;
    setSocket(nextSocket);
    clearSubscriptions();
    subscriptionsRef.current = [
      nextSocket.addListener('message', (event: MessageEvent) => {
        handlersRef.current.onMessage?.(event);
      }),
      nextSocket.addListener('error', (eventError: Error) => {
        setError(eventError);
        setStatus('error');
        handlersRef.current.onError?.(eventError);
      }),
      nextSocket.addListener('listening', (address: SocketAddress) => {
        setLocalAddress(address);
        setStatus('listening');
        handlersRef.current.onListening?.(address);
      }),
      nextSocket.addListener('close', () => {
        setStatus('closed');
        setLocalAddress(null);
        handlersRef.current.onClose?.();
      }),
    ];

    return nextSocket;
  }, [clearSubscriptions]);

  useEffect(() => {
    let cancelled = false;
    let createdSocket: UdpSocket | null = null;

    async function start() {
      try {
        createdSocket = await createManagedSocket();
        if (cancelled) {
          await createdSocket.close();
          return;
        }

        if (autoBind && options.bind) {
          setStatus('binding');
          const address = await createdSocket.bind(options.bind);
          if (!cancelled) {
            setLocalAddress(address);
            setStatus('listening');
          }
        }

        if (cancelled) {
          clearSubscriptions();
          await createdSocket.close();
        }
      } catch (caught) {
        const nextError = caught instanceof Error ? caught : new Error(String(caught));
        if (!cancelled) {
          setError(nextError);
          setStatus('error');
          handlersRef.current.onError?.(nextError);
        }
      }
    }

    start().catch((caught) => {
      const nextError = caught instanceof Error ? caught : new Error(String(caught));
      setError(nextError);
      setStatus('error');
      handlersRef.current.onError?.(nextError);
    });

    return () => {
      cancelled = true;
      const currentSocket = createdSocket ?? socketRef.current;
      socketRef.current = null;
      setSocket(null);
      setLocalAddress(null);
      clearSubscriptions();
      if (currentSocket) {
        currentSocket.close().catch(() => {});
      }
    };
  }, [autoBind, bindOptionsKey, clearSubscriptions, createManagedSocket, socketOptionsKey]);

  const bind = useCallback(
    async (bindOptions?: BindOptions) => {
      const currentSocket = socketRef.current ?? (await createManagedSocket());

      setStatus('binding');
      const address = await currentSocket.bind(bindOptions ?? handlersRef.current.bind ?? {});
      setLocalAddress(address);
      setStatus('listening');
      return address;
    },
    [createManagedSocket]
  );

  const send = useCallback(async (data: UdpPayload, remote: RemoteEndpoint) => {
    if (!socketRef.current) {
      throw makeSocketClosedError();
    }
    await socketRef.current.send(data, remote);
  }, []);

  const close = useCallback(async () => {
    const currentSocket = socketRef.current;
    socketRef.current = null;
    setSocket(null);
    setLocalAddress(null);
    clearSubscriptions();
    setStatus('closed');
    if (currentSocket) {
      await currentSocket.close();
    }
  }, [clearSubscriptions]);

  return { socket, status, error, localAddress, bind, send, close };
}
