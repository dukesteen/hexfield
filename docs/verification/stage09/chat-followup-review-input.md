# Stage 09 chat follow-up review

Read-only security and correctness rereview. Do not use tools or edit files. The user authorized Claude reviews. Source and deterministic tests only; no runtime credentials or private game records. The previous review identified six concrete issues, summarized in the attached disposition. This bundle contains the changed security-relevant source after fixes.

Challenge each claimed fix: ingress work before caps, per-sender fairness, durable duplicate suppression after seen-cache eviction, cross-instance mute merges, handled async receive errors, and fan-out after a failed recipient. Check for new races caused by cached roster updates or lobby-to-game switching, especially stale authorization after a kick and scope changes while packets wait in the queue. Check that a duplicate still-retained packet cannot be broadcast by the local sender or corrupt restore. Note any actual remaining data-loss/liveness defect in the bounded noncertified chat design.

For every confirmed issue report severity, file:line, concrete sequence, and smallest safe correction. Distinguish confirmed bugs from intentionally bounded history and missing browser evidence. Do not assume device-key forgery or recommend chat in the certified log. If the fixes are sound, say so plainly.

# Frozen follow-up source bundle

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
const MAX_QUEUED_PER_SENDER = 8;
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
  private readonly queuedBySender = new Map<PeerId, number>();
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
        this.queuedFrames >= MAX_QUEUED_FRAMES ||
        this.queuedBytes + bytes.byteLength > MAX_QUEUED_BYTES ||
        (this.queuedBySender.get(from) ?? 0) >= MAX_QUEUED_PER_SENDER ||
        !this.allowedSenders().includes(from)
      )
        return;
      this.queuedFrames++;
      this.queuedBytes += bytes.byteLength;
      this.queuedBySender.set(from, (this.queuedBySender.get(from) ?? 0) + 1);
      const packet = bytes.slice();
      void this.enqueue(async () => {
        try {
          await this.receive(from, packet);
        } finally {
          this.queuedFrames--;
          this.queuedBytes -= packet.byteLength;
          const pending = (this.queuedBySender.get(from) ?? 1) - 1;
          if (pending === 0) this.queuedBySender.delete(from);
          else this.queuedBySender.set(from, pending);
        }
      }).catch(() => undefined);
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
      this.error = null;
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
      this.error = null;
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

  scopeKind(): ChatScope['kind'] {
    return this.scope.kind;
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
      const stored = await this.remember(packet);
      if (this.disposed) return failure('chat-unavailable', 'Chat was closed before delivery');
      if (!stored) return failure('chat-duplicate', 'Chat event identity was reused');
      this.chargeRate(self);
      let missed = false;
      for (const peer of recipients) {
        if (peer === self) continue;
        try {
          this.options.transport.send(peer, bytes);
        } catch {
          missed = true;
        }
      }
      if (missed)
        return failure('chat-send', 'Chat was saved locally but could not reach every peer');
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
      const key = this.mutesKey();
      const updated = await this.options.store.withCeremonyLock(key, async () => {
        const prior = await this.options.store.load(key);
        const parsed = prior ? v.parse(mutesSchema, canonicalDecode(prior)) : { peers: [] };
        const next = new Set<PeerId>(parsed.peers);
        if (muted) next.add(peer);
        else next.delete(peer);
        if (next.size > 128) return failure('chat-mutes', 'Too many muted players');
        const bytes = canonicalEncode({
          protocol: 'online-chat-mutes-v1',
          peers: [...next].toSorted(),
        });
        const written = prior
          ? await this.options.store.compareAndSwap(key, prior, bytes)
          : await this.options.store.putIfAbsent(key, bytes);
        if (!written) throw new Error('Mute settings changed in another tab');
        return success(next);
      });
      if (!updated.ok) return updated;
      this.muted.clear();
      for (const item of updated.value) this.muted.add(item);
      this.error = null;
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

  private async remember(packet: SignedChatPacket): Promise<boolean> {
    const event: ChatEvent = { packet, receivedAt: Date.now() };
    const key = this.historyKey();
    const stored = await this.options.store.withCeremonyLock(key, async () => {
      const prior = await this.options.store.load(key);
      const previous = prior ? v.parse(historySchema, canonicalDecode(prior)) : { events: [] };
      if (
        previous.events.some(
          ({ packet: priorPacket }) => eventKey(priorPacket) === eventKey(packet),
        )
      )
        return false;
      const events = [...previous.events, event].slice(-MAX_HISTORY);
      const bytes = canonicalEncode({ protocol: 'online-chat-history-v1', events });
      const written = prior
        ? await this.options.store.compareAndSwap(key, prior, bytes)
        : await this.options.store.putIfAbsent(key, bytes);
      if (!written) throw new Error('Chat history changed in another tab');
      return true;
    });
    if (this.disposed) return false;
    this.markSeen(packet);
    if (!stored) return false;
    this.events = [...this.events, event].slice(-MAX_HISTORY);
    this.error = null;
    this.emit();
    return true;
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
  ) => {
    const identity = identities[index];
    const chat = new OnlineChat({
      transport,
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

function humanChatPeers(state: LobbyState): PeerId[] {
  return state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : []));
}

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
  private chatAllowedPeers: readonly PeerId[] = [];
  private readonly resumedChatState: LobbyState | null;
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
    this.resumedChatState = resume?.agreement.state ?? null;
    const initialState = this.resumedChatState ?? controller?.state();
    this.chatAllowedPeers = initialState
      ? [...humanChatPeers(initialState), ...(resume ? [] : initialState.spectators)]
      : [];
    this.chat = new OnlineChat({
      transport,
      clock,
      store,
      secretKey: identity.secretKey,
      scope: resume
        ? { kind: 'game', roomId: invite.roomId, genesisDigest: resume.genesisDigest }
        : { kind: 'lobby', roomId: invite.roomId },
      allowedSenders: () => this.chatAllowedPeers,
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
    if (this.startup.game() && this.chat.scopeKind() !== 'game')
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
    const gameChat = this.chat.scopeKind() === 'game' || game !== null;
    const chatState = gameChat ? (agreement?.state ?? this.resumedChatState) : state;
    this.chatAllowedPeers = chatState
      ? [...humanChatPeers(chatState), ...(gameChat ? [] : chatState.spectators)]
      : [];
    if (game && !this.chatSwitching && this.chat.scopeKind() === 'lobby' && agreement) {
      this.chatSwitching = true;
      void this.chat
        .enterGame(
          { kind: 'game', roomId: this.invite.roomId, genesisDigest: genesisDigest(game.genesis) },
          () => this.chatAllowedPeers,
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
        {(chat.ready ? chat.events : []).map(({ packet }) => {
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

## docs/verification/stage09/chat-review-disposition.md

```
# Stage 09 chat review disposition

The [read-only Claude response](chat-review-raw.md) reviewed the exact source and test bundle pinned in the [manifest](chat-review-manifest.json). It ran with tools and MCP servers disabled and no session persistence. The review used deterministic test identities only. The manifest remains the pre-fix snapshot; fixes below are a later source delta.

Claude found no signature, authenticated-sender, roster, or lobby/game scope bypass. I checked its actionable findings against the frozen source:

| Finding | Disposition |
| --- | --- |
| Pre-queue authorization clones the entire chat snapshot for each incoming frame | **Confirmed, release blocker.** `OnlineRoom` calls `chat.snapshot()` inside `allowedSenders` (`online-room.ts:170–179`), before the queue cap in `online-chat.ts:167–175`. A non-roster authenticated link can force work proportional to the 100-event history per rejected frame. Use a cheap scope accessor or phase-specific roster closure. |
| One sender fills the global 64-frame queue while another sender's valid packet is dropped | **Confirmed liveness defect.** The global cap is bounded but not fair. Add a per-sender pending-frame cap while retaining the global cap. The packet-drop regression should use two distinct senders. |
| Replayed event becomes a duplicate durable history entry after the 512-ID memory cache evicts it through muted messages | **Confirmed.** `remember` does not compare the durable 100-event history before append (`online-chat.ts:386–398`); restore then rejects duplicate IDs (`:417–430`). Prevent duplicate append under the store lock. Preserve fail-closed handling of already-corrupt persisted history rather than silently skipping duplicates on restore. |
| Two rooms or tabs overwrite each other's mutes | **Confirmed.** `setMuted` derives the new set before reading the current record under the lock (`online-chat.ts:299–317`). Apply the change to the record loaded inside the lock and copy that exact result to memory. |
| Incoming storage failure produces an unhandled promise rejection | **Confirmed.** The ingress callback discards `enqueue`'s rejecting result (`online-chat.ts:180`). The queue records an error, but the returned promise needs a terminal catch. |
| A failed first recipient prevents later recipients from receiving the saved packet | **Confirmed conditional delivery defect.** `send` stops its recipient loop at the first throw (`online-chat.ts:281–285`). Attempt every recipient and return a partial-delivery failure if any send fails. |
| Sticky error and transition-window delivery | **Confirmed lower-priority UX/liveness limits.** `error` is never cleared after successful storage. Chat may drop an in-flight message during lobby-to-game transition; the scope boundary remains intact. A brief lobby history display on the game screen remains possible before `enterGame` clears it. |
| Diagnostic leakage from raw transport consumers | **Not established.** The mesh relay subscribes to `onRelayFrame`, which checks its separate relay frame format, while gameplay uses `createOnlineNonChatTransport`; transport diagnostics concern link state. A focused integration check remains useful, but the review bundle did not demonstrate a CP2C diagnostic path. |

The retained 100-event history and 512-ID cache intentionally bound local storage. They do not provide lifetime-wide duplicate rejection after an event ages out. This limitation is separate from the confirmed duplicate-of-still-retained-event bug above. Real multi-browser chat evidence is being gathered separately; this review does not claim that acceptance.

## Follow-up fixes and focused evidence

- `OnlineRoom` now caches the authorized device roster on signed lobby or frozen-game state changes. Its ingress callback reads that small array directly; it no longer clones chat history to check a sender. The room also uses a cheap scope-kind accessor during the transition.
- `OnlineChat` limits pending frames to eight per sender as well as 64 total and 256 KiB. A three-peer regression blocks receiver storage, floods one sender and proves another sender's valid event survives.
- History append checks a still-retained event ID under the durable store lock. A regression sends 512 rate-spaced muted events, replays an earlier retained signed packet, restarts, and verifies exactly one event and a ready chat. Already-corrupt stored history still fails closed.
- Mute updates now read, change and write the current durable set inside the shared lock. Two chat instances mute different peers and a stale instance removes one; restore retains the other.
- Incoming queued storage failures have a terminal catch and remain visible as a chat error. A recovery write clears that error. Sending to a later peer continues after an earlier peer's transport throws; the caller still receives a partial-delivery failure.
- Chat history is hidden while the lobby-to-game scope switch is waiting, and controls remain unavailable until the game history loads.

Focused checks after these changes: four web test files, 22 tests passed (`online-chat`, `ChatPanel`, room registry and online game screen); web project build typecheck, test typecheck and scoped type-aware lint passed. The review follow-up still needs its own changed-source rereview and browser evidence is owned separately.

```
