import { expect, test } from 'vitest';
import { createMemnet } from '@cp2p/protocol/testing';
import { observeOutgoingTransport } from './observed-transport.js';

test('keeps class transport subscriptions and delivery while observing only outgoing messages', () => {
  const network = createMemnet({ peers: ['owner', 'peer'], seed: 42 });
  try {
    const sent: number[] = [];
    const received: number[] = [];
    const delivered: number[] = [];
    const owner = observeOutgoingTransport(network.transport('owner'), (bytes) => {
      sent.push(...bytes);
    });
    const peer = network.transport('peer');
    const unsubscribe = owner.onMessage((_from, bytes) => {
      received.push(...bytes);
    });
    peer.onMessage((_from, bytes) => {
      delivered.push(...bytes);
    });
    expect(owner.self).toBe('owner');
    expect(owner.peers()).toContain('peer');
    const stopPeers = owner.onPeerChange(() => undefined);
    owner.send('peer', new Uint8Array([1]));
    owner.broadcast(new Uint8Array([2]));
    peer.send('owner', new Uint8Array([3]));
    while (network.clock.runNext()) {
      /* Deliver the finite packet queue. */
    }
    expect(sent).toEqual([1, 2]);
    expect(delivered).toEqual([1, 2]);
    expect(received).toEqual([3]);
    unsubscribe();
    stopPeers();
    owner.disconnect('peer');
    expect(owner.peers()).not.toContain('peer');
  } finally {
    network.dispose();
  }
});
