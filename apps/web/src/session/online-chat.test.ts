import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import { identityFromSecret, scalarToBytes, signObject } from '@cp2p/crypto';
import { createMemnet, MemoryEscrowLifecycleStore } from '@cp2p/protocol/testing';
import type { Transport } from '@cp2p/protocol';
import { afterEach, expect, test } from 'vitest';
import { OnlineChat } from './online-chat.js';
import {
  createOnlineLobbyTransport,
  createOnlineNonChatTransport,
} from './online-lobby-transport.js';

const roomId = 'chatroomaa';
const digest = 'A'.repeat(43);
const frame = new Uint8Array([0x43, 0x50, 0x32, 0x43, 1]);
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function fixture() {
  const first = identityFromSecret(scalarToBytes(17n));
  const second = identityFromSecret(scalarToBytes(18n));
  const third = identityFromSecret(scalarToBytes(19n));
  const identities = [first, second, third] as const;
  const peers = identities.map((identity) => identity.peerId);
  const network = createMemnet({ peers });
  const stores = [
    new MemoryEscrowLifecycleStore(),
    new MemoryEscrowLifecycleStore(),
    new MemoryEscrowLifecycleStore(),
  ] as const;
  let random = 0;
  const make = (
    index: 0 | 1 | 2,
    scope = { kind: 'lobby' as const, roomId },
    store: MemoryEscrowLifecycleStore = stores[index],
    transport: Transport = network.transport(identities[index].peerId),
    allowedSenders: () => readonly string[] = () => peers,
  ) => {
    const identity = identities[index];
    const chat = new OnlineChat({
      transport,
      clock: network.clock,
      store,
      secretKey: identity.secretKey,
      scope,
      allowedSenders,
      randomBytes: (length) => new Uint8Array(length).fill(++random),
    });
    cleanup.push(() => chat.dispose());
    return chat;
  };
  cleanup.push(() => {
    network.dispose();
    first.secretKey.fill(0);
    second.secretKey.fill(0);
    third.secretKey.fill(0);
  });
  const deliver = async (chats: readonly OnlineChat[]) => {
    network.clock.advanceBy(0);
    await Promise.all(chats.map((chat) => chat.flush()));
  };
  const packet = (
    sender: typeof first,
    scope:
      | { kind: 'lobby'; roomId: string }
      | { kind: 'game'; roomId: string; genesisDigest: string },
    eventId = 'A'.repeat(22),
  ) => {
    const body = {
      protocol: 'online-chat-v1',
      scope,
      sender: sender.peerId,
      eventId,
      content: { kind: 'text', text: 'Hello' },
    };
    const payload = canonicalEncode({
      body,
      sig: signObject('online-chat-v1', body, sender.secretKey),
    });
    const bytes = new Uint8Array(frame.length + payload.length);
    bytes.set(frame);
    bytes.set(payload, frame.length);
    return bytes;
  };
  return { first, second, third, peers, network, stores, make, deliver, packet };
}

test('authenticated sender, scope and duplicate identity gate lobby messages across restart', async () => {
  const f = fixture();
  const a = f.make(0);
  let b = f.make(1);
  await Promise.all([a.start(), b.start()]);
  const valid = f.packet(f.first, { kind: 'lobby', roomId });
  const wrongRoom = f.packet(f.first, { kind: 'lobby', roomId: 'otherrooma' }, 'B'.repeat(22));
  const forgedSender = f.packet(f.second, { kind: 'lobby', roomId }, 'C'.repeat(22));
  const senderTransport = f.network.transport(f.first.peerId);
  senderTransport.send(f.second.peerId, wrongRoom);
  senderTransport.send(f.second.peerId, forgedSender);
  senderTransport.send(f.second.peerId, valid);
  senderTransport.send(f.second.peerId, valid);
  await f.deliver([a, b]);
  expect(b.snapshot().events).toHaveLength(1);
  b.dispose();
  b = f.make(1);
  await b.start();
  expect(b.snapshot().events).toHaveLength(1);
  senderTransport.send(f.second.peerId, valid);
  await f.deliver([a, b]);
  expect(b.snapshot().events).toHaveLength(1);
});

test('lobby and ceremony transports ignore every CP2C version without a protocol diagnostic', () => {
  const f = fixture();
  const device = f.network.transport(f.second.peerId);
  const lobby: Uint8Array[] = [];
  const ceremony: Uint8Array[] = [];
  const offLobby = createOnlineLobbyTransport(device).onMessage((_from, bytes) =>
    lobby.push(bytes),
  );
  const offCeremony = createOnlineNonChatTransport(device).onMessage((_from, bytes) =>
    ceremony.push(bytes),
  );
  cleanup.push(offLobby, offCeremony);
  const sender = f.network.transport(f.first.peerId);
  sender.send(f.second.peerId, new Uint8Array([0x43, 0x50, 0x32, 0x43, 2]));
  sender.send(f.second.peerId, new Uint8Array([0x43, 0x50, 0x32, 0x43]));
  f.network.clock.advanceBy(0);
  expect(lobby).toHaveLength(0);
  expect(ceremony).toHaveLength(0);
});

test('rate budgets are per sender and game scope cannot replay lobby packets', async () => {
  const f = fixture();
  const a = f.make(0);
  const b = f.make(1);
  await Promise.all([a.start(), b.start()]);
  for (let index = 0; index < 5; index++) {
    // oxlint-disable-next-line no-await-in-loop -- Each local send consumes one bounded rate slot.
    expect(await a.send({ kind: 'emote', emote: 'wave' })).toMatchObject({ ok: true });
  }
  expect(await a.send({ kind: 'text', text: 'sixth' })).toMatchObject({
    ok: false,
    error: { code: 'chat-rate' },
  });
  await f.deliver([a, b]);
  expect(b.snapshot().events).toHaveLength(5);
  const lobbyPacket = f.packet(f.first, { kind: 'lobby', roomId }, 'D'.repeat(22));
  const gameScope = { kind: 'game' as const, roomId, genesisDigest: digest };
  await Promise.all([a.enterGame(gameScope, () => f.peers), b.enterGame(gameScope, () => f.peers)]);
  expect(b.snapshot().events).toHaveLength(0);
  f.network.transport(f.first.peerId).send(f.second.peerId, lobbyPacket);
  await f.deliver([a, b]);
  expect(b.snapshot().events).toHaveLength(0);
  expect(await a.send({ kind: 'text', text: 'Game only' })).toMatchObject({ ok: true });
  await f.deliver([a, b]);
  expect(b.snapshot().events).toHaveLength(1);
  expect(b.snapshot().events[0]?.packet.body.scope).toEqual(gameScope);
});

test('receiver delay does not reject an honest next-window message', async () => {
  const f = fixture();
  const sender = f.make(0);
  const receiver = f.make(1);
  await Promise.all([sender.start(), receiver.start()]);
  for (let index = 0; index < 5; index++) {
    // oxlint-disable-next-line no-await-in-loop -- Each send consumes one local rate slot.
    expect(await sender.send({ kind: 'emote', emote: 'wave' })).toMatchObject({ ok: true });
  }
  f.network.clock.advanceBy(100);
  await receiver.flush();
  expect(receiver.snapshot().events).toHaveLength(5);
  f.network.clock.advanceBy(9_900);
  expect(await sender.send({ kind: 'text', text: 'Next window' })).toMatchObject({ ok: true });
  await f.deliver([sender, receiver]);
  expect(receiver.snapshot().events).toHaveLength(6);
});

test('text limit counts Unicode graphemes, not UTF-16 code units', async () => {
  const f = fixture();
  const a = f.make(0);
  await a.start();
  expect(await a.send({ kind: 'text', text: '😀'.repeat(300) })).toMatchObject({ ok: true });
  expect(await a.send({ kind: 'text', text: '😀'.repeat(301) })).toMatchObject({
    ok: false,
    error: { code: 'chat-content' },
  });
});

test('local mute persists and suppresses peer chat without changing the sender', async () => {
  const f = fixture();
  const a = f.make(0);
  let b = f.make(1);
  await Promise.all([a.start(), b.start()]);
  expect(await b.setMuted(f.first.peerId, true)).toMatchObject({ ok: true });
  expect(await a.send({ kind: 'text', text: 'Muted' })).toMatchObject({ ok: true });
  await f.deliver([a, b]);
  expect(b.snapshot().events).toHaveLength(0);
  b.dispose();
  b = f.make(1);
  await b.start();
  expect(b.snapshot().muted).toEqual([f.first.peerId]);
  expect(await b.setMuted(f.first.peerId, false)).toMatchObject({ ok: true });
  expect(await a.send({ kind: 'text', text: 'Visible' })).toMatchObject({ ok: true });
  await f.deliver([a, b]);
  expect(b.snapshot().events.map((event) => event.packet.body.content)).toEqual([
    { kind: 'text', text: 'Visible' },
  ]);
  expect(await b.setMuted(f.first.peerId, true)).toMatchObject({ ok: true });
  expect(b.snapshot().events).toHaveLength(0);
  expect(await b.setMuted(f.first.peerId, false)).toMatchObject({ ok: true });
  expect(b.snapshot().events).toHaveLength(1);
});

test('authenticated chat ingress stays bounded while local storage is blocked', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  class BlockingStore extends MemoryEscrowLifecycleStore {
    override async load(key: string): Promise<Uint8Array | null> {
      await blocked;
      return super.load(key);
    }
  }
  const f = fixture();
  const receiver = f.make(1, { kind: 'lobby', roomId }, new BlockingStore());
  const sender = f.network.transport(f.first.peerId);
  const invalid = f.packet(f.first, { kind: 'lobby', roomId: 'otherrooma' });
  const valid = f.packet(f.first, { kind: 'lobby', roomId }, 'Z'.repeat(22));
  for (let index = 0; index < 64; index++) sender.send(f.second.peerId, invalid);
  sender.send(f.second.peerId, valid);
  f.network.clock.advanceBy(0);
  release();
  await receiver.flush();
  expect(receiver.snapshot().events).toHaveLength(0);
  sender.send(f.second.peerId, valid);
  await f.deliver([receiver]);
  expect(receiver.snapshot().events).toHaveLength(1);
});

test('one noisy sender cannot fill the queue ahead of another sender', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  class BlockingStore extends MemoryEscrowLifecycleStore {
    override async load(key: string): Promise<Uint8Array | null> {
      await blocked;
      return super.load(key);
    }
  }
  const f = fixture();
  const receiver = f.make(1, { kind: 'lobby', roomId }, new BlockingStore());
  const noisy = f.network.transport(f.first.peerId);
  const invalid = f.packet(f.first, { kind: 'lobby', roomId: 'otherrooma' });
  for (let index = 0; index < 64; index++) noisy.send(f.second.peerId, invalid);
  const honest = f.packet(f.third, { kind: 'lobby', roomId });
  f.network.transport(f.third.peerId).send(f.second.peerId, honest);
  f.network.clock.advanceBy(0);
  release();
  await receiver.flush();
  expect(receiver.snapshot().events.map((event) => event.packet.body.sender)).toEqual([
    f.third.peerId,
  ]);
});

test('replaying a retained event after muted traffic evicts its memory ID cannot corrupt history', async () => {
  const f = fixture();
  const receiver = f.make(1);
  await receiver.start();
  const sender = f.network.transport(f.first.peerId);
  const first = f.packet(f.first, { kind: 'lobby', roomId });
  sender.send(f.second.peerId, first);
  await f.deliver([receiver]);
  expect(receiver.snapshot().events).toHaveLength(1);
  expect(await receiver.setMuted(f.first.peerId, true)).toMatchObject({ ok: true });
  for (let index = 1; index <= 512; index++) {
    const nonce = new Uint8Array(16);
    nonce[14] = index >> 8;
    nonce[15] = index & 0xff;
    sender.send(f.second.peerId, f.packet(f.first, { kind: 'lobby', roomId }, toBase64Url(nonce)));
    f.network.clock.advanceBy(2_001);
    // oxlint-disable-next-line no-await-in-loop -- Each delivery advances the receiver's bounded rate window.
    await receiver.flush();
  }
  expect(await receiver.setMuted(f.first.peerId, false)).toMatchObject({ ok: true });
  sender.send(f.second.peerId, first);
  await f.deliver([receiver]);
  expect(receiver.snapshot().events).toHaveLength(1);
  receiver.dispose();
  const restored = f.make(1);
  await restored.start();
  expect(restored.snapshot().ready).toBe(true);
  expect(restored.snapshot().events).toHaveLength(1);
});

test('mute updates from separate room instances merge under the shared store lock', async () => {
  const f = fixture();
  const firstRoom = f.make(1);
  const secondRoom = f.make(1);
  await Promise.all([firstRoom.start(), secondRoom.start()]);
  expect(await firstRoom.setMuted(f.first.peerId, true)).toMatchObject({ ok: true });
  expect(await secondRoom.setMuted(f.third.peerId, true)).toMatchObject({ ok: true });
  const restored = f.make(1);
  await restored.start();
  expect(restored.snapshot().muted).toEqual([f.first.peerId, f.third.peerId].toSorted());
  expect(await firstRoom.setMuted(f.first.peerId, false)).toMatchObject({ ok: true });
  const afterRemoval = f.make(1);
  await afterRemoval.start();
  expect(afterRemoval.snapshot().muted).toEqual([f.third.peerId]);
});

test('one failed recipient does not prevent delivery to later peers', async () => {
  const f = fixture();
  const base = f.network.transport(f.first.peerId);
  const failing: Transport = {
    self: base.self,
    peers: () => base.peers(),
    send: (to, bytes) => {
      if (to === f.second.peerId) throw new Error('disconnected');
      base.send(to, bytes);
    },
    broadcast: (bytes) => base.broadcast(bytes),
    disconnect: (peer) => base.disconnect(peer),
    onMessage: (listener) => base.onMessage(listener),
    onPeerChange: (listener) => base.onPeerChange(listener),
  };
  const sender = f.make(0, { kind: 'lobby', roomId }, f.stores[0], failing);
  const missed = f.make(1);
  const reached = f.make(2);
  await Promise.all([sender.start(), missed.start(), reached.start()]);
  expect(await sender.send({ kind: 'text', text: 'Partial delivery' })).toMatchObject({
    ok: false,
    error: { code: 'chat-send' },
  });
  await f.deliver([sender, missed, reached]);
  expect(missed.snapshot().events).toHaveLength(0);
  expect(reached.snapshot().events).toHaveLength(1);
});

test('a peer removed during durable send is not in the later fan-out', async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  class PausingStore extends MemoryEscrowLifecycleStore {
    paused = false;
    override async load(key: string): Promise<Uint8Array | null> {
      if (this.paused && key.endsWith('/history')) {
        entered();
        await blocked;
      }
      return super.load(key);
    }
  }
  const f = fixture();
  const store = new PausingStore();
  let roster = f.peers;
  const sender = f.make(
    0,
    { kind: 'lobby', roomId },
    store,
    f.network.transport(f.first.peerId),
    () => roster,
  );
  const kicked = f.make(1);
  const remaining = f.make(2);
  await Promise.all([sender.start(), kicked.start(), remaining.start()]);
  store.paused = true;
  const sending = sender.send({ kind: 'text', text: 'After removal' });
  await waiting;
  roster = [f.first.peerId, f.third.peerId];
  release();
  expect(await sending).toMatchObject({ ok: true });
  await f.deliver([sender, kicked, remaining]);
  expect(kicked.snapshot().events).toHaveLength(0);
  expect(remaining.snapshot().events).toHaveLength(1);
});

test('incoming storage failure reports chat error without an unhandled rejection', async () => {
  class FailingStore extends MemoryEscrowLifecycleStore {
    broken = false;
    override async load(key: string): Promise<Uint8Array | null> {
      if (this.broken && key.endsWith('/history')) throw new Error('storage interrupted');
      return super.load(key);
    }
  }
  const f = fixture();
  const store = new FailingStore();
  const receiver = f.make(1, { kind: 'lobby', roomId }, store);
  await receiver.start();
  store.broken = true;
  f.network
    .transport(f.first.peerId)
    .send(f.second.peerId, f.packet(f.first, { kind: 'lobby', roomId }));
  await f.deliver([receiver]);
  expect(receiver.snapshot().error).toContain('storage interrupted');
  store.broken = false;
  f.network
    .transport(f.first.peerId)
    .send(f.second.peerId, f.packet(f.first, { kind: 'lobby', roomId }));
  await f.deliver([receiver]);
  expect(receiver.snapshot().error).toBeNull();
  expect(receiver.snapshot().events).toHaveLength(1);
});
