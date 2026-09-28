import type { Transport } from '@cp2p/protocol';

/** Delegate explicitly: spreading a class transport loses its prototype methods. */
export function observeOutgoingTransport(
  transport: Transport,
  observe: (message: Uint8Array) => void,
): Transport {
  return {
    self: transport.self,
    peers: () => transport.peers(),
    send(to, bytes) {
      observe(bytes);
      transport.send(to, bytes);
    },
    broadcast(bytes) {
      observe(bytes);
      transport.broadcast(bytes);
    },
    onMessage: (listener) => transport.onMessage(listener),
    onPeerChange: (listener) => transport.onPeerChange(listener),
    disconnect: (peer) => transport.disconnect(peer),
  };
}
