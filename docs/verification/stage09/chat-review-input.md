# Chat and emote security review

Read-only security and correctness review. Do not use tools or edit files. This is a frozen source/test snapshot, with deterministic test keys only and no runtime credentials or private game records. The user has authorized Claude reviews.

Review Stage 09 §6 signed lobby/game chat and quick emotes. Chat is deliberately outside the certified game log and runs over authenticated device WebRTC links. Focus on bounded ingress and serialized work, 5-per-10-second per-sender rate budgets, signature and scope binding, current signed/certified roster authorization including lobby spectators, duplicate handling across restart, persisted local history and mutes, and async/disposal/lobby-to-game races. Check that CP2C chat packets do not leak into lobby, ceremony or gameplay protocol diagnostics. Inspect UI for stale drafts, rapid duplicate sends, muting and scope consistency.

For each confirmed issue give severity, file:line, an executable sequence, and the smallest safe correction. Distinguish security bugs from a documented bounded-history limitation or missing browser evidence. Do not assume a peer can forge another device's signing key. Do not recommend putting chat in the certified log. If no blocking issue remains, say so plainly.

# Frozen source bundle

## apps/web/src/session/online-chat.ts

```
import { canonicalDecode, canonicalEncode, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import type {
  EscrowCeremonyStore,
  PeerId,
  ProtocolClock,
  Transport,
  Unsubscribe,
} from '@cp2p/protocol';
import * as v from 'valibot';

const CHAT_PROTOCOL = 'online-chat-v1';
const CHAT_DOMAIN = 'online-chat-v1';
const FRAME = new Uint8Array([0x43, 0x50, 0x32, 0x43, 1]); // CP2C, version 1
const MAX_PACKET_BYTES = 4_096;
const MAX_HISTORY = 100;
const MAX_SEEN = 512;
const MAX_QUEUED_FRAMES = 64;
const MAX_QUEUED_BYTES = MAX_QUEUED_FRAMES * MAX_PACKET_BYTES;
const RATE_COUNT = 5;
const RATE_WINDOW_MS = 10_000;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const peerSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
const eventIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/));
const roomSchema = v.pipe(v.string(), v.regex(/^[a-z2-7]{10}$/));
const digestSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
const scopeSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('lobby'), roomId: roomSchema }),
  v.strictObject({ kind: v.literal('game'), roomId: roomSchema, genesisDigest: digestSchema }),
]);
const contentSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('text'),
    text: v.pipe(
      v.string(),
      v.check(
        (text) =>
          text.length <= MAX_PACKET_BYTES &&
          [...graphemes.segment(text)].length <= 300 &&
          text.trim().length > 0,
      ),
    ),
  }),
  v.strictObject({
    kind: v.literal('emote'),
    emote: v.picklist(['wave', 'cheer', 'laugh', 'wow', 'thanks']),
  }),
]);
const packetSchema = v.strictObject({
  body: v.strictObject({
    protocol: v.literal(CHAT_PROTOCOL),
    scope: scopeSchema,
    sender: peerSchema,
    eventId: eventIdSchema,
    content: contentSchema,
  }),
  sig: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{86}$/)),
});
const historySchema = v.strictObject({
  protocol: v.literal('online-chat-history-v1'),
  events: v.pipe(
    v.array(v.strictObject({ packet: packetSchema, receivedAt: v.number() })),
    v.maxLength(MAX_HISTORY),
  ),
});
const mutesSchema = v.strictObject({
  protocol: v.literal('online-chat-mutes-v1'),
  peers: v.pipe(v.array(peerSchema), v.maxLength(128)),
});

export type ChatScope = v.InferOutput<typeof scopeSchema>;
export type ChatContent = v.InferOutput<typeof contentSchema>;
export type SignedChatPacket = v.InferOutput<typeof packetSchema>;
export interface ChatEvent {
  readonly packet: SignedChatPacket;
  /** Local receipt time is for display only; it never authorizes a message. */
  readonly receivedAt: number;
}
export interface ChatSnapshot {
  readonly scope: ChatScope;
  readonly events: readonly ChatEvent[];
  readonly muted: readonly PeerId[];
  readonly error: string | null;
  readonly ready: boolean;
}
export interface OnlineChatOptions {
  readonly transport: Transport;
  readonly clock: ProtocolClock;
  readonly store: EscrowCeremonyStore;
  readonly secretKey: Uint8Array;
  readonly scope: ChatScope;
  /** Current signed lobby roster or the certified frozen human device roster. */
  readonly allowedSenders: () => readonly PeerId[];
  readonly randomBytes?: (length: number) => Uint8Array;
}

export function isChatFrame(bytes: Uint8Array): boolean {
  return hasChatMagic(bytes) && bytes.byteLength >= FRAME.length && bytes[4] === FRAME[4];
}

/** All CP2C versions belong to chat, including versions this client cannot decode. */
export function hasChatMagic(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 && FRAME.subarray(0, 4).every((byte, index) => bytes[index] === byte)
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function scopeKey(scope: ChatScope): string {
  return toHex(hashValue(scope));
}

function eventKey(packet: SignedChatPacket): string {
  return `${packet.body.sender}/${packet.body.eventId}`;
}

function decodePacket(bytes: Uint8Array): SignedChatPacket | null {
  if (!isChatFrame(bytes) || bytes.byteLength > MAX_PACKET_BYTES) return null;
  const payload = bytes.subarray(FRAME.length);
  try {
    const decoded: unknown = canonicalDecode(payload);
    if (!sameBytes(payload, canonicalEncode(decoded))) return null;
    const parsed = v.safeParse(packetSchema, decoded);
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

function framePacket(packet: SignedChatPacket): Uint8Array | null {
  const payload = canonicalEncode(packet);
  if (payload.byteLength + FRAME.length > MAX_PACKET_BYTES) return null;
  const framed = new Uint8Array(FRAME.length + payload.byteLength);
  framed.set(FRAME);
  framed.set(payload, FRAME.length);
  return framed;
}

/** Local, noncertified conversation on authenticated device links. */
export class OnlineChat {
  private readonly listeners = new Set<() => void>();
  private readonly offMessage: Unsubscribe;
  private scope: ChatScope;
  private allowedSenders: () => readonly PeerId[];
  private events: ChatEvent[] = [];
  private readonly muted = new Set<PeerId>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly acceptedAt = new Map<PeerId, number[]>();
  private queue: Promise<void> = Promise.resolve();
  private queuedFrames = 0;
  private queuedBytes = 0;
  private ready = false;
  private disposed = false;
  private error: string | null = null;

  constructor(private readonly options: OnlineChatOptions) {
    this.scope = v.parse(scopeSchema, options.scope);
    this.allowedSenders = options.allowedSenders;
    // Load local history before the first received packet can enter the queue.
    void this.start().catch(() => undefined);
    this.offMessage = options.transport.onMessage((from, bytes) => {
      if (
        !isChatFrame(bytes) ||
        bytes.byteLength > MAX_PACKET_BYTES ||
        this.disposed ||
        !this.allowedSenders().includes(from) ||
        this.queuedFrames >= MAX_QUEUED_FRAMES ||
        this.queuedBytes + bytes.byteLength > MAX_QUEUED_BYTES
      )
        return;
      this.queuedFrames++;
      this.queuedBytes += bytes.byteLength;
      const packet = bytes.slice();
      void this.enqueue(async () => {
        try {
          await this.receive(from, packet);
        } finally {
          this.queuedFrames--;
          this.queuedBytes -= packet.byteLength;
        }
      });
    });
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed || this.ready) return;
      await this.loadMutes();
      if (this.disposed) return;
      await this.loadHistory();
      if (this.disposed) return;
      this.ready = true;
      this.emit();
    });
  }

  enterGame(
    scope: Extract<ChatScope, { kind: 'game' }>,
    allowedSenders: () => readonly PeerId[],
  ): Promise<void> {
    if (this.disposed || scopeKey(scope) === scopeKey(this.scope)) return Promise.resolve();
    this.ready = false;
    this.emit();
    return this.enqueue(async () => {
      if (this.disposed) return;
      this.scope = v.parse(scopeSchema, scope);
      this.allowedSenders = allowedSenders;
      this.events = [];
      this.seen.clear();
      this.seenOrder.length = 0;
      this.acceptedAt.clear();
      this.ready = false;
      await this.loadHistory();
      if (this.disposed) return;
      this.ready = true;
      this.emit();
    });
  }

  snapshot(): ChatSnapshot {
    return {
      scope: { ...this.scope },
      events: this.events
        .filter((event) => !this.muted.has(event.packet.body.sender))
        .map((event) => ({
          packet: structuredClone(event.packet),
          receivedAt: event.receivedAt,
        })),
      muted: [...this.muted].toSorted(),
      error: this.error,
      ready: this.ready,
    };
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(content: ChatContent): Promise<Result<void>> {
    return this.enqueue(async () => {
      if (this.disposed || !this.ready) return failure('chat-unavailable', 'Chat is not ready');
      if (!v.safeParse(contentSchema, content).success)
        return failure('chat-content', 'Chat text or emote is invalid');
      const self = this.options.transport.self;
      const recipients = [...new Set(this.allowedSenders())];
      if (!recipients.includes(self))
        return failure('chat-sender', 'This device is not in the current chat roster');
      if (!this.withinRate(self))
        return failure('chat-rate', 'Chat is limited to five messages per ten seconds');
      const random =
        this.options.randomBytes ??
        ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
      const nonce = random(16);
      if (!(nonce instanceof Uint8Array) || nonce.byteLength !== 16)
        return failure('chat-random', 'Chat event identity is unavailable');
      const body = {
        protocol: CHAT_PROTOCOL,
        scope: this.scope,
        sender: self,
        eventId: toBase64Url(nonce),
        content,
      };
      const packet = v.parse(packetSchema, {
        body,
        sig: signObject(CHAT_DOMAIN, body, this.options.secretKey),
      });
      const bytes = framePacket(packet);
      if (!bytes) return failure('chat-size', 'Chat packet exceeds its size limit');
      if (this.seen.has(eventKey(packet)))
        return failure('chat-duplicate', 'Chat event identity was reused');
      await this.remember(packet);
      if (this.disposed) return failure('chat-unavailable', 'Chat was closed before delivery');
      this.chargeRate(self);
      try {
        for (const peer of recipients) if (peer !== self) this.options.transport.send(peer, bytes);
      } catch {
        return failure('chat-send', 'Chat was saved locally but could not reach every peer');
      }
      return success(undefined);
    });
  }

  setMuted(peer: PeerId, muted: boolean): Promise<Result<void>> {
    return this.enqueue(async () => {
      if (this.disposed || !this.ready) return failure('chat-unavailable', 'Chat is not ready');
      try {
        parsePeerId(peer);
      } catch {
        return failure('chat-peer', 'Mute target is invalid');
      }
      if (peer === this.options.transport.self) return failure('chat-peer', 'Cannot mute yourself');
      const next = new Set(this.muted);
      if (muted) next.add(peer);
      else next.delete(peer);
      if (next.size > 128) return failure('chat-mutes', 'Too many muted players');
      const key = this.mutesKey();
      const bytes = canonicalEncode({
        protocol: 'online-chat-mutes-v1',
        peers: [...next].toSorted(),
      });
      await this.options.store.withCeremonyLock(key, async () => {
        const prior = await this.options.store.load(key);
        const written = prior
          ? await this.options.store.compareAndSwap(key, prior, bytes)
          : await this.options.store.putIfAbsent(key, bytes);
        if (!written) throw new Error('Mute settings changed in another tab');
      });
      this.muted.clear();
      for (const item of next) this.muted.add(item);
      this.emit();
      return success(undefined);
    });
  }

  flush(): Promise<void> {
    return this.queue;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offMessage();
    this.listeners.clear();
    this.events = [];
    this.seen.clear();
    this.seenOrder.length = 0;
    this.acceptedAt.clear();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(
      () => undefined,
      (error: unknown) => {
        this.error = error instanceof Error ? error.message : 'Chat storage failed';
        this.emit();
      },
    );
    return result;
  }

  private async receive(from: PeerId, bytes: Uint8Array): Promise<void> {
    if (this.disposed || !this.ready || !this.allowedSenders().includes(from)) return;
    const packet = decodePacket(bytes);
    if (
      !packet ||
      packet.body.sender !== from ||
      scopeKey(packet.body.scope) !== scopeKey(this.scope)
    )
      return;
    try {
      if (!verifyObject(CHAT_DOMAIN, packet.body, packet.sig, parsePeerId(from))) return;
    } catch {
      return;
    }
    if (this.seen.has(eventKey(packet)) || !this.withinRate(from)) return;
    this.chargeRate(from);
    if (this.muted.has(from)) {
      this.markSeen(packet);
      return;
    }
    await this.remember(packet);
  }

  private withinRate(peer: PeerId): boolean {
    const now = this.options.clock.now();
    const recent = this.acceptedAt.get(peer) ?? [];
    const live = recent.filter((time) => now - time < RATE_WINDOW_MS && now >= time);
    this.acceptedAt.set(peer, live);
    return live.length < RATE_COUNT;
  }

  private chargeRate(peer: PeerId): void {
    const recent = this.acceptedAt.get(peer) ?? [];
    recent.push(this.options.clock.now());
    this.acceptedAt.set(peer, recent);
  }

  private async remember(packet: SignedChatPacket): Promise<void> {
    const event: ChatEvent = { packet, receivedAt: Date.now() };
    const key = this.historyKey();
    await this.options.store.withCeremonyLock(key, async () => {
      const prior = await this.options.store.load(key);
      const previous = prior ? v.parse(historySchema, canonicalDecode(prior)) : { events: [] };
      const events = [...previous.events, event].slice(-MAX_HISTORY);
      const bytes = canonicalEncode({ protocol: 'online-chat-history-v1', events });
      const written = prior
        ? await this.options.store.compareAndSwap(key, prior, bytes)
        : await this.options.store.putIfAbsent(key, bytes);
      if (!written) throw new Error('Chat history changed in another tab');
    });
    if (this.disposed) return;
    this.events = [...this.events, event].slice(-MAX_HISTORY);
    this.markSeen(packet);
    this.emit();
  }

  private markSeen(packet: SignedChatPacket): void {
    const id = eventKey(packet);
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > MAX_SEEN) this.seen.delete(this.seenOrder.shift() ?? '');
  }

  private async loadHistory(): Promise<void> {
    const bytes = await this.options.store.load(this.historyKey());
    const parsed = bytes ? v.parse(historySchema, canonicalDecode(bytes)) : { events: [] };
    if (this.disposed) return;
    this.events = [];
    for (const event of parsed.events) {
      const id = eventKey(event.packet);
      if (
        scopeKey(event.packet.body.scope) !== scopeKey(this.scope) ||
        !Number.isFinite(event.receivedAt) ||
        this.seen.has(id) ||
        !verifyObject(
          CHAT_DOMAIN,
          event.packet.body,
          event.packet.sig,
          parsePeerId(event.packet.body.sender),
        )
      )
        throw new Error('Stored chat history contains an invalid signed event');
      this.events.push(event);
      this.seen.add(id);
      this.seenOrder.push(id);
    }
  }

  private async loadMutes(): Promise<void> {
    const bytes = await this.options.store.load(this.mutesKey());
    if (!bytes) return;
    const parsed = v.parse(mutesSchema, canonicalDecode(bytes));
    if (this.disposed) return;
    this.muted.clear();
    for (const peer of parsed.peers) this.muted.add(peer);
  }

  private historyKey(): string {
    return `online-chat/${this.options.transport.self}/${scopeKey(this.scope)}/history`;
  }

  private mutesKey(): string {
    return `online-chat/${this.options.transport.self}/mutes`;
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A view cannot interrupt a stored chat event. */
      }
    }
  }
}

```

## apps/web/src/session/online-chat.test.ts

```
import { canonicalEncode } from '@cp2p/codec';
import { identityFromSecret, scalarToBytes, signObject } from '@cp2p/crypto';
import { createMemnet, MemoryEscrowLifecycleStore } from '@cp2p/protocol/testing';
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
  const peers = [first.peerId, second.peerId];
  const network = createMemnet({ peers });
  const stores = [new MemoryEscrowLifecycleStore(), new MemoryEscrowLifecycleStore()] as const;
  let random = 0;
  const make = (
    index: 0 | 1,
    scope = { kind: 'lobby' as const, roomId },
    store: MemoryEscrowLifecycleStore = stores[index],
  ) => {
    const identity = index === 0 ? first : second;
    const chat = new OnlineChat({
      transport: network.transport(identity.peerId),
      clock: network.clock,
      store,
      secretKey: identity.secretKey,
      scope,
      allowedSenders: () => peers,
      randomBytes: (length) => new Uint8Array(length).fill(++random),
    });
    cleanup.push(() => chat.dispose());
    return chat;
  };
  cleanup.push(() => {
    network.dispose();
    first.secretKey.fill(0);
    second.secretKey.fill(0);
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
  return { first, second, peers, network, stores, make, deliver, packet };
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

```

## apps/web/src/session/online-lobby-transport.ts

```
import { canonicalDecode } from '@cp2p/codec';
import { MAX_MESSAGE_BYTES } from '@cp2p/protocol';
import type { Transport } from '@cp2p/protocol';
import { hasChatMagic } from './online-chat.js';

/** Ceremony and gameplay share the device link, but chat has its own signed namespace. */
export function createOnlineNonChatTransport(device: Transport): Transport {
  return {
    self: device.self,
    peers: () => device.peers(),
    send: (to, bytes) => device.send(to, bytes),
    broadcast: (bytes) => device.broadcast(bytes),
    disconnect: (peer) => device.disconnect(peer),
    onPeerChange: (listener) => device.onPeerChange(listener),
    onMessage: (listener) =>
      device.onMessage((from, bytes) => {
        if (!hasChatMagic(bytes)) listener(from, bytes);
      }),
  };
}

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
        if (hasChatMagic(bytes)) return;
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

```

## apps/web/src/session/online-room.ts

```
import { hashValue, toHex } from '@cp2p/codec';
import { createBaseEngine } from '@cp2p/engine';
import { failure, success } from '@cp2p/engine';
import type { GameConfig, Result } from '@cp2p/engine';
import {
  answerManualOffer,
  createManualOffer,
  MeshRelaySignalingAdapter,
  readManualLobbyOffer,
  ServerSignalingAdapter,
  WebRtcTransport,
} from '@cp2p/p2p';
import type { ManualBridge, ManualOffer, WebRtcPeerStats } from '@cp2p/p2p';
import type { ServerSignalingOptions, WebRtcTransportOptions } from '@cp2p/p2p';
import { genesisDigest, LobbyController } from '@cp2p/protocol';
import type {
  LobbyDiagnostic,
  LobbyFreezeAgreement,
  LobbyState,
  PeerId,
  ProtocolClock,
  Unsubscribe,
  EscrowCeremonyStore,
} from '@cp2p/protocol';
import { acquireGameWriterLease, IndexedDbByteStore } from '@cp2p/storage';
import type { GameWriterLease } from '@cp2p/storage';
import { loadOnlineIdentity, loadOrCreateOnlineIdentity } from './online-credentials.js';
import type { DisposableOnlineIdentity } from './online-credentials.js';
import { createRoomId, validateOnlineInvite } from './online-invite.js';
import type { OnlineInvite } from './online-invite.js';
import { OnlineStartup } from './online-startup.js';
import type { OnlineStartupSnapshot } from './online-startup.js';
import type { OnlineGame } from './online-game.js';
import {
  createOnlineLobbyTransport,
  createOnlineNonChatTransport,
} from './online-lobby-transport.js';
import { OnlineChat } from './online-chat.js';
import type { ChatContent, ChatSnapshot } from './online-chat.js';
import { loadOnlineGameRecord } from './online-game-records.js';
import type { SavedOnlineGameRecord } from './online-game-records.js';
import { planPregameRoster } from './online-room-roster.js';

export type OpenOnlineRoom =
  | {
      readonly kind: 'host';
      readonly serverUrl: string;
      readonly name: string;
      readonly hostName: string;
      readonly config: GameConfig;
    }
  | { readonly kind: 'join'; readonly invite: OnlineInvite }
  | { readonly kind: 'manual-join'; readonly offerCode: string }
  | { readonly kind: 'resume'; readonly gameId: string };

type SignalingStatus = Parameters<NonNullable<ServerSignalingOptions['onStatus']>>[0];

export interface OnlineRoomSnapshot {
  readonly invite: OnlineInvite;
  readonly self: PeerId;
  readonly signaling: SignalingStatus;
  readonly manual: ManualSnapshot;
  readonly peers: readonly PeerId[];
  readonly lobby: LobbyState | null;
  readonly agreement: LobbyFreezeAgreement | null;
  readonly diagnostic: LobbyDiagnostic | null;
  readonly connectionError: string | null;
  readonly startup: OnlineStartupSnapshot | null;
  readonly chat?: ChatSnapshot;
  readonly closed: boolean;
}

export interface ManualSnapshot {
  readonly phase: 'idle' | 'offering' | 'answering' | 'connected' | 'error';
  readonly code: string | null;
  readonly peer: PeerId | null;
  readonly gatheringComplete: boolean | null;
  readonly error: string | null;
}

const idleManual: ManualSnapshot = {
  phase: 'idle',
  code: null,
  peer: null,
  gatheringComplete: null,
  error: null,
};

export interface OnlineRoomRuntime {
  readonly store?: EscrowCeremonyStore;
  readonly clock?: ProtocolClock;
  readonly socketFactory?: ServerSignalingOptions['socketFactory'];
  readonly rtcFactory?: WebRtcTransportOptions['rtcFactory'];
  readonly manualRtcFactory?: () => RTCPeerConnection;
  readonly iceServers?: readonly RTCIceServer[];
  readonly iceTransportPolicy?: RTCIceTransportPolicy;
  readonly acquireLease?: typeof acquireGameWriterLease;
}

function createBrowserClock(): ProtocolClock {
  const epoch = Date.now();
  const started = performance.now();
  return {
    now: () => epoch + performance.now() - started,
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (handle) => {
      if (typeof handle === 'number') window.clearTimeout(handle);
    },
  };
}

function freezePublic(part: unknown): void {
  if (!part || typeof part !== 'object' || ArrayBuffer.isView(part)) return;
  for (const child of Object.values(part)) freezePublic(child);
  Object.freeze(part);
}

function detachedSnapshot(value: OnlineRoomSnapshot): OnlineRoomSnapshot {
  const detached = structuredClone(value);
  freezePublic(detached);
  return detached;
}

/** Owns the browser resources for one lobby, including its exclusive device lease. */
export class OnlineRoom {
  readonly lobby: LobbyController | null;
  private readonly unsubscribers: Unsubscribe[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly serverCandidates = new Map<PeerId, true>();
  private readonly manualCandidates = new Map<PeerId, ManualBridge>();
  private manualRetryPeer: PeerId | null = null;
  private snapshot: OnlineRoomSnapshot;
  private closing: Promise<void> | null = null;
  private readonly startup: OnlineStartup;
  private readonly chat: OnlineChat;
  private chatSwitching = false;
  private manualOffer: ManualOffer | null = null;
  private manualBridge: ManualBridge | null = null;
  private unsubscribeManualBridgeClose: Unsubscribe | null = null;
  private manualAccepting: {
    readonly code: string;
    readonly promise: Promise<Result<PeerId>>;
  } | null = null;
  private manualGeneration = 0;
  private frozenRoster = false;

  private constructor(
    readonly invite: OnlineInvite,
    private readonly identity: DisposableOnlineIdentity,
    private readonly lease: GameWriterLease,
    private readonly transport: WebRtcTransport,
    private readonly signaling: ServerSignalingAdapter | null,
    private readonly relay: MeshRelaySignalingAdapter,
    controller: LobbyController | null,
    resume: SavedOnlineGameRecord | null,
    private readonly ownedStore: IndexedDbByteStore | null,
    store: EscrowCeremonyStore,
    private readonly clock: ProtocolClock,
    private readonly manualRtcFactory: () => RTCPeerConnection,
  ) {
    this.lobby = controller;
    this.chat = new OnlineChat({
      transport,
      clock,
      store,
      secretKey: identity.secretKey,
      scope: resume
        ? { kind: 'game', roomId: invite.roomId, genesisDigest: resume.genesisDigest }
        : { kind: 'lobby', roomId: invite.roomId },
      allowedSenders: () => {
        const game = this.chat.snapshot().scope.kind === 'game';
        const state = game
          ? (this.startup?.agreement()?.state ?? resume?.agreement.state)
          : this.lobby?.state();
        if (!state) return [];
        return [
          ...state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : [])),
          ...(game ? [] : state.spectators),
        ];
      },
    });
    this.snapshot = detachedSnapshot({
      invite: { ...invite },
      self: identity.peerId,
      signaling: { state: 'connecting' },
      manual: idleManual,
      peers: [],
      lobby: null,
      agreement: null,
      diagnostic: null,
      connectionError: null,
      startup: null,
      chat: this.chat.snapshot(),
      closed: false,
    });
    const common = {
      invite,
      identity,
      transport: createOnlineNonChatTransport(transport),
      store,
      clock,
      engine: createBaseEngine(),
    };
    this.startup = new OnlineStartup(
      resume
        ? { ...common, resume }
        : {
            ...common,
            lobby: requiredLobby(controller),
            freezePeers: (peers) => {
              transport.updatePreGameRoster(peers);
              transport.freezeRoster();
              this.frozenRoster = true;
            },
          },
    );
    this.unsubscribers.push(
      this.startup.subscribe(() => this.refresh()),
      this.chat.subscribe(() => this.refresh()),
      transport.onPeerChange((peer, online) => {
        if (
          online &&
          this.snapshot.manual.peer === peer &&
          this.snapshot.manual.phase === 'answering'
        )
          this.update({ manual: { ...this.snapshot.manual, phase: 'connected', code: null } });
        this.refresh();
      }),
      transport.onDiagnostic((_peer, reason) => this.update({ connectionError: reason })),
    );
    if (controller) {
      this.unsubscribers.push(
        controller.onChange(() => this.refresh()),
        controller.onDiagnostic(() => this.refresh()),
        ...(signaling ? [signaling.onRoomPeers((peers) => this.discover(peers))] : []),
      );
    }
    void this.chat.start().catch(() => this.refresh());
    this.refresh();
  }

  static async open(request: OpenOnlineRoom, runtime: OnlineRoomRuntime = {}): Promise<OnlineRoom> {
    const ownedStore = runtime.store ? null : new IndexedDbByteStore();
    const store = runtime.store ?? ownedStore;
    if (!store) throw new Error('Online storage is unavailable');
    let identity: DisposableOnlineIdentity | null = null;
    let lease: GameWriterLease | null = null;
    let signaling: ServerSignalingAdapter | null = null;
    let relay: MeshRelaySignalingAdapter | null = null;
    let transport: WebRtcTransport | null = null;
    let controller: LobbyController | null = null;
    let room: OnlineRoom | null = null;
    try {
      identity =
        request.kind === 'resume'
          ? await loadOnlineIdentity(store)
          : await loadOrCreateOnlineIdentity(store);
      const resume =
        request.kind === 'resume' ? await loadOnlineGameRecord(store, request.gameId) : null;
      let inviteSource: OnlineInvite;
      if (request.kind === 'resume') {
        if (!resume) throw new Error('Saved online game is missing');
        inviteSource = resume.invite;
      } else if (request.kind === 'join') inviteSource = request.invite;
      else if (request.kind === 'manual-join') {
        const hint = await readManualLobbyOffer(request.offerCode);
        if (hint.to) throw new Error('A reconnect code requires the saved room on this device');
        inviteSource = { roomId: hint.roomId, hostPeer: hint.from, serverUrl: '' };
      } else
        inviteSource = {
          roomId: createRoomId(),
          hostPeer: identity.peerId,
          serverUrl: request.serverUrl,
        };
      const invite = validateOnlineInvite(inviteSource);
      const frozenPeers = resume?.agreement.state.seats.flatMap((seat) =>
        seat.kind === 'human' ? [seat.peer] : [],
      );
      if (resume && !frozenPeers?.includes(identity.peerId))
        throw new Error('This device does not own a human seat in the saved game');
      const scope = `lobby:${invite.roomId}`;
      const leaseId = `lobby-${toHex(hashValue({ server: invite.serverUrl, room: invite.roomId }))}`;
      lease = await (runtime.acquireLease ?? acquireGameWriterLease)(leaseId, identity.peerId);
      if (!lease) throw new Error('This lobby is already open in another tab');
      const clock = runtime.clock ?? createBrowserClock();
      let status: SignalingStatus = { state: 'connecting' };
      signaling = invite.serverUrl
        ? new ServerSignalingAdapter({
            serverUrl: invite.serverUrl,
            roomId: invite.roomId,
            self: identity.peerId,
            secretKey: identity.secretKey,
            clock,
            ...(runtime.socketFactory ? { socketFactory: runtime.socketFactory } : {}),
            onStatus(value) {
              status = value;
              room?.update({ signaling: value });
            },
          })
        : null;
      relay = new MeshRelaySignalingAdapter(identity.peerId, scope, clock, signaling);
      transport = new WebRtcTransport({
        self: identity.peerId,
        secretKey: identity.secretKey,
        roster: frozenPeers ?? [...new Set([identity.peerId, invite.hostPeer])],
        scope,
        clock,
        adapter: relay,
        rtcFactory: runtime.rtcFactory ?? ((_peer, config) => new RTCPeerConnection(config)),
        iceServers: runtime.iceServers ?? [],
        iceTransportPolicy: runtime.iceTransportPolicy ?? 'all',
      });
      relay.attachTransport(transport);
      if (resume) transport.freezeRoster();
      else {
        const common = {
          lobbyId: invite.roomId,
          transport: createOnlineLobbyTransport(transport),
          clock,
          secretKey: identity.secretKey,
        };
        const created =
          request.kind === 'host'
            ? LobbyController.createHost({
                ...common,
                name: request.name,
                hostName: request.hostName,
                config: request.config,
                takeover: { mode: 'vote', afterSeconds: 'never' },
              })
            : LobbyController.join({ ...common, hostPeer: invite.hostPeer });
        if (!created.ok) throw new Error(created.error.message);
        controller = created.value;
      }
      room = new OnlineRoom(
        invite,
        identity,
        lease,
        transport,
        signaling,
        relay,
        controller,
        resume,
        ownedStore,
        store,
        clock,
        runtime.manualRtcFactory ??
          (() =>
            new RTCPeerConnection({
              iceServers: [...(runtime.iceServers ?? [])],
              iceTransportPolicy: runtime.iceTransportPolicy ?? 'all',
            })),
      );
      room.update({ signaling: status });
      if (request.kind === 'manual-join') {
        const answered = await room.answerManualOffer(request.offerCode);
        if (!answered.ok) throw new Error(answered.error.message);
      } else if (signaling || request.kind === 'host') transport.start();
      return room;
    } catch (error) {
      if (room) {
        await room.close();
        throw error;
      }
      try {
        controller?.dispose();
      } finally {
        try {
          if (transport) transport.dispose();
          else if (relay) relay.close();
          else signaling?.close();
        } finally {
          identity?.dispose();
          try {
            await lease?.close();
          } finally {
            await ownedStore?.close();
          }
        }
      }
      throw error;
    }
  }

  getSnapshot = (): OnlineRoomSnapshot => this.snapshot;

  startGame = () => this.startup.begin();

  retryStart = () => this.startup.retryFailed();

  getGame = (): OnlineGame | null => this.startup.game();

  sendChat = (content: ChatContent): Promise<Result<void>> => {
    if (this.startup.game() && this.chat.snapshot().scope.kind !== 'game')
      return Promise.resolve(failure('chat-transition', 'Game chat is still opening'));
    return this.chat.send(content);
  };

  muteChat = (peer: PeerId, muted: boolean): Promise<Result<void>> =>
    this.chat.setMuted(peer, muted);

  getPeerStats = (): Promise<readonly WebRtcPeerStats[]> => this.transport.peerStats();

  /** One signed offer, reusable byte-for-byte until cancelled or answered. */
  async startManualInvitation(
    to?: PeerId,
  ): Promise<Result<{ code: string; gatheringComplete: boolean }>> {
    if (this.manualOffer && this.snapshot.manual.peer === (to ?? null) && this.snapshot.manual.code)
      return success({
        code: this.snapshot.manual.code,
        gatheringComplete: this.manualOffer.gatheringComplete,
      });
    if (
      this.snapshot.closed ||
      this.manualOffer ||
      this.snapshot.manual.phase === 'offering' ||
      this.snapshot.manual.phase === 'answering'
    )
      return failure('manual-busy', 'A manual invitation is already active');
    const state = this.lobby?.state();
    const allowed = to
      ? this.transport.roster().includes(to) && to !== this.identity.peerId
      : !!state &&
        state.status === 'open' &&
        state.hostPeer === this.identity.peerId &&
        !this.startup.agreement();
    if (!allowed) return failure('manual-roster', 'Manual invitation target is not permitted');
    const generation = ++this.manualGeneration;
    this.update({
      manual: {
        phase: 'offering',
        code: null,
        peer: to ?? null,
        gatheringComplete: null,
        error: null,
      },
    });
    try {
      const offer = await createManualOffer({
        self: this.identity.peerId,
        secretKey: this.identity.secretKey,
        scope: `lobby:${this.invite.roomId}`,
        clock: this.clock,
        rtcFactory: this.manualRtcFactory,
        ...(to ? { to } : {}),
      });
      if (this.snapshot.closed || generation !== this.manualGeneration) {
        offer.close();
        return failure('manual-cancelled', 'Manual invitation was cancelled');
      }
      this.manualOffer = offer;
      this.update({
        manual: {
          phase: 'offering',
          code: offer.code,
          peer: to ?? null,
          gatheringComplete: offer.gatheringComplete,
          error: null,
        },
      });
      return success({ code: offer.code, gatheringComplete: offer.gatheringComplete });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Manual invitation failed';
      if (generation === this.manualGeneration)
        this.update({
          manual: {
            phase: 'error',
            code: null,
            peer: to ?? null,
            gatheringComplete: null,
            error: message,
          },
        });
      return failure('manual-offer', message);
    }
  }

  acceptManualAnswer(code: string): Promise<Result<PeerId>> {
    const pending = this.manualAccepting;
    if (pending)
      return pending.code === code
        ? pending.promise
        : Promise.resolve(failure('manual-busy', 'A different manual answer is already active'));
    const attempt = { code, promise: this.acceptManualAnswerOnce(code) };
    this.manualAccepting = attempt;
    void attempt.promise.finally(() => {
      if (this.manualAccepting === attempt) this.manualAccepting = null;
    });
    return attempt.promise;
  }

  private async acceptManualAnswerOnce(code: string): Promise<Result<PeerId>> {
    const offer = this.manualOffer;
    if (!offer || this.snapshot.closed)
      return failure('manual-offer-missing', 'No manual invitation is active');
    const generation = this.manualGeneration;
    let bridge: ManualBridge | null = null;
    let attached = false;
    try {
      bridge = await offer.acceptAnswer(code);
      if (this.snapshot.closed || offer !== this.manualOffer) {
        bridge.close();
        return failure('manual-cancelled', 'Manual invitation was cancelled');
      }
      const peer = bridge.peer;
      if (!this.transport.roster().includes(peer)) {
        const state = this.lobby?.state();
        if (
          !state ||
          state.hostPeer !== this.identity.peerId ||
          state.status !== 'open' ||
          this.startup.agreement()
        ) {
          this.cancelManualInvitation();
          return failure('manual-roster', 'This room cannot admit another device');
        }
        this.relay.addBridge(bridge);
        attached = true;
        try {
          this.manualCandidates.set(peer, bridge);
          this.refresh();
          if (!this.transport.roster().includes(peer))
            throw new Error('This room has no connection slot for another device');
          this.manualRetryPeer = peer;
        } catch (error) {
          this.manualCandidates.delete(peer);
          this.relay.removeBridge(peer);
          throw error;
        }
      } else {
        this.relay.addBridge(bridge);
        attached = true;
        this.manualCandidates.set(peer, bridge);
        this.manualRetryPeer = peer;
      }
      this.manualOffer = null;
      this.update({
        manual: {
          phase: this.transport.peers().includes(peer) ? 'connected' : 'answering',
          code: null,
          peer,
          gatheringComplete: offer.gatheringComplete,
          error: null,
        },
      });
      this.observeManualBridge(bridge, generation);
      this.transport.start();
      this.transport.connect(peer);
      return success(peer);
    } catch (error) {
      if (bridge) {
        if (attached) this.relay.removeBridge(bridge.peer);
        else bridge.close();
      }
      const message = error instanceof Error ? error.message : 'Manual answer failed';
      if (!this.snapshot.closed && generation === this.manualGeneration)
        this.update({ manual: { ...this.snapshot.manual, phase: 'error', error: message } });
      return failure('manual-answer', message);
    }
  }

  async answerManualOffer(
    code: string,
  ): Promise<Result<{ code: string; peer: PeerId; gatheringComplete: boolean }>> {
    if (this.snapshot.closed || this.snapshot.manual.phase === 'answering' || this.manualOffer)
      return failure('manual-busy', 'Manual answer is already active');
    const generation = ++this.manualGeneration;
    let bridge: ManualBridge | null = null;
    let attached = false;
    this.update({
      manual: { phase: 'answering', code: null, peer: null, gatheringComplete: null, error: null },
    });
    try {
      const answer = await answerManualOffer(
        {
          self: this.identity.peerId,
          secretKey: this.identity.secretKey,
          scope: `lobby:${this.invite.roomId}`,
          clock: this.clock,
          rtcFactory: this.manualRtcFactory,
        },
        code,
      );
      bridge = answer.bridge;
      if (
        this.snapshot.closed ||
        generation !== this.manualGeneration ||
        !this.transport.roster().includes(answer.peer)
      ) {
        answer.bridge.close();
        if (!this.snapshot.closed && generation === this.manualGeneration)
          this.update({
            manual: {
              phase: 'error',
              code: null,
              peer: null,
              gatheringComplete: null,
              error: 'Manual offer is outside the room roster',
            },
          });
        return failure('manual-roster', 'Manual offer is outside the room roster');
      }
      this.relay.addBridge(answer.bridge);
      attached = true;
      this.manualCandidates.set(answer.peer, answer.bridge);
      this.update({
        manual: {
          phase: this.transport.peers().includes(answer.peer) ? 'connected' : 'answering',
          code: this.transport.peers().includes(answer.peer) ? null : answer.code,
          peer: answer.peer,
          gatheringComplete: answer.gatheringComplete,
          error: null,
        },
      });
      this.observeManualBridge(answer.bridge, generation);
      this.transport.start();
      this.transport.connect(answer.peer);
      return success({
        code: answer.code,
        peer: answer.peer,
        gatheringComplete: answer.gatheringComplete,
      });
    } catch (error) {
      if (bridge) {
        if (attached) this.relay.removeBridge(bridge.peer);
        else bridge.close();
      }
      const message = error instanceof Error ? error.message : 'Manual offer could not be answered';
      if (generation === this.manualGeneration)
        this.update({
          manual: {
            phase: 'error',
            code: null,
            peer: null,
            gatheringComplete: null,
            error: message,
          },
        });
      return failure('manual-answer', message);
    }
  }

  cancelManualInvitation(): void {
    ++this.manualGeneration;
    this.manualAccepting = null;
    this.manualOffer?.close();
    this.manualOffer = null;
    if (
      this.manualBridge &&
      this.snapshot.manual.phase === 'answering' &&
      !this.transport.peers().includes(this.manualBridge.peer)
    )
      this.relay.removeBridge(this.manualBridge.peer);
    this.unsubscribeManualBridgeClose?.();
    this.unsubscribeManualBridgeClose = null;
    this.manualBridge = null;
    if (!this.snapshot.closed && !this.closing) {
      this.refresh();
      this.update({ manual: idleManual });
    }
  }

  private observeManualBridge(bridge: ManualBridge, generation: number): void {
    this.unsubscribeManualBridgeClose?.();
    this.manualBridge = bridge;
    this.unsubscribeManualBridgeClose = bridge.onClose(() => {
      if (this.manualCandidates.get(bridge.peer) === bridge) {
        this.manualCandidates.delete(bridge.peer);
        this.refresh();
      }
      if (this.manualBridge !== bridge) return;
      this.manualBridge = null;
      this.unsubscribeManualBridgeClose = null;
      const manual = this.snapshot.manual;
      if (
        this.snapshot.closed ||
        generation !== this.manualGeneration ||
        manual.phase !== 'answering' ||
        manual.peer !== bridge.peer ||
        this.transport.peers().includes(bridge.peer)
      )
        return;
      this.update({
        manual: {
          phase: 'error',
          code: null,
          peer: null,
          gatheringComplete: null,
          error: 'Manual bootstrap connection closed before the game connection was ready',
        },
      });
    });
  }

  subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Publish the promise before notifying views, which may call close again.
    this.closing = Promise.resolve().then(() => this.releaseResources());
    this.cancelManualInvitation();
    this.chat.dispose();
    this.update({ closed: true });
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.listeners.clear();
    this.serverCandidates.clear();
    this.manualCandidates.clear();
    this.manualRetryPeer = null;
    return this.closing;
  }

  private async releaseResources(): Promise<void> {
    try {
      try {
        await this.startup.close();
        await this.chat.flush();
      } finally {
        try {
          this.lobby?.dispose();
        } finally {
          try {
            this.transport.dispose();
          } finally {
            this.identity.dispose();
          }
        }
      }
    } finally {
      try {
        await this.lease.close();
      } finally {
        await this.ownedStore?.close();
      }
    }
  }

  private discover(peers: readonly PeerId[] | null): void {
    const state = this.lobby?.state();
    if (
      this.snapshot.closed ||
      this.closing ||
      this.startup.agreement() ||
      (state && state.status !== 'open')
    )
      return;
    const current = new Set(peers ?? []);
    for (const peer of this.serverCandidates.keys())
      if (!current.has(peer)) this.serverCandidates.delete(peer);
    for (const peer of current) this.serverCandidates.set(peer, true);
    this.refresh();
  }

  private refresh(): void {
    if (this.snapshot.closed || this.closing) return;
    const agreement = this.startup.agreement() ?? this.lobby?.freezeAgreement() ?? null;
    const state = this.lobby?.state();
    const game = this.startup.game();
    if (game && !this.chatSwitching && this.chat.snapshot().scope.kind === 'lobby' && agreement) {
      this.chatSwitching = true;
      void this.chat
        .enterGame(
          { kind: 'game', roomId: this.invite.roomId, genesisDigest: genesisDigest(game.genesis) },
          () => agreement.state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : [])),
        )
        .catch(() => undefined)
        .finally(() => {
          this.chatSwitching = false;
          this.refresh();
        });
    }
    if (this.lobby && !this.frozenRoster && !agreement && (!state || state.status === 'open'))
      this.syncPregameRoster(state ?? null);
    this.update({
      peers: this.transport.peers(),
      lobby: agreement?.state ?? state ?? null,
      agreement,
      startup: this.startup.snapshot(),
      chat: this.chat.snapshot(),
      diagnostic: this.lobby?.getDiagnostic() ?? null,
    });
  }

  private syncPregameRoster(state: LobbyState | null): void {
    for (const [peer, bridge] of this.manualCandidates)
      if (bridge.isClosed || !this.relay.hasBridge(peer)) this.manualCandidates.delete(peer);
    const roster = planPregameRoster({
      self: this.identity.peerId,
      host: state?.hostPeer ?? this.invite.hostPeer,
      seated: state?.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : [])) ?? [],
      connected: this.transport.peers(),
      spectators: state?.spectators ?? [],
      transient: [
        ...[...this.manualCandidates.keys()].toReversed(),
        ...[...this.serverCandidates.keys()].toReversed(),
        ...(this.manualRetryPeer ? [this.manualRetryPeer] : []),
      ],
    });
    const current = this.transport.roster();
    if (current.length !== roster.length || roster.some((peer) => !current.includes(peer)))
      this.transport.updatePreGameRoster(roster);
    if (this.manualRetryPeer && !roster.includes(this.manualRetryPeer)) this.manualRetryPeer = null;
    for (const peer of this.manualCandidates.keys()) {
      if (roster.includes(peer)) continue;
      this.manualCandidates.delete(peer);
      this.relay.removeBridge(peer);
    }
  }

  private update(patch: Partial<OnlineRoomSnapshot>): void {
    this.snapshot = detachedSnapshot({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A view cannot interrupt network or lease cleanup. */
      }
    }
  }
}

function requiredLobby(value: LobbyController | null): LobbyController {
  if (!value) throw new Error('Fresh online room has no lobby controller');
  return value;
}

```

## apps/web/src/features/online/ChatPanel.tsx

```
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PeerId } from '@cp2p/protocol';
import type { ChatContent, ChatSnapshot } from '../../session/online-chat.js';
import type { OnlineRoomHandleValue } from './room-registry.js';

const emotes = [
  { name: 'wave', symbol: '👋' },
  { name: 'cheer', symbol: '🎉' },
  { name: 'laugh', symbol: '😄' },
  { name: 'wow', symbol: '😮' },
  { name: 'thanks', symbol: '❤️' },
] as const;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function ChatPanel({
  room,
  chat,
  labels,
  self,
}: {
  room: Pick<OnlineRoomHandleValue, 'sendChat' | 'muteChat'>;
  chat: ChatSnapshot | undefined;
  labels: ReadonlyMap<PeerId, string>;
  self: PeerId;
}) {
  const { t } = useTranslation('lobby');
  const emoteLabels = {
    wave: t('lobby:chatEmote.wave'),
    cheer: t('lobby:chatEmote.cheer'),
    laugh: t('lobby:chatEmote.laugh'),
    wow: t('lobby:chatEmote.wow'),
    thanks: t('lobby:chatEmote.thanks'),
  };
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [muting, setMuting] = useState<PeerId | null>(null);
  const mutingRef = useRef<PeerId | null>(null);
  const [error, setError] = useState(false);
  if (!chat) return null;
  const length = [...segmenter.segment(draft)].length;
  const send = async (content: ChatContent) => {
    if (!room.sendChat || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const sent = await room.sendChat(content);
      setError(!sent.ok);
      if (sent.ok && content.kind === 'text')
        setDraft((current) => (current === content.text ? '' : current));
    } catch {
      setError(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const mute = async (peer: PeerId, muted: boolean) => {
    if (!room.muteChat || mutingRef.current) return;
    mutingRef.current = peer;
    setMuting(peer);
    try {
      const saved = await room.muteChat(peer, muted);
      setError(!saved.ok);
    } catch {
      setError(true);
    } finally {
      mutingRef.current = null;
      setMuting(null);
    }
  };
  return (
    <section className="online-chat" aria-label={t('lobby:chatTitle')}>
      <h2>{t('lobby:chatTitle')}</h2>
      <ol className="online-chat-history" aria-live="polite">
        {chat.events.map(({ packet }) => {
          const { sender, eventId, content } = packet.body;
          return (
            <li key={`${sender}/${eventId}`}>
              <strong>
                {sender === self
                  ? t('lobby:onlineYou')
                  : (labels.get(sender) ?? sender.slice(0, 8))}
              </strong>{' '}
              <span>
                {content.kind === 'text'
                  ? content.text
                  : emotes.find((item) => item.name === content.emote)?.symbol}
              </span>
            </li>
          );
        })}
      </ol>
      {room.muteChat && labels.size > 1 && (
        <div className="online-chat-mutes">
          {Array.from(labels, ([peer, label]) => ({ peer, label }))
            .filter(({ peer }) => peer !== self)
            .map(({ peer, label }) => (
              <button
                className="button button-quiet"
                key={peer}
                type="button"
                disabled={muting !== null}
                onClick={() => void mute(peer, !chat.muted.includes(peer))}
              >
                {chat.muted.includes(peer)
                  ? t('lobby:chatUnmute', { player: label })
                  : t('lobby:chatMutePlayer', { player: label })}
              </button>
            ))}
        </div>
      )}
      <div className="online-chat-emotes" aria-label={t('lobby:chatEmotes')}>
        {emotes.map(({ name, symbol }) => (
          <button
            className="button button-quiet"
            key={name}
            type="button"
            disabled={!chat.ready || busy || !room.sendChat}
            aria-label={emoteLabels[name]}
            onClick={() => void send({ kind: 'emote', emote: name })}
          >
            {symbol}
          </button>
        ))}
      </div>
      <form
        className="online-chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send({ kind: 'text', text: draft });
        }}
      >
        <label htmlFor="online-chat-text">{t('lobby:chatMessage')}</label>
        <input
          id="online-chat-text"
          value={draft}
          maxLength={4096}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('lobby:chatPlaceholder')}
        />
        <small aria-live="polite">{t('lobby:chatLength', { count: length })}</small>
        <button
          className="button button-primary"
          type="submit"
          disabled={!chat.ready || busy || !draft.trim() || length > 300 || !room.sendChat}
        >
          {t('lobby:chatSend')}
        </button>
      </form>
      {length > 300 && <p role="alert">{t('lobby:chatTooLong')}</p>}
      {(error || chat.error) && <p role="alert">{t('lobby:chatFailed')}</p>}
    </section>
  );
}

```

## apps/web/src/features/online/ChatPanel.test.tsx

```
// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { success } from '@cp2p/engine';
import type { PeerId } from '@cp2p/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import type { ChatContent, ChatSnapshot } from '../../session/online-chat.js';
import { ChatPanel } from './ChatPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

const self = 'A'.repeat(43);
const other = 'B'.repeat(43);
const snapshot: ChatSnapshot = {
  scope: { kind: 'lobby', roomId: 'chatroomaa' },
  events: [],
  muted: [],
  error: null,
  ready: true,
};

test('chat sends text and emotes, blocks overlong drafts, and offers local mute', async () => {
  const sendChat = vi.fn<(content: ChatContent) => Promise<ReturnType<typeof success<void>>>>(
    async () => success(undefined),
  );
  const muteChat = vi.fn<
    (peer: PeerId, muted: boolean) => Promise<ReturnType<typeof success<void>>>
  >(async () => success(undefined));
  const page = render(
    <ChatPanel
      room={{ sendChat, muteChat }}
      chat={snapshot}
      labels={
        new Map([
          [self, 'Alice'],
          [other, 'Bob'],
        ])
      }
      self={self}
    />,
  );
  const input = page.getByLabelText('lobby:chatMessage');
  fireEvent.change(input, { target: { value: 'x'.repeat(301) } });
  expect(page.getByRole('button', { name: 'lobby:chatSend' })).toHaveProperty('disabled', true);
  expect(page.getByRole('alert').textContent).toBe('lobby:chatTooLong');
  fireEvent.change(input, { target: { value: 'Hello' } });
  fireEvent.click(page.getByRole('button', { name: 'lobby:chatSend' }));
  await vi.waitFor(() => expect(sendChat).toHaveBeenCalledWith({ kind: 'text', text: 'Hello' }));
  await vi.waitFor(() =>
    expect(page.getByRole('button', { name: 'lobby:chatEmote.wave' })).toHaveProperty(
      'disabled',
      false,
    ),
  );
  fireEvent.click(page.getByRole('button', { name: 'lobby:chatEmote.wave' }));
  await vi.waitFor(() => expect(sendChat).toHaveBeenCalledWith({ kind: 'emote', emote: 'wave' }));
  fireEvent.click(page.getByRole('button', { name: 'lobby:chatMutePlayer' }));
  await vi.waitFor(() => expect(muteChat).toHaveBeenCalledWith(other, true));
});

```

## apps/web/src/features/online/OnlineLobby.tsx

```
import type { Result } from '@cp2p/engine';
import { failure } from '@cp2p/engine';
import type { LobbySeat } from '@cp2p/protocol';
import { LOBBY_COLOURS } from '@cp2p/protocol';
import { Link, useBlocker, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { PlayerMarker } from '../../features/game/PlayerMarker.js';
import { createOnlineInviteUrl } from '../../session/online-invite.js';
import type { OnlineRoomSnapshot } from '../../session/online-room.js';
import { closeOnlineRoom, getOnlineRoom } from './room-registry.js';
import type { OnlineRoomHandleValue } from './room-registry.js';
import { InvitationCode } from './InvitationCode';
import { ManualConnectionPanel } from './ManualConnectionPanel';
import { ConnectionDiagnostics } from './ConnectionDiagnostics';
import { OnlineConfiguration } from './OnlineConfiguration';
import { LobbyNameEditor } from './LobbyNameEditor';
import { ChatPanel } from './ChatPanel';
import './online.css';

const SEAT_SHAPES: readonly ('circle' | 'triangle' | 'square' | 'diamond')[] = [
  'circle',
  'triangle',
  'square',
  'diamond',
];

export type OnlineStartHandler = (room: OnlineRoomHandleValue) => void | Promise<void>;

export function OnlineLobby({
  lobbyId,
  onStart,
}: {
  lobbyId: string;
  onStart?: OnlineStartHandler;
}) {
  const { t } = useTranslation('lobby');
  const navigate = useNavigate();
  const room = getOnlineRoom(lobbyId);
  const snapshot = useSyncExternalStore(
    (listener) => room?.subscribe(listener) ?? (() => undefined),
    () => room?.getSnapshot() ?? null,
    () => null,
  );
  const [actionError, setActionError] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveTarget, setLeaveTarget] = useState<'/' | '/online/create' | '/join'>('/');
  const [leaveError, setLeaveError] = useState(false);
  const [startError, setStartError] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [namePending, setNamePending] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const allowNavigation = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      !!room && !snapshot?.closed && !allowNavigation.current && current.pathname !== next.pathname,
    withResolver: true,
    enableBeforeUnload: () => !!room && !snapshot?.closed,
  });
  useEffect(() => {
    const gameId = snapshot?.startup?.phase === 'playing' ? snapshot.startup.gameId : null;
    if (!gameId) return;
    allowNavigation.current = true;
    void navigate({ to: '/game/$gameId', params: { gameId }, replace: true });
  }, [snapshot?.startup?.phase, snapshot?.startup?.gameId, navigate]);

  const state = snapshot?.lobby;
  const isHost = !!snapshot && !!state && snapshot.self === state.hostPeer;
  const ownSeat = state?.seats.find(
    (seat) => seat.kind === 'human' && seat.peer === snapshot?.self,
  );
  const humanSeats = state?.seats.filter((seat) => seat.kind === 'human') ?? [];
  const peerLabels = new Map(
    (state?.seats ?? []).flatMap((seat) =>
      seat.kind === 'human' ? [[seat.peer, seat.name] as const] : [],
    ),
  );
  for (const peer of state?.spectators ?? [])
    peerLabels.set(peer, t('lobby:chatSpectator', { id: peer.slice(0, 8) }));
  const connectedHumans = humanSeats.filter(
    (seat) =>
      seat.kind === 'human' &&
      (seat.peer === snapshot?.self || snapshot?.peers.includes(seat.peer)),
  ).length;
  const allHumansConnected =
    !!state &&
    state.seats
      .filter((seat) => seat.kind === 'human')
      .every(
        (seat) =>
          seat.kind === 'human' &&
          (seat.peer === snapshot?.self || snapshot?.peers.includes(seat.peer)),
      );
  const canStart =
    isHost &&
    state?.status === 'open' &&
    !!state &&
    state.seats.every((seat) => seat.kind !== 'open') &&
    state.seats.every((seat) => seat.kind !== 'human' || seat.ready) &&
    allHumansConnected &&
    !namePending &&
    !settingsPending;

  const report = (result: Result<void>) => {
    setActionError(!result.ok);
  };

  const leave = async () => {
    if (leaveBusy) return;
    setLeaveBusy(true);
    setLeaveError(false);
    try {
      await closeOnlineRoom(lobbyId);
      allowNavigation.current = true;
      setLeaving(false);
      if (blocker.status === 'blocked') blocker.proceed?.();
      else await navigate({ to: leaveTarget });
    } catch {
      setLeaveError(true);
    } finally {
      setLeaveBusy(false);
    }
  };

  const start = async () => {
    if (!room) return;
    setStartBusy(true);
    setStartError(false);
    try {
      if (onStart) await onStart(room);
      else {
        const result = room.startGame();
        if (!result.ok) throw new Error(result.error.message);
      }
    } catch {
      setStartError(true);
    } finally {
      setStartBusy(false);
    }
  };

  if (!room || !snapshot) {
    return (
      <main className="app-page message-page online-page">
        <h1>{t('lobby:onlineLobbyMissingTitle')}</h1>
        <p>{t('lobby:onlineLobbyMissingBody')}</p>
        <Link to="/join" className="button button-primary">
          {t('lobby:onlineJoinAction')}
        </Link>
      </main>
    );
  }

  return (
    <main className="app-page online-page online-lobby-page">
      <header className="app-header">
        <Link to="/" className="text-link">
          {t('lobby:backHome')}
        </Link>
        <span className="app-brand">{state?.name ?? t('lobby:onlineLobbyTitle')}</span>
        <button
          className="button button-quiet online-leave-button"
          type="button"
          onClick={() => {
            setLeaveTarget('/');
            setLeaving(true);
          }}
        >
          {t('lobby:onlineLeave')}
        </button>
      </header>
      <div className="online-lobby-content">
        <section className="online-lobby-heading">
          <div>
            <p className="online-kicker">{t('lobby:onlineLobbyKicker')}</p>
            <h1>{state?.name ?? t('lobby:onlineConnecting')}</h1>
            <p className="muted">
              {state
                ? t('lobby:onlinePeerCount', {
                    connected: connectedHumans,
                    total: humanSeats.length,
                  })
                : t('lobby:onlineWaitingForHost')}
            </p>
          </div>
          <div className="online-status" role="status">
            <span className={`online-status-dot online-status-${snapshot.signaling.state}`} />
            {snapshot.invite.serverUrl
              ? t(`onlineSignal_${snapshot.signaling.state}`)
              : t('lobby:manualConnectionCodes')}
          </div>
        </section>

        {snapshot.connectionError && (
          <p className="online-notice" role="alert">
            {t('lobby:onlineConnectionNotice')}
          </p>
        )}
        {snapshot.diagnostic && (
          <p className="online-notice" role="alert">
            {snapshot.diagnostic.kind === 'protocol-version'
              ? t('lobby:onlineProtocolMismatch', { version: snapshot.diagnostic.hostVersion })
              : snapshot.diagnostic.kind === 'engine-version'
                ? t('lobby:onlineEngineMismatch', { version: snapshot.diagnostic.hostVersion })
                : t('lobby:onlineInvalidLobbyMessage')}
          </p>
        )}
        {actionError && (
          <p className="online-notice" role="alert">
            {t('lobby:onlineActionFailed')}
          </p>
        )}
        {startError && (
          <p className="online-notice" role="alert">
            {t('lobby:onlineStartFailed')}
          </p>
        )}
        {snapshot.startup && (
          <section className="online-start-progress" role="status" aria-live="polite">
            <StartupProgress phase={snapshot.startup.phase} />
            {snapshot.startup.awaitingSeats.length > 0 && (
              <p className="muted">
                {t('lobby:onlineStartWaiting', {
                  players: snapshot.startup.awaitingSeats
                    .map((seat) =>
                      state?.seats[seat]?.kind !== 'open'
                        ? state?.seats[seat]?.name
                        : String(seat + 1),
                    )
                    .join(', '),
                })}
              </p>
            )}
            {snapshot.startup.phase === 'error' && (
              <button
                className="button button-quiet"
                type="button"
                onClick={() => void room.retryStart().then(report)}
              >
                {t('lobby:onlineRetryStart')}
              </button>
            )}
            {snapshot.startup.phase === 'retired' && (
              <button
                className="button button-primary"
                type="button"
                onClick={() => {
                  setLeaveTarget(isHost ? '/online/create' : '/join');
                  setLeaving(true);
                }}
              >
                {t(isHost ? 'lobby:onlineNewRoom' : 'lobby:onlineJoinNewRoom')}
              </button>
            )}
          </section>
        )}

        {snapshot.invite.serverUrl ? (
          <section className="online-section" aria-labelledby="online-invite-title">
            <div>
              <h2 id="online-invite-title">{t('lobby:onlineInviteTitle')}</h2>
              <p className="muted">{t('lobby:onlineInviteDescription')}</p>
            </div>
            <InvitationCode
              value={createOnlineInviteUrl(window.location.href, snapshot.invite)}
              label={t('lobby:onlineInvitationUrl')}
            />
            {isHost && state?.status === 'open' && (
              <details className="manual-fallback">
                <summary>{t('lobby:manualUseCodes')}</summary>
                <ManualConnectionPanel room={room} snapshot={snapshot} />
              </details>
            )}
          </section>
        ) : (
          <section className="online-section">
            <ManualConnectionPanel room={room} snapshot={snapshot} />
          </section>
        )}
        <ConnectionDiagnostics
          serverUrl={snapshot.invite.serverUrl}
          peerStatsKey={snapshot.invite.roomId}
          {...(room?.getPeerStats ? { loadPeerStats: room.getPeerStats } : {})}
          peerLabels={peerLabels}
        />

        {state && (
          <>
            <section className="online-section" aria-labelledby="online-seats-title">
              <div className="section-heading">
                <h2 id="online-seats-title">{t('lobby:players')}</h2>
                <span className="muted">
                  {t('lobby:onlineSeatCount', { count: state.seats.length })}
                </span>
              </div>
              <div className="online-seat-list">
                {state.seats.map((seat) => (
                  <LobbySeatRow
                    key={seat.seat}
                    room={room}
                    snapshot={snapshot}
                    seat={seat}
                    isHost={isHost}
                    ownSeat={ownSeat?.seat === seat.seat}
                    editable={state.status === 'open' && !snapshot.startup && !startBusy}
                    namePending={namePending}
                    settingsPending={settingsPending}
                    onNamePendingChange={setNamePending}
                    report={report}
                  />
                ))}
              </div>
            </section>

            <OnlineConfiguration
              config={state.config}
              seedMode={state.seedMode}
              editable={isHost && state.status === 'open' && !snapshot.startup && !startBusy}
              onSave={(config, seed) =>
                room.lobby?.configure(config, seed) ?? failure('lobby-closed', 'The room is closed')
              }
              onPendingChange={setSettingsPending}
            />

            <section className="online-start-panel">
              <div>
                <h2>{t('lobby:onlineStartTitle')}</h2>
                <p className="muted">{t('lobby:onlineStartPreparation')}</p>
                {state.takeover.afterSeconds === 'never' && (
                  <p className="muted">{t('lobby:onlineDisconnectPolicy')}</p>
                )}
              </div>
              <button
                className="button button-primary"
                type="button"
                disabled={!canStart || startBusy}
                onClick={() => void start()}
              >
                {t('lobby:onlineStartAction')}
              </button>
            </section>

            <ChatPanel room={room} chat={snapshot.chat} labels={peerLabels} self={snapshot.self} />
          </>
        )}
      </div>

      <LeaveDialog
        open={leaving || blocker.status === 'blocked'}
        busy={leaveBusy}
        error={leaveError}
        onCancel={() => {
          setLeaving(false);
          blocker.reset?.();
        }}
        onConfirm={() => void leave()}
      />
    </main>
  );
}

function StartupProgress({
  phase,
}: {
  phase: NonNullable<OnlineRoomSnapshot['startup']>['phase'];
}) {
  const { t } = useTranslation('lobby');
  const labels = {
    freezing: t('lobby:onlineStartFreezing'),
    frozen: t('lobby:onlineStartPreparing'),
    bindings: t('lobby:onlineStartPreparing'),
    approvals: t('lobby:onlineStartPreparing'),
    escrow: t('lobby:onlineStartPreparing'),
    'beacon-tips': t('lobby:onlineStartPreparing'),
    'seed-commits': t('lobby:onlineStartBoard'),
    'seed-reveals': t('lobby:onlineStartBoard'),
    deck: t('lobby:onlineStartDeck'),
    consent: t('lobby:onlineStartAgreement'),
    waiting: t('lobby:onlineStartWaitingAgreement'),
    ready: t('lobby:onlineStartOpening'),
    opening: t('lobby:onlineStartOpening'),
    playing: t('lobby:onlineStartOpening'),
    retired: t('lobby:onlineStartRetired'),
    halted: t('lobby:onlineGameHalted'),
    error: t('lobby:onlineStartFailed'),
  };
  return <strong>{labels[phase]}</strong>;
}

function LobbySeatRow({
  room,
  snapshot,
  seat,
  isHost,
  ownSeat,
  editable,
  namePending,
  settingsPending,
  onNamePendingChange,
  report,
}: {
  room: OnlineRoomHandleValue;
  snapshot: OnlineRoomSnapshot;
  seat: LobbySeat;
  isHost: boolean;
  ownSeat: boolean;
  editable: boolean;
  namePending: boolean;
  settingsPending: boolean;
  onNamePendingChange: (pending: boolean) => void;
  report: (result: Result<void>) => void;
}) {
  const { t } = useTranslation('lobby');
  const member = seat.kind === 'human' ? seat : null;
  const name = seat.kind === 'open' ? t('lobby:onlineOpenSeat') : seat.name;
  const shape = SEAT_SHAPES[seat.seat] ?? 'circle';
  const lobby = room.lobby;
  if (!lobby) return null;

  const request = (action: Parameters<typeof lobby.request>[0]) => report(lobby.request(action));

  return (
    <article className={`online-seat-row online-seat-${seat.kind}`}>
      <span className={`online-marker color-${seat.colour}`}>
        <PlayerMarker shape={shape} color="blue" />
      </span>
      <div className="online-seat-main">
        <div className="online-seat-title">
          <strong>{name}</strong>
          <span className="online-seat-number">
            {t('lobby:onlineSeatNumber', { number: seat.seat + 1 })}
          </span>
          {seat.kind === 'human' && (
            <span className={seat.ready ? 'online-ready online-is-ready' : 'online-ready'}>
              {seat.ready ? t('lobby:onlineReady') : t('lobby:onlineNotReady')}
            </span>
          )}
        </div>
        {seat.kind === 'bot' && (
          <small className="muted">
            {seat.botHost === snapshot.self
              ? t('lobby:onlineBotHostedHere')
              : t('lobby:onlineBotHostedByPlayer')}
          </small>
        )}
        {ownSeat && member && (
          <div className="online-seat-edit">
            <LobbyNameEditor
              name={member.name}
              editable={editable}
              onSave={(newName) => lobby.request({ kind: 'setName', name: newName })}
              onPendingChange={onNamePendingChange}
            />
            <label>
              {t('lobby:playerColor', { number: seat.seat + 1 })}
              <select
                value={seat.colour}
                onChange={(event) => {
                  const colour = LOBBY_COLOURS.find((item) => item === event.target.value);
                  if (colour) request({ kind: 'setColour', colour });
                }}
              >
                {LOBBY_COLOURS.map((colour) => (
                  <option key={colour} value={colour}>
                    {t(`lobby:${colour}`)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button button-quiet"
              type="button"
              disabled={namePending || (isHost && settingsPending)}
              onClick={() => request({ kind: 'setReady', ready: !seat.ready })}
            >
              {seat.ready ? t('lobby:onlineMarkNotReady') : t('lobby:onlineMarkReady')}
            </button>
            <button
              className="button button-quiet"
              type="button"
              onClick={() => request({ kind: 'leaveSeat' })}
            >
              {t('lobby:onlineLeaveSeat')}
            </button>
          </div>
        )}
      </div>
      <div className="online-seat-actions">
        {seat.kind === 'open' && !ownSeat && (
          <button
            className="button button-quiet"
            type="button"
            onClick={() => request({ kind: 'takeSeat', seat: seat.seat })}
          >
            {t('lobby:onlineTakeSeat')}
          </button>
        )}
        {isHost && (seat.kind === 'open' || seat.kind === 'bot') && (
          <>
            {seat.kind === 'open' && (
              <label className="online-bot-select">
                <span className="sr-only">
                  {t('lobby:onlineAddRandomBot', { number: seat.seat + 1 })}
                </span>
                <select
                  defaultValue=""
                  onChange={(event) => {
                    if (event.target.value === 'easy')
                      report(lobby.setBot(seat.seat, 'easy', snapshot.self));
                    event.currentTarget.value = '';
                  }}
                >
                  <option value="" disabled>
                    {t('lobby:onlineAddRandomBot', { number: seat.seat + 1 })}
                  </option>
                  <option value="easy">{t('lobby:onlineRandomBot')}</option>
                </select>
              </label>
            )}
            {seat.kind === 'bot' && (
              <>
                <label>
                  {t('lobby:onlineBotHost')}
                  <select
                    value={seat.botHost}
                    disabled={snapshot.lobby?.status !== 'open'}
                    onChange={(event) =>
                      report(lobby.setBot(seat.seat, seat.botLevel, event.target.value))
                    }
                  >
                    {snapshot.lobby?.seats.flatMap((player) =>
                      player.kind === 'human'
                        ? [
                            <option key={player.peer} value={player.peer}>
                              {player.name}
                            </option>,
                          ]
                        : [],
                    )}
                  </select>
                </label>
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => report(lobby.openSeat(seat.seat))}
                >
                  {t('lobby:onlineOpenSeatAction')}
                </button>
              </>
            )}
          </>
        )}
        {isHost && member && member.peer !== snapshot.self && (
          <button
            className="button button-quiet"
            type="button"
            onClick={() => report(lobby.kick(member.peer))}
          >
            {t('lobby:onlineKickPlayer')}
          </button>
        )}
      </div>
    </article>
  );
}

function LeaveDialog({
  open,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  error: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('lobby');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) element?.showModal();
    if (!open && element?.open) element.close();
    return () => element?.close();
  }, [open]);
  return (
    <dialog ref={dialog} className="app-dialog" onCancel={onCancel}>
      <h2>{t('lobby:onlineLeaveConfirmTitle')}</h2>
      <p>{t('lobby:onlineLeaveConfirmBody')}</p>
      {error && <p role="alert">{t('lobby:onlineLeaveFailed')}</p>}
      <div className="dialog-actions">
        <button className="button button-quiet" type="button" onClick={onCancel} disabled={busy}>
          {t('lobby:onlineStay')}
        </button>
        <button className="button button-primary" type="button" onClick={onConfirm} disabled={busy}>
          {t('lobby:onlineLeave')}
        </button>
      </div>
    </dialog>
  );
}

```

## apps/web/src/features/online/OnlineGameScreen.tsx

```
import type { Seat } from '@cp2p/engine';
import type { LobbyFreezeAgreement } from '@cp2p/protocol';
import { useBlocker, useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { GameReadOnly } from '../game/GameReadOnly.js';
import type { GamePresentation } from '../../queries/repositories/saved-games.js';
import { attachSession, useSessionStore } from '../../store/session-store.js';
import { beginOnlineRoomOpen, closeOnlineRoom, getOnlineGameRoom } from './room-registry.js';
import type { OnlineRoomHandleValue } from './room-registry.js';
import type { OnlineGame } from '../../session/online-game.js';
import { UnsupportedOnlineGameVersionError } from '../../session/online-game-records.js';
import { ManualConnectionPanel } from './ManualConnectionPanel';
import { ConnectionDiagnostics } from './ConnectionDiagnostics';
import { ChatPanel } from './ChatPanel';
import { useRequestPersistentStorage } from '../../queries/storage-persistence';
import './online.css';

const SHAPES = ['circle', 'triangle', 'square', 'diamond'] as const;

export function OnlineGameScreen({ gameId }: { gameId: string }) {
  const { t } = useTranslation('lobby');
  const navigate = useNavigate();
  const [room, setRoom] = useState(() => getOnlineGameRoom(gameId));
  const [openError, setOpenError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const lifetime = useRef(0);
  const snapshot = useSyncExternalStore(
    (listener) => room?.subscribe(listener) ?? (() => undefined),
    () => room?.getSnapshot() ?? null,
    () => null,
  );
  useEffect(() => {
    const generation = ++lifetime.current;
    let live = true;
    setOpenError(null);
    const handle = beginOnlineRoomOpen(`resume:${gameId}`, { kind: 'resume', gameId });
    void handle.promise.then(
      (opened) => {
        if (!live) return undefined;
        setRoom(opened);
        return undefined;
      },
      (error: unknown) => {
        if (live) setOpenError(error instanceof Error ? error : new Error('Could not open game'));
      },
    );
    return () => {
      live = false;
      handle.cancel();
      // A kept lobby may hand its room to this route. The route owns it until
      // unmount, while the deferred check preserves React's StrictMode remount.
      queueMicrotask(() => {
        // oxlint-disable-next-line react-hooks/exhaustive-deps -- This generation counter deliberately detects a newer effect, rather than capturing a DOM ref.
        if (lifetime.current !== generation) return;
        const opened = getOnlineGameRoom(gameId);
        if (opened) void closeOnlineRoom(opened.invite.roomId).catch(() => undefined);
      });
    };
  }, [gameId, attempt]);
  const game = room?.getGame();
  const agreement = snapshot?.agreement;
  const halted = snapshot?.startup?.phase === 'halted';
  const failed = openError !== null || snapshot?.startup?.phase === 'error';
  const unsupportedVersion = openError instanceof UnsupportedOnlineGameVersionError;
  const exitLoading = async (retry: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (room) await closeOnlineRoom(room.invite.roomId);
      setRoom(null);
      if (retry) setAttempt((value) => value + 1);
      else await navigate({ to: '/' });
    } catch (error) {
      setOpenError(error instanceof Error ? error : new Error('Could not close game'));
    } finally {
      setBusy(false);
    }
  };
  if (!room || !game || !agreement)
    return (
      <main className="app-page message-page">
        <h1>{t('lobby:onlineResumeTitle')}</h1>
        {halted ? (
          <p role="alert">{t('lobby:onlineGameHalted')}</p>
        ) : failed ? (
          <p role="alert">
            {unsupportedVersion
              ? t('lobby:onlineResumeUnsupportedVersion', { version: openError.savedVersion })
              : t('lobby:onlineResumeFailed')}
          </p>
        ) : (
          <p role="status">{t('lobby:onlineResumeProgress')}</p>
        )}
        {room && snapshot && !halted && (
          <ManualConnectionPanel room={room} snapshot={snapshot} reconnect />
        )}
        <div className="dialog-actions">
          {failed && !halted && !unsupportedVersion && (
            <button
              className="button button-primary"
              type="button"
              disabled={busy}
              onClick={() => void exitLoading(true)}
            >
              {t('lobby:onlineResumeRetry')}
            </button>
          )}
          <button
            className="button button-quiet"
            type="button"
            disabled={busy}
            onClick={() => void exitLoading(false)}
          >
            {t('lobby:backHome')}
          </button>
        </div>
      </main>
    );
  return <OnlineGameInstance room={room} game={game} agreement={agreement} />;
}

function OnlineGameInstance({
  room,
  game,
  agreement,
}: {
  room: OnlineRoomHandleValue;
  game: OnlineGame;
  agreement: LobbyFreezeAgreement;
}) {
  const { t } = useTranslation(['game', 'lobby']);
  const navigate = useNavigate();
  const snapshot = useSyncExternalStore(room.subscribe, room.getSnapshot, room.getSnapshot);
  const audit = useSessionStore((store) => store.audit);
  const status = useSessionStore((store) => store.status);
  const { mutate: requestPersistentStorage } = useRequestPersistentStorage();
  const [attached, setAttached] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const connectionDialog = useRef<HTMLDialogElement>(null);
  const chatDialog = useRef<HTMLDialogElement>(null);
  const allowNavigation = useRef(false);
  const leaveDialog = useRef<HTMLDialogElement>(null);
  const haltedDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = connectionDialog.current;
    if (connectionOpen && !element?.open) element?.showModal();
    if (!connectionOpen && element?.open) element.close();
    return () => {
      if (element?.open) element.close();
    };
  }, [connectionOpen]);
  useEffect(() => {
    const element = chatDialog.current;
    if (chatOpen && !element?.open) element?.showModal();
    if (!chatOpen && element?.open) element.close();
    return () => {
      if (element?.open) element.close();
    };
  }, [chatOpen]);
  const halted = snapshot.startup?.phase === 'halted';
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      !allowNavigation.current && !snapshot.closed && current.pathname !== next.pathname,
    withResolver: true,
    enableBeforeUnload: () => !snapshot.closed,
  });
  useEffect(() => {
    const detach = attachSession(game.gameId, game.session);
    setAttached(true);
    return detach;
  }, [game]);
  useEffect(() => {
    requestPersistentStorage();
  }, [requestPersistentStorage]);
  useEffect(() => {
    const element = haltedDialog.current;
    if (halted && !element?.open) element?.showModal();
    return () => {
      if (element?.open) element.close();
    };
  }, [halted]);
  useEffect(() => {
    const element = leaveDialog.current;
    if ((leaving || blocker.status === 'blocked') && !element?.open) element?.showModal();
    if (!leaving && blocker.status !== 'blocked' && element?.open) element.close();
    return () => {
      if (element?.open) element.close();
    };
  }, [leaving, blocker.status]);

  const presentation = useMemo<GamePresentation>(
    () => ({
      players: agreement.state.seats.map((seat) => {
        if (
          seat.kind === 'open' ||
          (seat.seat !== 0 && seat.seat !== 1 && seat.seat !== 2 && seat.seat !== 3)
        )
          throw new Error('Online presentation has an unfilled or unsupported seat');
        const index = seat.seat;
        return { seat: index, name: seat.name, color: seat.colour, shape: SHAPES[index] };
      }),
      botDelayMs: 800,
    }),
    [agreement],
  );
  const peerLabels = new Map(
    agreement.state.seats.flatMap((seat) =>
      seat.kind === 'human' ? [[seat.peer, seat.name] as const] : [],
    ),
  );
  const connections: Partial<Record<Seat, string>> = {};
  const missing = agreement.state.seats.filter(
    (seat) =>
      seat.kind === 'human' && seat.peer !== snapshot.self && !snapshot.peers.includes(seat.peer),
  );
  for (const seat of agreement.state.seats) {
    if (seat.kind === 'human')
      connections[seat.seat] =
        seat.peer === snapshot.self
          ? t('lobby:onlineYou')
          : snapshot.peers.includes(seat.peer)
            ? t('lobby:onlineConnected')
            : t('lobby:onlineReconnecting');
    else if (seat.kind === 'bot') connections[seat.seat] = t('lobby:onlineRandomBot');
  }
  const exported = useMutation({
    mutationFn: async () => {
      const blob = new Blob(
        [
          JSON.stringify(
            {
              format: 'hexfield-certified-history-v1',
              history: game.session.exportSave(),
              presentation,
              audit: game.session.getAudit(),
            },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      );
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = `${game.gameId}.peer-history.json`;
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    },
  });
  const leave = async () => {
    if (busy) return;
    setBusy(true);
    setLeaveError(false);
    try {
      await closeOnlineRoom(room.invite.roomId);
      allowNavigation.current = true;
      setLeaving(false);
      if (blocker.status === 'blocked') blocker.proceed?.();
      else await navigate({ to: '/' });
    } catch {
      setLeaveError(true);
    } finally {
      setBusy(false);
    }
  };
  const auditText =
    audit?.kind === 'complete'
      ? audit.report.ok
        ? t('lobby:onlineAuditPassed')
        : t('lobby:onlineAuditFailed')
      : audit?.kind === 'awaiting-reveals'
        ? t('lobby:onlineAuditWaiting')
        : audit?.kind === 'verifying'
          ? t('lobby:onlineAuditVerifying')
          : audit?.kind === 'error' || audit?.kind === 'unavailable'
            ? t('lobby:onlineAuditUnavailable')
            : t('lobby:onlineAuditPending');
  const resultNotice = (
    <div role="status" className="online-audit-status">
      <strong>{auditText}</strong>
      {audit?.kind === 'error' && (
        <button
          className="button button-quiet"
          type="button"
          onClick={() => game.session.retryAudit()}
        >
          {t('lobby:onlineRetryAudit')}
        </button>
      )}
    </div>
  );
  return (
    <main className="app-page online-game-page">
      {attached ? (
        <GameReadOnly
          presentation={presentation}
          gameTitle={t('lobby:onlineGameTitle')}
          connectionLabels={connections}
          saveStatus={status?.kind === 'error' ? 'error' : 'saved'}
          onLeave={() => setLeaving(true)}
          onExportReplay={() => exported.mutateAsync()}
          resultNotice={resultNotice}
          menuActions={
            <>
              <button
                className="button button-quiet"
                type="button"
                onClick={() => setChatOpen(true)}
              >
                {t('lobby:chatTitle')}
              </button>
              <button
                className="button button-quiet"
                type="button"
                onClick={() => setConnectionOpen(true)}
              >
                {t('lobby:connectionDiagnosticsTitle')}
              </button>
            </>
          }
          sessionNotice={
            missing.length > 0 ? (
              <p className="online-game-notice" role="status">
                {t('lobby:onlineGameWaitingPeers', {
                  players: missing
                    .map((seat) => (seat.kind === 'human' ? seat.name : ''))
                    .join(', '),
                })}
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => setConnectionOpen(true)}
                >
                  {t('lobby:manualReconnectTitle')}
                </button>
              </p>
            ) : null
          }
        />
      ) : (
        <p role="status">{t('game:loadingGame')}</p>
      )}
      <dialog
        ref={connectionDialog}
        className="app-dialog connection-dialog"
        aria-labelledby="online-connection-title"
        onCancel={() => setConnectionOpen(false)}
      >
        <div className="section-heading">
          <h2 id="online-connection-title">{t('lobby:connectionDiagnosticsTitle')}</h2>
          <button
            className="button button-quiet"
            type="button"
            onClick={() => setConnectionOpen(false)}
          >
            {t('lobby:manualClose')}
          </button>
        </div>
        {connectionOpen && (
          <>
            <ConnectionDiagnostics
              serverUrl={snapshot.invite.serverUrl}
              peerStatsKey={game.gameId}
              {...(room.getPeerStats ? { loadPeerStats: room.getPeerStats } : {})}
              peerLabels={peerLabels}
            />
            <ManualConnectionPanel room={room} snapshot={snapshot} reconnect />
          </>
        )}
      </dialog>
      <dialog
        ref={chatDialog}
        className="app-dialog online-chat-dialog"
        aria-label={t('lobby:chatTitle')}
        onCancel={() => setChatOpen(false)}
      >
        <button className="button button-quiet" type="button" onClick={() => setChatOpen(false)}>
          {t('lobby:manualClose')}
        </button>
        <ChatPanel room={room} chat={snapshot.chat} labels={peerLabels} self={snapshot.self} />
      </dialog>
      <dialog
        ref={haltedDialog}
        className="app-dialog"
        aria-labelledby="online-game-halted-title"
        onCancel={(event) => event.preventDefault()}
      >
        <h2 id="online-game-halted-title">{t('lobby:onlineGameHalted')}</h2>
        <p>{t('lobby:onlineGameHaltedBody')}</p>
        {leaveError && <p role="alert">{t('lobby:onlineLeaveFailed')}</p>}
        <div className="dialog-actions">
          <button
            className="button button-quiet"
            type="button"
            disabled={exported.isPending}
            onClick={() => exported.mutate()}
          >
            {t('game:exportReplay')}
          </button>
          <button
            className="button button-primary"
            type="button"
            disabled={busy}
            onClick={() => void leave()}
          >
            {t('game:leave')}
          </button>
        </div>
      </dialog>
      <dialog
        ref={leaveDialog}
        className="app-dialog"
        onCancel={() => {
          setLeaving(false);
          blocker.reset?.();
        }}
      >
        <h2>{t('game:leaveConfirmTitle')}</h2>
        <p>{t('lobby:onlineGameLeaveBody')}</p>
        {leaveError && <p role="alert">{t('lobby:onlineLeaveFailed')}</p>}
        <div className="dialog-actions">
          <button
            className="button button-quiet"
            type="button"
            disabled={busy}
            onClick={() => {
              setLeaving(false);
              blocker.reset?.();
            }}
          >
            {t('game:stay')}
          </button>
          <button
            className="button button-primary"
            type="button"
            disabled={busy}
            onClick={() => void leave()}
          >
            {t('game:leave')}
          </button>
        </div>
      </dialog>
    </main>
  );
}

```

## apps/web/src/features/online/room-registry.ts

```
import { OnlineRoom } from '../../session/online-room.js';
import { OnlineIce } from '../../session/online-ice.js';
import { loadOnlineConnectionSettings } from '../../queries/network.js';
import type { OpenOnlineRoom } from '../../session/online-room.js';
import type { OnlineRoomSnapshot } from '../../session/online-room.js';
import type { OnlineInvite } from '../../session/online-invite.js';
import type { LobbyController } from '@cp2p/protocol';
import type { Unsubscribe } from '@cp2p/protocol';
import type { OnlineGame } from '../../session/online-game.js';
import type { WebRtcPeerStats } from '@cp2p/p2p';
import type { Result } from '@cp2p/engine';
import type { PeerId } from '@cp2p/protocol';
import type { ChatContent } from '../../session/online-chat.js';

type OnlineLobbyController = Pick<
  LobbyController,
  'request' | 'configure' | 'setBot' | 'openSeat' | 'kick' | 'start'
>;

export interface OnlineRoomHandleValue {
  readonly invite: OnlineInvite;
  readonly lobby: OnlineLobbyController | null;
  startManualInvitation?: OnlineRoom['startManualInvitation'];
  acceptManualAnswer?: OnlineRoom['acceptManualAnswer'];
  answerManualOffer?: OnlineRoom['answerManualOffer'];
  cancelManualInvitation?: OnlineRoom['cancelManualInvitation'];
  startGame: () => Result<void>;
  retryStart: () => Promise<Result<void>>;
  getGame: () => OnlineGame | null;
  getPeerStats?: () => Promise<readonly WebRtcPeerStats[]>;
  sendChat?: (content: ChatContent) => Promise<Result<void>>;
  muteChat?: (peer: PeerId, muted: boolean) => Promise<Result<void>>;
  getSnapshot: () => OnlineRoomSnapshot;
  subscribe: (listener: () => void) => Unsubscribe;
  close: () => Promise<void>;
}

type OnlineRoomOpener = (request: OpenOnlineRoom) => Promise<OnlineRoomHandleValue>;

interface PendingRoomOpen {
  readonly request: OpenOnlineRoom;
  references: number;
  kept: boolean;
  ownsRoom: boolean;
  room: OnlineRoomHandleValue | null;
  invite: OnlineInvite | null;
  promise: Promise<OnlineRoomHandleValue>;
}

export interface RoomOpenHandle {
  readonly promise: Promise<OnlineRoomHandleValue>;
  /** Keep an opened room alive after the caller navigates away. */
  keep(): void;
  /** Cancel this caller's interest; an unclaimed room is closed when no callers remain. */
  cancel(): void;
}

const rooms = new Map<string, OnlineRoomHandleValue>();
const openings = new Map<string, PendingRoomOpen>();

function sameInvite(left: OnlineInvite, right: OnlineInvite): boolean {
  return (
    left.roomId === right.roomId &&
    left.hostPeer === right.hostPeer &&
    left.serverUrl === right.serverUrl
  );
}

function rejectedOpen(error: Error): RoomOpenHandle {
  const fail = async () => {
    throw error;
  };
  return { promise: fail(), keep() {}, cancel() {} };
}

function aborted(): Error {
  return new DOMException('Online room opening was cancelled', 'AbortError');
}

export function getOnlineRoom(lobbyId: string): OnlineRoomHandleValue | null {
  const room = rooms.get(lobbyId);
  if (!room) return null;
  if (room.getSnapshot().closed) {
    if (rooms.get(lobbyId) === room) rooms.delete(lobbyId);
    return null;
  }
  return room;
}

export function getOnlineGameRoom(gameId: string): OnlineRoomHandleValue | null {
  return (
    [...rooms.values()].find(
      (room) =>
        !room.getSnapshot().closed &&
        (room.getGame()?.gameId === gameId || room.getSnapshot().startup?.gameId === gameId),
    ) ?? null
  );
}

export function beginOnlineRoomOpen(
  key: string,
  request: OpenOnlineRoom,
  openRoom: OnlineRoomOpener = openConfiguredRoom,
): RoomOpenHandle {
  if (request.kind === 'resume') {
    const existing = getOnlineGameRoom(request.gameId);
    if (existing) return { promise: Promise.resolve(existing), keep() {}, cancel() {} };
  }
  if (request.kind === 'join') {
    const existing = getOnlineRoom(request.invite.roomId);
    if (existing) {
      if (!sameInvite(existing.invite, request.invite))
        return rejectedOpen(
          new Error('Invitation conflicts with the room already open in this tab'),
        );
      return { promise: Promise.resolve(existing), keep() {}, cancel() {} };
    }
  }

  let opening = openings.get(key);
  if (
    opening &&
    (opening.request.kind !== request.kind ||
      (opening.request.kind === 'resume' &&
        request.kind === 'resume' &&
        opening.request.gameId !== request.gameId) ||
      (opening.request.kind === 'manual-join' &&
        request.kind === 'manual-join' &&
        opening.request.offerCode !== request.offerCode))
  )
    return rejectedOpen(new Error('A different room request already uses this opening key'));
  if (opening?.invite && request.kind === 'join' && !sameInvite(opening.invite, request.invite))
    return rejectedOpen(new Error('Invitation conflicts with a room opening already in progress'));
  if (!opening) {
    const opened = openRoom(request);
    const state: PendingRoomOpen = {
      request,
      references: 0,
      kept: false,
      ownsRoom: false,
      room: null,
      invite: request.kind === 'join' ? request.invite : null,
      promise: opened.then(async (room) => {
        state.room = room;
        state.ownsRoom = true;
        if (state.references === 0 && !state.kept) {
          await room.close();
          throw aborted();
        }
        const existing = getOnlineRoom(room.invite.roomId);
        if (
          request.kind === 'resume' &&
          existing &&
          existing !== getOnlineGameRoom(request.gameId)
        ) {
          await room.close();
          throw new Error('A different game or lobby is already open in this room');
        }
        if (existing && !sameInvite(existing.invite, room.invite)) {
          await room.close();
          throw new Error('A different pinned invitation already owns this room code');
        }
        if (existing) {
          await room.close();
          state.room = existing;
          state.ownsRoom = false;
          state.kept = true;
          return existing;
        }
        rooms.set(room.invite.roomId, room);
        return room;
      }),
    };
    void state.promise
      .finally(() => {
        if (openings.get(key) === state) openings.delete(key);
      })
      .catch(() => undefined);
    opening = state;
    openings.set(key, opening);
  }
  const pending = opening;
  pending.references += 1;
  let cancelled = false;

  return {
    promise: pending.promise.then((room) => {
      if (cancelled) throw aborted();
      return room;
    }),
    keep() {
      if (!cancelled) pending.kept = true;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      pending.references = Math.max(0, pending.references - 1);
      const room = pending.room;
      if (pending.references !== 0 || pending.kept || !pending.ownsRoom || !room) return;
      if (rooms.get(room.invite.roomId) === room) rooms.delete(room.invite.roomId);
      void room.close().catch(() => undefined);
    },
  };
}

async function openConfiguredRoom(request: OpenOnlineRoom): Promise<OnlineRoom> {
  const settings = await loadOnlineConnectionSettings();
  const ice = new OnlineIce(settings, loadOnlineConnectionSettings);
  try {
    const room = await OnlineRoom.open(request, {
      ...settings,
      rtcFactory: (_peer, configuration) => ice.createConnection(configuration),
      manualRtcFactory: () => ice.createConnection(),
    });
    const unsubscribe = room.subscribe(() => {
      if (!room.getSnapshot().closed) return;
      ice.dispose();
      unsubscribe();
    });
    return room;
  } catch (error) {
    ice.dispose();
    throw error;
  }
}

export async function closeOnlineRoom(lobbyId: string): Promise<void> {
  const room = rooms.get(lobbyId);
  if (!room) return;
  rooms.delete(lobbyId);
  await room.close();
}

```

## apps/web/src/features/online/online.css

```
.online-page {
  --online-yellow: #e6ad26;
  --online-red: #cf4a44;
}

.online-form {
  max-width: 760px;
}

.online-form textarea {
  width: 100%;
  min-height: 6rem;
  resize: vertical;
  padding: 10px 12px;
  border: 1px solid var(--control);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
}

.online-secondary-link {
  margin-top: 24px;
  color: var(--muted);
}

.online-secondary-link a {
  color: var(--accent);
  font-weight: 650;
}

.online-lobby-page .app-header {
  gap: 20px;
}

.online-lobby-content {
  width: min(100% - 32px, 980px);
  margin: 0 auto;
  padding: 42px 0 72px;
  display: grid;
  gap: 24px;
}

.online-lobby-heading,
.online-invite-panel,
.online-start-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

.online-kicker {
  margin-bottom: 8px;
  color: var(--accent);
  font-size: 0.75rem;
  font-weight: 750;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.online-lobby-heading .muted,
.online-invite-panel .muted {
  margin-top: 8px;
}

.online-status {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  white-space: nowrap;
}

.online-status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--control);
}

.online-status-ready {
  background: #36a278;
}

.online-status-retrying {
  background: #e6ad26;
}

.online-status-closed {
  background: var(--error);
}

.online-invite-panel,
.online-start-panel,
.online-section {
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
}

.online-section {
  display: grid;
  gap: 16px;
}

.online-invite-panel small {
  flex-basis: 100%;
  color: var(--error);
}

.online-seat-list {
  display: grid;
  gap: 10px;
}

.online-seat-row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--page);
}

.online-marker {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  color: var(--online-seat-color, #0072b2);
}

.online-marker .player-marker {
  --player-color: var(--online-seat-color);
}

.online-marker.color-blue {
  --online-seat-color: #0072b2;
}

.online-marker.color-orange {
  --online-seat-color: #d55e00;
}

.online-marker.color-green {
  --online-seat-color: #009e73;
}

.online-marker.color-magenta {
  --online-seat-color: #b35b93;
}

.online-marker.color-yellow {
  --online-seat-color: var(--online-yellow);
}

.online-marker.color-red {
  --online-seat-color: var(--online-red);
}

.online-seat-main {
  min-width: 0;
  display: grid;
  gap: 8px;
}

.online-seat-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.online-seat-number,
.online-ready {
  color: var(--muted);
  font-size: 0.82rem;
}

.online-is-ready {
  color: var(--accent);
  font-weight: 680;
}

.online-seat-edit {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 10px;
}

.online-seat-edit label {
  flex: 1 1 170px;
}

.online-seat-edit button,
.online-seat-actions button,
.online-seat-actions select {
  min-height: 40px;
}

.online-seat-actions {
  display: flex;
  align-items: center;
  justify-content: end;
  flex-wrap: wrap;
  gap: 8px;
}

.online-bot-select {
  min-width: 132px;
}

.online-rules-form {
  display: grid;
  gap: 16px;
}

.online-rules-form > button {
  justify-self: start;
}

.online-rule-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  align-items: start;
  gap: 16px 24px;
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}

.online-rule-fields:disabled :is(input, select) {
  opacity: 1;
  color: var(--muted);
}

.online-timer-fields,
.online-seed-fields {
  grid-column: 1 / -1;
  display: grid;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.online-seed-fields input {
  font-family: monospace;
}

.online-notice {
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--error), transparent 55%);
  border-radius: 10px;
  background: color-mix(in srgb, var(--error), transparent 92%);
  color: var(--error);
}

.online-leave-button {
  margin-left: auto;
}

.online-join-content {
  max-width: 760px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

@media (max-width: 680px) {
  .online-lobby-content {
    padding-top: 28px;
  }

  .online-lobby-heading,
  .online-invite-panel,
  .online-start-panel {
    align-items: flex-start;
    flex-direction: column;
  }

  .online-seat-row {
    grid-template-columns: 30px minmax(0, 1fr);
    align-items: start;
  }

  .online-marker {
    width: 26px;
    height: 26px;
  }

  .online-seat-actions {
    grid-column: 2;
    justify-content: start;
  }

  .online-seat-edit {
    align-items: stretch;
    flex-direction: column;
    min-width: 0;
  }

  .online-seat-edit label {
    flex: none;
    width: 100%;
    min-width: 0;
  }
}

.online-start-progress {
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--raised);
}
.online-start-progress p {
  margin: 0.5rem 0 0;
}
.online-start-progress button {
  margin-top: 0.75rem;
}
.online-game-notice,
.online-audit-status {
  padding: 0.75rem;
  margin: 0;
  font-size: 0.875rem;
}
.online-audit-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}

.online-invite-url {
  min-width: 0;
  flex: 1;
  max-width: 100%;
}

.online-chat {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}
.online-chat h2 {
  margin: 0;
}
.online-chat-history {
  min-height: 7rem;
  max-height: 15rem;
  overflow-y: auto;
  padding: 0.75rem 1rem;
  margin: 0;
  border: 1px solid var(--border, #bbb);
  border-radius: 0.5rem;
  list-style: none;
}
.online-chat-history li {
  overflow-wrap: anywhere;
  padding-block: 0.2rem;
}
.online-chat-history li .button {
  margin-inline-start: 0.5rem;
}
.online-chat-emotes,
.online-chat-mutes,
.online-chat-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.online-chat-form input {
  flex: 1 1 12rem;
  min-width: 0;
}
.online-chat-dialog {
  width: min(32rem, calc(100vw - 2rem));
}

```

## apps/web/src/i18n/locales/en/lobby.json

```
{
  "homeTitle": "A table ready when you are",
  "homeDescription": "Play with friends in your browsers, or share a screen for a local game.",
  "playWithFriends": "Play with friends",
  "joinGame": "Join a game",
  "multiplayerBeta": "Multiplayer beta · invite friends to your table",
  "newGame": "New local game",
  "savedGames": "Saved games",
  "noSavedGames": "No saved games yet.",
  "resumeGame": "Resume game",
  "savedTurn": "Turn {{turn}}",
  "lastSaved": "Saved {{date}}",
  "setupTitle": "New local game",
  "setupDescription": "Choose seats and rules before the first placement.",
  "players": "Players",
  "playerCount": "Player count",
  "playerName": "Player {{number}} name",
  "nameRequired": "Enter a player name that is not blank.",
  "defaultPlayerName": "Player {{number}}",
  "playerRole": "Player {{number}} control",
  "human": "Human",
  "bot": "Bot",
  "playerColor": "Player {{number}} color",
  "blue": "Blue",
  "orange": "Orange",
  "green": "Green",
  "magenta": "Magenta",
  "yellow": "Yellow",
  "red": "Red",
  "boardAndRules": "Board and rules",
  "mapLayout": "Map layout",
  "mapBalanced": "Balanced random",
  "mapRandom": "Random",
  "mapFixed": "Fixed island",
  "vpTarget": "Victory points to win",
  "advancedRules": "Advanced rules",
  "discardLimit": "Robber discard threshold",
  "strictBalance": "Avoid adjacent high-probability numbers",
  "friendlyRobber": "Friendly robber",
  "playerTrades": "Allow player trades",
  "hideBankCounts": "Hide bank counts",
  "diceMode": "Dice mode",
  "diceRandom": "Random dice",
  "diceBalanced": "Balanced 36-roll deck",
  "turnTimer": "Use turn timers",
  "preRollSeconds": "Before roll, seconds",
  "mainSeconds": "Main turn, seconds",
  "discardSeconds": "Discard, seconds",
  "robberSeconds": "Robber move, seconds",
  "botDelay": "Bot pace, milliseconds",
  "createGame": "Create game",
  "creatingGame": "Creating game…",
  "creationFailed": "Could not create the game. Check the setup and try again.",
  "saveFailed": "The new game could not be saved.",
  "loadFailed": "The saved game could not be loaded.",
  "saveConflict": "This game changed in another tab. Reload before continuing.",
  "backHome": "Back to home",
  "settingsTitle": "Settings",
  "settingsDescription": "Choose how Hexfield looks and handles shared-screen turns.",
  "appearance": "Appearance",
  "theme": "Theme",
  "themeSystem": "Follow system",
  "themeLight": "Light",
  "themeDark": "Dark",
  "privacy": "Privacy",
  "hotseatCover": "Cover private hands when control changes",
  "motion": "Motion",
  "motionSystem": "Follow system preference",
  "motionReduce": "Skip movement animations",
  "saveSettings": "Save settings",
  "settingsSaved": "Settings saved",
  "settingsLoadError": "Settings could not be loaded.",
  "settingsSaveError": "Settings could not be saved.",
  "onlineCreateTitle": "Create an online room",
  "onlineCreateDescription": "Set the room rules, then invite friends with codes or a server link.",
  "onlineConnection": "Room details",
  "onlineRoomName": "Room name",
  "onlineHostName": "Your player name",
  "onlineServerOrigin": "Signaling server origin",
  "onlineServerHint": "Use the WebSocket origin supplied by your group. It must start with ws:// or wss://.",
  "onlineGameSetup": "Game setup",
  "onlineCreateAction": "Create room",
  "onlineOpening": "Connecting…",
  "onlineOpenFailed": "The room could not be opened. Check the invite or server address and try again.",
  "onlineAlreadyInvited": "Have an invitation?",
  "onlineJoinLink": "Join a room",
  "onlineJoinTitle": "Join an online room",
  "onlineJoinDescription": "Paste the complete invitation link. It pins the host and signaling server.",
  "onlineInvitation": "Invitation",
  "onlineInvitationUrl": "Full invitation link",
  "onlineInviteInvalid": "That invitation could not be opened. Check the full code or link, or ask the host for a fresh one.",
  "onlineJoinAction": "Join room",
  "onlineNeedRoom": "Want to host instead?",
  "onlineCreateLink": "Create a room",
  "onlineConnecting": "Connecting to the room…",
  "onlineTryAnotherInvite": "Enter another invitation",
  "onlineLobbyMissingTitle": "This room is not open in this tab",
  "onlineLobbyMissingBody": "Ask the host for a new invitation. If the game already started, open its saved game from the home screen on this browser.",
  "onlineLobbyTitle": "Online room",
  "onlineResumeUnsupportedVersion": "This saved game uses multiplayer version {{version}}, which this build cannot resume. Its data is still saved on this device. Start a new room with everyone on the current version.",
  "onlineLobbyKicker": "Online lobby",
  "onlinePeerCount": "{{connected}} of {{total}} players connected",
  "onlineWaitingForHost": "Waiting for the host to publish the room.",
  "onlineSignal_connecting": "Connecting",
  "onlineSignal_ready": "Connected",
  "onlineSignal_retrying": "Reconnecting",
  "onlineSignal_closed": "Disconnected",
  "onlineConnectionNotice": "Some room connections need attention. The room will keep trying to reconnect.",
  "onlineProtocolMismatch": "The host uses protocol version {{version}}. This build may not be compatible.",
  "onlineEngineMismatch": "The host uses game rules version {{version}}. This build may not be compatible.",
  "onlineInvalidLobbyMessage": "A room update could not be verified.",
  "onlineActionFailed": "That room change could not be saved. Check the connection and try again.",
  "onlineInviteTitle": "Invite players",
  "onlineInviteDescription": "Share a link that pins this host and the selected signaling server.",
  "onlineCopyInvite": "Copy invitation",
  "onlineInviteCopied": "Invitation copied",
  "onlineCopyFailed": "The invitation could not be copied. Check browser clipboard access.",
  "onlineSeatCount": "{{count}} seats",
  "onlineSeatNumber": "Seat {{number}}",
  "onlineOpenSeat": "Open seat",
  "onlineReady": "Ready",
  "onlineNotReady": "Not ready",
  "onlineBotHostedHere": "Bot hosted on this device",
  "onlineBotHostedByPlayer": "Bot hosted by another player",
  "onlineYourName": "Your player name",
  "onlineSaving": "Saving…",
  "onlineMarkReady": "Ready up",
  "onlineMarkNotReady": "Mark not ready",
  "onlineLeaveSeat": "Leave seat",
  "onlineTakeSeat": "Take seat",
  "onlineAddRandomBot": "Add a random bot to seat {{number}}",
  "onlineRandomBot": "Random bot",
  "onlineOpenSeatAction": "Open seat",
  "onlineKickPlayer": "Remove player",
  "onlineGameSettings": "Game settings",
  "onlineBaseGame": "Base game",
  "onlineSettingsReadyReset": "Saving a change asks every player to ready up again.",
  "onlineSettingsReadOnly": "Everyone plays with these settings. Only the host can change them before starting.",
  "onlineBoardSeed": "Board seed",
  "onlineSeedJoint": "Random, chosen together",
  "onlineSeedFixed": "Fixed board seed",
  "onlineSeedValue": "Seed, 64 hexadecimal characters",
  "onlineSeedHint": "The same seed and map settings produce the same board. Cards are still shuffled afresh.",
  "onlineBotHost": "Run bot on",
  "onlineStartTitle": "Ready to begin?",
  "onlineStartPreparation": "Everyone will approve the same board and shuffled cards before play begins.",
  "onlineDisconnectPolicy": "Players keep their seats if they disconnect. Reopen the saved game in the same browser to reconnect. Play waits whenever the missing player is needed.",
  "onlineNewRoom": "Create a new room",
  "onlineJoinNewRoom": "Join a new room",
  "onlineStartAction": "Start game",
  "onlineStartFailed": "The game could not finish starting. Check the connection and try this start again.",
  "onlineLeave": "Leave room",
  "onlineLeaveConfirmTitle": "Leave this room?",
  "onlineLeaveConfirmBody": "This closes your room connection. Started games stay saved in this browser. To return to an unstarted room, ask for a new invitation.",
  "onlineLeaveFailed": "The room connection could not be closed cleanly. Try again.",
  "onlineStay": "Stay in room",
  "onlineStartFreezing": "Confirming the game settings…",
  "onlineStartPreparing": "Preparing the players…",
  "onlineStartBoard": "Choosing the board together…",
  "onlineStartDeck": "Shuffling the cards together…",
  "onlineStartAgreement": "Confirming the game…",
  "onlineStartWaitingAgreement": "Waiting for the remaining confirmations. Keep this tab open.",
  "onlineStartOpening": "Opening the board…",
  "onlineStartRetired": "This start was cancelled. Create a new room to try again.",
  "onlineStartWaiting": "Waiting for {{players}}",
  "onlineRetryStart": "Retry this start",
  "onlineGameTitle": "Online game",
  "onlineYou": "You",
  "onlineConnected": "Connected",
  "onlineReconnecting": "Reconnecting",
  "onlineGameWaitingPeers": "Waiting for a connection to {{players}}. Keep this tab open.",
  "onlineGameLeaveBody": "Leaving closes your connection. The other players may need to wait for you.",
  "onlineAuditPassed": "Game audit passed",
  "onlineAuditFailed": "The game audit found an inconsistency",
  "onlineAuditWaiting": "Waiting for players to reveal their cards for the audit…",
  "onlineAuditVerifying": "Checking the complete game history…",
  "onlineAuditUnavailable": "The game audit could not finish",
  "onlineAuditPending": "The game audit has not finished yet",
  "onlineRetryAudit": "Retry audit",
  "onlineGameHalted": "This game's setup is no longer secure. Play has stopped.",
  "onlineGameHaltedBody": "A verified setup dispute exposed secret information. This game cannot continue. You can export its history before leaving.",
  "onlineResumeTitle": "Resume online game",
  "onlineResumeProgress": "Restoring your game and reconnecting to the players…",
  "onlineResumeFailed": "This game could not be restored. If it is open in another tab, return there. Otherwise, keep this browser's saved data and try again.",
  "onlineResumeRetry": "Try again",
  "onlineSavedGames": "Online games",
  "onlineSavedLoadFailed": "Saved online games could not be loaded.",
  "onlineSavedPartial": "Some saved online games are unavailable. Other games can still be resumed.",
  "onlineGameStarted": "Started {{date}}",
  "networkSettingsTitle": "Online connections",
  "networkSettingsDescription": "These settings apply the next time you open or reconnect to an online game.",
  "networkServerHint": "The default for rooms you create. Invitation links keep the server chosen by their host.",
  "networkConnectionPolicy": "Connection type",
  "networkDirectOrRelay": "Direct when possible",
  "networkRelayOnly": "Relay only",
  "networkRelayHint": "Relay only hides your IP address from other players and requires a TURN server.",
  "networkAdvanced": "STUN and TURN servers",
  "networkStunUrls": "STUN URLs, one per line",
  "networkTurnUrls": "TURN URLs, one per line",
  "networkTurnUsername": "TURN username",
  "networkTurnCredential": "TURN credential",
  "networkTurnEndpoint": "Temporary TURN credentials URL",
  "networkTurnEndpointHint": "Optional HTTPS endpoint provided by your TURN operator. TURN settings are saved on this device and never included in invitations.",
  "networkSettingsInvalid": "Check the server URLs and TURN credentials. Relay-only connections need a TURN server or a credentials endpoint.",
  "networkSaveSettings": "Save connection settings",
  "invitationQrLabel": "QR code for {{label}}",
  "invitationCopyCode": "Copy code",
  "invitationShare": "Share",
  "invitationDenseQr": "This code is quite long. Copy and paste it if the camera cannot read it.",
  "invitationCameraPreview": "QR scanner camera preview",
  "invitationStopCamera": "Stop camera",
  "invitationScan": "Scan QR code",
  "invitationCameraFailed": "The camera could not read a code. You can paste it instead.",
  "manualTitle": "Connect with codes",
  "manualReconnectTitle": "Reconnect a player",
  "manualReconnectHint": "Exchange codes with any player who is still connected to this game.",
  "manualInviteHint": "Invite one player at a time. Send your code, then enter the answer they send back.",
  "manualConnected": "Connected. You can continue in the lobby or invite another player.",
  "manualReconnected": "Connection restored. You can return to the board.",
  "manualAnswerHint": "Return your answer code to the player who invited you.",
  "manualSendOffer": "Send this offer to the player you want to connect.",
  "manualSendAnswer": "Send this answer back to the player who invited you. Keep this page open.",
  "manualOfferCode": "Offer code",
  "manualAnswerCode": "Answer code",
  "manualPasteAnswer": "Paste their answer code",
  "manualGatherIncomplete": "Network discovery reached its time limit. If connecting fails, create a fresh code or check Connection details.",
  "manualWaitingForAnswer": "Waiting for the other player to enter your answer…",
  "manualConnect": "Connect",
  "manualCancel": "Cancel invitation",
  "manualChoosePlayer": "Choose a player",
  "manualPreparing": "Preparing connection…",
  "manualNextInvite": "Invite next player",
  "manualCreateCode": "Create offer code",
  "manualHaveOffer": "I have an offer code from another player",
  "manualCreateAnswer": "Create answer code",
  "manualFailed": "The connection could not be completed. Check that you have the right code, or create a new invitation.",
  "manualConnectionMethod": "Connection method",
  "manualConnectionCodes": "Exchange codes",
  "manualConnectionServer": "Signaling server",
  "manualConnectionHint": "Connect directly by exchanging a pair of codes. No signaling server is needed.",
  "manualJoinDescription": "Paste an invitation link or offer code, or scan its QR code.",
  "manualLinkOrCode": "Invitation link or offer code",
  "manualUseCodes": "Connect using codes instead",
  "manualClose": "Close",
  "connectionDiagnosticsTitle": "Connection details",
  "connectionDiagnosticsSignaling": "Signaling server",
  "connectionDiagnosticsNoServer": "Using manual codes",
  "connectionDiagnosticsChecking": "Checking…",
  "connectionDiagnosticsUnreachable": "Health check unavailable",
  "connectionDiagnosticsReachable": "Reachable · {{ms}} ms",
  "connectionDiagnosticsHealthHint": "The health check could not reach this server. Existing peer connections may still work.",
  "connectionDiagnosticsTesting": "Testing connection…",
  "connectionDiagnosticsTest": "Test connectivity",
  "connectionDiagnosticsTestFailed": "The connection test could not finish. Check your network settings and try again.",
  "connectionDiagnosticsGatherTimeout": "Network discovery reached its time limit. These are the routes found so far.",
  "connectionDiagnosticsHost": "Local candidates",
  "connectionDiagnosticsStun": "Direct internet route (STUN)",
  "connectionDiagnosticsTurn": "Relay route (TURN)",
  "connectionDiagnosticsRelay": "Relay candidates",
  "connectionDiagnosticsElapsed": "Test duration",
  "connectionDiagnosticsMilliseconds": "{{ms}} ms",
  "connectionDiagnostics_observed": "Found",
  "connectionDiagnostics_not-observed": "Not found in this test",
  "connectionDiagnostics_not-configured": "Not configured",
  "connectionDiagnosticsTryTurnOrNetwork": "If players cannot connect, try the same Wi-Fi, a hotspot, or configure a TURN relay in Settings.",
  "connectionDiagnosticsPeer_connected": "Connected",
  "connectionDiagnosticsPeer_connecting": "Connecting",
  "connectionDiagnosticsPeer_disconnected": "Disconnected",
  "connectionDiagnosticsRoute_host": "Direct LAN",
  "connectionDiagnosticsRoute_srflx": "Direct internet",
  "connectionDiagnosticsRoute_relay": "Relayed",
  "connectionDiagnosticsRtt": "{{ms}} ms round trip",
  "chatTitle": "Chat",
  "chatMessage": "Message",
  "chatPlaceholder": "Say something to the room",
  "chatSend": "Send",
  "chatLength": "{{count}}/300 characters",
  "chatTooLong": "Keep your message to 300 characters or fewer.",
  "chatMutePlayer": "Mute {{player}}",
  "chatUnmute": "Unmute {{player}}",
  "chatEmotes": "Quick reactions",
  "chatEmote": {
    "wave": "Wave",
    "cheer": "Celebrate",
    "laugh": "Laugh",
    "wow": "Surprised",
    "thanks": "Love it"
  },
  "chatSpectator": "Spectator {{id}}",
  "chatFailed": "Chat could not save or send that message. Try again."
}

```
