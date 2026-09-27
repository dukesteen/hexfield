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
const RECEIVE_RATE_COUNT = 2 * RATE_COUNT;
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
      const currentRecipients = new Set(this.allowedSenders());
      if (!currentRecipients.has(self))
        return failure('chat-sender', 'This device is not in the current chat roster');
      let missed = false;
      for (const peer of recipients) {
        if (peer === self || !currentRecipients.has(peer)) continue;
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
    if (this.seen.has(eventKey(packet)) || !this.withinRate(from, RECEIVE_RATE_COUNT)) return;
    this.chargeRate(from);
    if (this.muted.has(from)) {
      this.markSeen(packet);
      return;
    }
    await this.remember(packet);
  }

  private withinRate(peer: PeerId, limit = RATE_COUNT): boolean {
    const now = this.options.clock.now();
    const recent = this.acceptedAt.get(peer) ?? [];
    const live = recent.filter((time) => now - time < RATE_WINDOW_MS && now >= time);
    this.acceptedAt.set(peer, live);
    return live.length < limit;
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
