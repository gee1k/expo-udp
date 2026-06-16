import { NativeModule, registerWebModule } from 'expo';

function unsupported(): Promise<never> {
  return Promise.reject(new Error('expo-udp is only available on iOS and Android.'));
}

type NoEvents = Record<string, (...args: any[]) => void>;

class ExpoUdpModule extends NativeModule<NoEvents> {
  createSocket = unsupported;
  bind = unsupported;
  send = unsupported;
  close = unsupported;
  address = unsupported;
  setBroadcast = unsupported;
  joinMulticastGroup = unsupported;
  leaveMulticastGroup = unsupported;
  setMulticastTTL = unsupported;
  setMulticastLoopback = unsupported;
}

export default registerWebModule(ExpoUdpModule, 'ExpoUdpModule');
