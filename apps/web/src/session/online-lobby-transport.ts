import { canonicalDecode } from '@cp2p/codec';
import { MAX_MESSAGE_BYTES } from '@cp2p/protocol';
import type { Transport } from '@cp2p/protocol';

/** Keep lobby diagnostics separate from the ceremony and gameplay on the same links. */
export function createOnlineLobbyTransport(device: Transport): Transport {
  return {
    self: device.self,
    peers: () => device.peers(),
    send: (to, bytes) => device.send(to, bytes),
    broadcast: (bytes) => device.broadcast(bytes),
    disconnect: (peer) => device.disconnect(peer),
    onPeerChange: (listener) => device.onPeerChange(listener),
    onMessage: (listener) =>
      device.onMessage((from, bytes) => {
        if (bytes[0] === 0x43 && bytes[1] === 0x50 && bytes[2] === 0x32 && bytes[3] === 0x47)
          return;
        if (bytes.byteLength <= MAX_MESSAGE_BYTES) {
          try {
            const value: unknown = canonicalDecode(bytes);
            if (typeof value === 'object' && value !== null && 'body' in value) {
              const body = value.body;
              if (
                typeof body === 'object' &&
                body !== null &&
                'protocol' in body &&
                body.protocol === 'online-ceremony-v1'
              )
                return;
            }
          } catch {
            /* Let the lobby report malformed packets in its own namespace. */
          }
        }
        listener(from, bytes);
      }),
  };
}
