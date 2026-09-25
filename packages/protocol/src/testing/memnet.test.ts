import { describe, expect, test } from 'vitest';
import { createMemnet } from './memnet.js';
import { VirtualClock } from './virtual-clock.js';

function encoded(value: number): Uint8Array {
  return Uint8Array.of(value);
}

function numberOf(bytes: Uint8Array): number {
  return bytes[0] ?? -1;
}

function seededTrace(seed: number): readonly number[] {
  const network = createMemnet({
    peers: ['sender', 'receiver'],
    seed,
    defaultLink: {
      latencyMs: 20,
      jitterMs: 10,
      dropProbability: 0.25,
      duplicateProbability: 0.5,
    },
  });
  const received: number[] = [];
  network.transport('receiver').onMessage((_from, message) => received.push(numberOf(message)));
  for (let index = 0; index < 16; index++)
    network.transport('sender').send('receiver', encoded(index));
  network.clock.advanceBy(500);
  network.dispose();
  return received;
}

describe('createMemnet', () => {
  test('delivers per-link jitter in order by default and allows explicit reordering', () => {
    const ordered = createMemnet({
      peers: ['a', 'b'],
      seed: 42,
      defaultLink: { latencyMs: 10, jitterMs: 9 },
    });
    const orderedValues: number[] = [];
    ordered.transport('b').onMessage((_from, message) => orderedValues.push(numberOf(message)));
    const sender = ordered.transport('a');
    sender.send('b', encoded(1));
    sender.send('b', encoded(2));
    sender.send('b', encoded(3));
    ordered.clock.advanceBy(40);
    expect(orderedValues).toEqual([1, 2, 3]);

    let reorderedValues: number[] = [];
    for (let seed = 1; seed <= 20 && reorderedValues.length !== 3; seed++) {
      const reordered = createMemnet({
        peers: ['a', 'b'],
        seed,
        defaultLink: { latencyMs: 10, jitterMs: 9, reorder: true },
      });
      const values: number[] = [];
      reordered.transport('b').onMessage((_from, message) => values.push(numberOf(message)));
      reordered.transport('a').send('b', encoded(1));
      reordered.transport('a').send('b', encoded(2));
      reordered.transport('a').send('b', encoded(3));
      reordered.clock.advanceBy(40);
      if (values.join(',') !== '1,2,3') reorderedValues = values;
      reordered.dispose();
    }
    expect(reorderedValues).toHaveLength(3);
    expect(reorderedValues).not.toEqual([1, 2, 3]);
    ordered.dispose();
  });

  test('seeded loss and duplication traces are reproducible', () => {
    expect(seededTrace(981)).toEqual(seededTrace(981));
    expect(seededTrace(981)).not.toEqual(seededTrace(982));
  });

  test('copies sent and delivered bytes so sender and listeners cannot mutate another copy', () => {
    const network = createMemnet({ peers: ['a', 'b'], defaultLink: { duplicateProbability: 1 } });
    const received: number[] = [];
    network.transport('b').onMessage((_from, message) => {
      message[0] = 99;
    });
    network.transport('b').onMessage((_from, message) => received.push(numberOf(message)));
    const bytes = encoded(7);
    network.transport('a').send('b', bytes);
    bytes[0] = 88;
    network.clock.runUntil(() => received.length === 2);
    expect(received).toEqual([7, 7]);
    network.dispose();
  });

  test('drops configured packets and sends while disconnected', () => {
    const network = createMemnet({
      peers: ['a', 'b'],
      defaultLink: { dropProbability: 1 },
    });
    const received: number[] = [];
    const a = network.transport('a');
    const b = network.transport('b');
    network.transport('b').onMessage((_from, message) => received.push(numberOf(message)));
    network.transport('a').onMessage((_from, message) => received.push(numberOf(message)));
    a.send('b', encoded(1));
    network.clock.advanceBy(1);
    expect(received).toEqual([]);
    network.setLinkOptions('a', 'b', { dropProbability: 0 });
    a.disconnect('b');
    expect(a.peers()).toEqual([]);
    a.send('b', encoded(2));
    network.connect('a', 'b');
    a.send('b', encoded(3));
    network.clock.runUntil(() => received.length === 1);
    b.send('a', encoded(4));
    network.clock.advanceBy(0);
    expect(received).toEqual([3]);
    network.dispose();
  });

  test('partition pauses cross-group traffic, notifies peers, and heal restores the mesh', () => {
    const network = createMemnet({ peers: ['a', 'b', 'c', 'd'] });
    const peerChanges: string[] = [];
    const a = network.transport('a');
    a.onPeerChange((peer, online) => peerChanges.push(`${peer}:${online ? 'up' : 'down'}`));
    network.partition([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(a.peers()).toEqual(['b']);
    expect(peerChanges).toEqual(['c:down', 'd:down']);
    const messages: number[] = [];
    network.transport('c').onMessage((_from, message) => messages.push(numberOf(message)));
    a.send('c', encoded(1));
    a.send('b', encoded(2));
    network.clock.advanceBy(0);
    expect(messages).toEqual([]);
    network.heal();
    expect(a.peers()).toEqual(['b', 'c', 'd']);
    a.send('c', encoded(3));
    network.clock.advanceBy(0);
    expect(messages).toEqual([3]);
    network.dispose();
  });

  test('discards in-flight packets across link reconnects', () => {
    const network = createMemnet({ peers: ['a', 'b'], defaultLink: { latencyMs: 10 } });
    const received: number[] = [];
    const a = network.transport('a');
    network.transport('b').onMessage((_from, message) => received.push(numberOf(message)));
    a.send('b', encoded(1));
    network.clock.advanceBy(5);
    a.disconnect('b');
    network.connect('a', 'b');
    a.send('b', encoded(2));
    network.clock.advanceBy(5);
    expect(received).toEqual([]);
    network.clock.advanceBy(5);
    expect(received).toEqual([2]);
    network.dispose();
  });

  test('crashes and restarts a transport without delivering queued old-generation packets', () => {
    const network = createMemnet({ peers: ['a', 'b'], defaultLink: { latencyMs: 4 } });
    const oldB = network.transport('b');
    const received: number[] = [];
    const peerChanges: string[] = [];
    network
      .transport('a')
      .onPeerChange((peer, online) => peerChanges.push(`${peer}:${online ? 'up' : 'down'}`));
    oldB.onMessage((_from, message) => received.push(numberOf(message)));
    network.transport('a').send('b', encoded(1));
    network.crash('b');
    expect(network.transport('a').peers()).toEqual([]);
    const newB = network.restart('b');
    expect(newB).not.toBe(oldB);
    newB.onMessage((_from, message) => received.push(numberOf(message)));
    expect(oldB.peers()).toEqual([]);
    expect(network.transport('a').peers()).toEqual(['b']);
    expect(peerChanges).toEqual(['b:down', 'b:up']);
    network.clock.advanceBy(4);
    expect(received).toEqual([]);
    network.transport('a').send('b', encoded(2));
    network.clock.advanceBy(4);
    expect(received).toEqual([2]);
    network.dispose();
  });

  test('subscriptions unsubscribe once, and disposal cancels queued delivery', () => {
    const clock = new VirtualClock();
    const network = createMemnet({ peers: ['a', 'b'], clock, defaultLink: { latencyMs: 100 } });
    let messages = 0;
    const unsubscribe = network.transport('b').onMessage(() => messages++);
    unsubscribe();
    unsubscribe();
    network.transport('a').send('b', encoded(1));
    expect(clock.pendingTimerCount()).toBe(1);
    network.dispose();
    network.dispose();
    expect(clock.pendingTimerCount()).toBe(0);
    clock.advanceBy(100);
    expect(messages).toBe(0);
  });

  test('validates peers, link options, and disconnected destinations', () => {
    expect(() => createMemnet({ peers: ['a', 'a'] })).toThrow('duplicate peer');
    expect(() => createMemnet({ peers: ['a'], seed: Number.NaN })).toThrow('seed');
    const network = createMemnet({ peers: ['a', 'b'] });
    expect(() => network.setLinkOptions('a', 'b', { jitterMs: -1 })).toThrow('jitterMs');
    expect(() => network.setLinkOptions('a', 'b', { dropProbability: 1.1 })).toThrow(
      'dropProbability',
    );
    expect(() => network.transport('a').send('unknown', encoded(1))).toThrow('unknown peer');
    network.dispose();
    network.dispose();
    expect(() => network.connect('a', 'b')).toThrow('disposed');
  });
});
