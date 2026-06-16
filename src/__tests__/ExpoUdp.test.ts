type Listener = (event: Record<string, unknown>) => void;

const listeners = new Map<string, Set<Listener>>();

const mockNativeModule = {
  createSocket: jest.fn(),
  bind: jest.fn(),
  send: jest.fn(),
  close: jest.fn(),
  address: jest.fn(),
  setBroadcast: jest.fn(),
  joinMulticastGroup: jest.fn(),
  leaveMulticastGroup: jest.fn(),
  setMulticastTTL: jest.fn(),
  setMulticastLoopback: jest.fn(),
  addListener: jest.fn((eventName: string, listener: Listener) => {
    const eventListeners = listeners.get(eventName) ?? new Set<Listener>();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);

    return {
      remove: jest.fn(() => {
        eventListeners.delete(listener);
      }),
    };
  }),
};

jest.mock('../ExpoUdpModule', () => ({
  __esModule: true,
  default: mockNativeModule,
}));

const { createSocket } = require('../index') as typeof import('../index');
const React = require('react') as typeof import('react');
const TestRenderer = require('react-test-renderer') as typeof import('react-test-renderer');
const { useUdpSocket } = require('../index') as typeof import('../index');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function emit(eventName: string, event: Record<string, unknown>) {
  for (const listener of listeners.get(eventName) ?? []) {
    listener(event);
  }
}

describe('expo-udp', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    const originalConsoleError = console.error;
    listeners.clear();
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('react-test-renderer is deprecated')) {
        return;
      }
      originalConsoleError(...args);
    });
    mockNativeModule.createSocket.mockResolvedValue(1);
    mockNativeModule.bind.mockResolvedValue({
      address: '0.0.0.0',
      port: 12345,
      family: 'udp4',
    });
    mockNativeModule.address.mockResolvedValue(null);
    mockNativeModule.send.mockResolvedValue(undefined);
    mockNativeModule.close.mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('creates sockets and forwards bind/address calls by socket id', async () => {
    const socket = await createSocket({ type: 'udp4', reuseAddress: true });

    await expect(socket.bind({ port: 12345 })).resolves.toEqual({
      address: '0.0.0.0',
      port: 12345,
      family: 'udp4',
    });
    await socket.address();

    expect(mockNativeModule.createSocket).toHaveBeenCalledWith({
      type: 'udp4',
      reuseAddress: true,
    });
    expect(mockNativeModule.bind).toHaveBeenCalledWith(1, { port: 12345 });
    expect(mockNativeModule.address).toHaveBeenCalledWith(1);
  });

  it('normalizes string payloads to Uint8Array before sending', async () => {
    const socket = await createSocket();

    await socket.send('hello', { host: '127.0.0.1', port: 9999 });

    const [, data, remote] = mockNativeModule.send.mock.calls[0];
    expect(data).toBeInstanceOf(Uint8Array);
    expect(Array.from(data)).toEqual([104, 101, 108, 108, 111]);
    expect(remote).toEqual({ host: '127.0.0.1', port: 9999 });
  });

  it('filters native events by socket id', async () => {
    mockNativeModule.createSocket.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const first = await createSocket();
    const second = await createSocket();
    const firstListener = jest.fn();
    const secondListener = jest.fn();

    first.addListener('message', firstListener);
    second.addListener('message', secondListener);

    emit('onMessage', {
      socketId: 2,
      data: new Uint8Array([7]),
      remoteAddress: '127.0.0.1',
      remotePort: 9999,
      family: 'udp4',
    });

    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalledWith({
      data: new Uint8Array([7]),
      remoteAddress: '127.0.0.1',
      remotePort: 9999,
      family: 'udp4',
    });
  });

  it('closes sockets idempotently and rejects sends after close', async () => {
    const socket = await createSocket();

    await socket.close();
    await socket.close();

    await expect(
      socket.send(new Uint8Array([1]), { host: '127.0.0.1', port: 9999 })
    ).rejects.toMatchObject({
      code: 'ERR_SOCKET_CLOSED',
    });
    expect(mockNativeModule.close).toHaveBeenCalledTimes(1);
  });

  it('useUdpSocket closes the page-local socket on unmount', async () => {
    function Harness() {
      useUdpSocket();
      return null;
    }

    let renderer: import('react-test-renderer').ReactTestRenderer | undefined;

    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(React.createElement(Harness));
    });

    await TestRenderer.act(async () => {
      renderer?.unmount();
    });

    expect(mockNativeModule.close).toHaveBeenCalledWith(1);
  });

  it('useUdpSocket does not recreate sockets when inline option values are unchanged', async () => {
    function Harness(props: { tick: number }) {
      useUdpSocket({
        socket: { type: 'udp4', reuseAddress: true },
        bind: { port: 43210, address: '0.0.0.0' },
      });
      return React.createElement('value', { tick: props.tick });
    }

    let renderer: import('react-test-renderer').ReactTestRenderer | undefined;

    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(React.createElement(Harness, { tick: 1 }));
    });

    await TestRenderer.act(async () => {
      renderer?.update(React.createElement(Harness, { tick: 2 }));
    });

    expect(mockNativeModule.createSocket).toHaveBeenCalledTimes(1);
    expect(mockNativeModule.close).not.toHaveBeenCalled();
  });

  it('useUdpSocket automatically binds by default when bind options are provided', async () => {
    function Harness() {
      useUdpSocket({
        socket: { type: 'udp4', reuseAddress: true },
        bind: { port: 43210, address: '0.0.0.0' },
      });
      return null;
    }

    await TestRenderer.act(async () => {
      TestRenderer.create(React.createElement(Harness));
    });

    expect(mockNativeModule.createSocket).toHaveBeenCalledWith({
      type: 'udp4',
      reuseAddress: true,
    });
    expect(mockNativeModule.bind).toHaveBeenCalledWith(1, {
      port: 43210,
      address: '0.0.0.0',
    });
  });

  it('useUdpSocket creates the socket but waits for manual bind when autoBind is false', async () => {
    let hookResult: import('../index').UseUdpSocketResult | null = null;

    function Harness() {
      hookResult = useUdpSocket({
        autoBind: false,
        bind: { port: 43210, address: '0.0.0.0' },
      });
      return null;
    }

    await TestRenderer.act(async () => {
      TestRenderer.create(React.createElement(Harness));
    });

    expect(mockNativeModule.createSocket).toHaveBeenCalledTimes(1);
    expect(mockNativeModule.bind).not.toHaveBeenCalled();

    await TestRenderer.act(async () => {
      await hookResult?.bind();
    });

    expect(mockNativeModule.bind).toHaveBeenCalledWith(1, {
      port: 43210,
      address: '0.0.0.0',
    });
  });

  it('useUdpSocket recreates a socket when bind is called after close', async () => {
    mockNativeModule.createSocket.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    let hookResult: import('../index').UseUdpSocketResult | null = null;

    function Harness() {
      hookResult = useUdpSocket({
        autoBind: false,
        socket: { type: 'udp4', reuseAddress: true },
        bind: { port: 43210, address: '0.0.0.0' },
      });
      return null;
    }

    await TestRenderer.act(async () => {
      TestRenderer.create(React.createElement(Harness));
    });

    await TestRenderer.act(async () => {
      await hookResult?.close();
    });

    await TestRenderer.act(async () => {
      await hookResult?.bind();
    });

    expect(mockNativeModule.createSocket).toHaveBeenCalledTimes(2);
    expect(mockNativeModule.close).toHaveBeenCalledWith(1);
    expect(mockNativeModule.bind).toHaveBeenCalledWith(2, {
      port: 43210,
      address: '0.0.0.0',
    });
  });
});
