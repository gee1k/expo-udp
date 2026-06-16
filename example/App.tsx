import { useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useUdpSocket } from '@isvend/expo-udp';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function App() {
  const [latestMessage, setLatestMessage] = useState('No packets yet');
  const { status, error, localAddress, bind, send, close } = useUdpSocket({
    autoBind: false,
    socket: { type: 'udp4', reuseAddress: true },
    bind: { port: 7888, address: '0.0.0.0' },
    onMessage(event) {
      const decoder = new TextDecoder('utf-8');
      const textString = decoder.decode(event.data);
      setLatestMessage(
        `${event.remoteAddress}:${event.remotePort} -> ${textString}`
      );
    },
  });

  const sendLoopback = async () => {
    await send('hello from expo-udp', { host: '127.0.0.1', port: localAddress?.port ?? 7888 });
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.container}>
        <Text style={styles.header}>expo-udp</Text>
        <Group name="Socket">
          <Text>Status: {status}</Text>
          <Text>Local: {localAddress ? formatEndpoint(localAddress.address, localAddress.port) : '-'}</Text>
          <Text>Error: {error?.message ?? '-'}</Text>
          <View style={styles.buttons}>
            <Button title="Bind socket" onPress={() => bind()} disabled={status === 'listening'} />
            <Button title="Close socket" onPress={close} disabled={status === 'closed'} />
            <Button title="Send loopback" onPress={sendLoopback} disabled={!localAddress} />
          </View>
        </Group>
        <Group name="Latest packet">
          <Text>{latestMessage}</Text>
        </Group>
      </ScrollView>
    </SafeAreaView>
  );
}

function formatEndpoint(address: string, port: number) {
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
}

function Group(props: { name: string; children: React.ReactNode }) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupHeader}>{props.name}</Text>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { fontSize: 30, margin: 20 },
  groupHeader: { fontSize: 20, marginBottom: 20 },
  group: { margin: 20, backgroundColor: '#fff', borderRadius: 8, padding: 20, gap: 8 },
  buttons: { gap: 12, marginTop: 12 },
  container: { flex: 1, backgroundColor: '#f2f4f8' },
});
