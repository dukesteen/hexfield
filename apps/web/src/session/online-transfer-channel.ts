import { canonicalDecode, canonicalEncode, sha256, toHex } from '@cp2p/codec';
import type { PeerId, ProtocolClock, Transport, Unsubscribe } from '@cp2p/protocol';
import * as v from 'valibot';

const MAGIC = Uint8Array.of(0x48, 0x58, 0x54, 1);
const CHUNK_BYTES = 32 * 1024;
const MAX_FRAME_BYTES = Math.ceil((CHUNK_BYTES * 4) / 3) + 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_TRANSFERS = 64;
const CHUNK_IDLE_MS = 30_000;
const RETRY_MS = 5_000;
const MAX_CHUNK_ATTEMPTS = 6;
const kindSchema = v.picklist([
  'bootstrap',
  'offer',
  'authorized',
  'private',
  'readiness',
  'activated',
  'cancelled',
  'received',
]);
const uint = (max: number) => v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(max));
const common = {
  scope: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
  id: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_TRANSFERS)),
  index: uint(MAX_ARTIFACT_BYTES / CHUNK_BYTES - 1),
};
const ackSchema = v.strictObject({ ...common, type: v.literal('ack') });
const dataSchema = v.strictObject({
  ...common,
  type: v.literal('data'),
  kind: kindSchema,
  length: uint(MAX_ARTIFACT_BYTES),
  digest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  bytes: v.custom<Uint8Array>(
    (value) => value instanceof Uint8Array && value.length <= CHUNK_BYTES,
  ),
});
const frameSchema = v.variant('type', [ackSchema, dataSchema]);
type DataFrame = v.InferOutput<typeof dataSchema>;

export interface OnlineTransferArtifact {
  readonly kind: v.InferOutput<typeof kindSchema>;
  readonly bytes: Uint8Array;
}

function artifactLimit(kind: OnlineTransferArtifact['kind']): number {
  return kind === 'bootstrap' ||
    kind === 'authorized' ||
    kind === 'activated' ||
    kind === 'cancelled'
    ? MAX_ARTIFACT_BYTES
    : 64 * 1024;
}

function encode(frame: v.InferOutput<typeof frameSchema>): Uint8Array {
  const body = canonicalEncode(frame);
  const bytes = new Uint8Array(MAGIC.length + body.length);
  bytes.set(MAGIC);
  bytes.set(body, MAGIC.length);
  return bytes;
}

interface Incoming {
  readonly first: DataFrame;
  readonly bytes: Uint8Array;
  timer: unknown;
  nextIndex: number;
}

interface CompletedChunk {
  readonly id: number;
  readonly kind: DataFrame['kind'];
  readonly length: number;
  readonly digest: string;
  readonly index: number;
  readonly bytes: Uint8Array;
}

interface AwaitingAck {
  readonly id: number;
  readonly index: number;
  readonly frame: Uint8Array;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  attempts: number;
  idleTimer: unknown;
  retryTimer: unknown;
}

/** An isolated authenticated device link. Artifacts never enter the game transport. */
export class OnlineTransferChannel {
  private readonly off: Unsubscribe[];
  private incoming: Incoming | null = null;
  private completed: CompletedChunk | null = null;
  private lastReceived = 0;
  private nextId = 0;
  private sending = false;
  private closed = false;
  private awaiting: AwaitingAck | null = null;

  constructor(
    private readonly options: {
      readonly transport: Transport;
      readonly peer: PeerId;
      readonly scope: string;
      readonly clock: ProtocolClock;
      /** Receives owned public evidence or ciphertext. Must not block on user confirmation. */
      readonly onArtifact: (artifact: OnlineTransferArtifact) => void;
      readonly onError: (error: Error) => void;
    },
  ) {
    v.parse(common.scope, options.scope);
    if (options.peer === options.transport.self)
      throw new TypeError('A transfer requires a different destination device');
    this.off = [
      options.transport.onMessage((from, bytes) => {
        if (from === options.peer) this.receive(bytes);
      }),
      options.transport.onPeerChange((peer, online) => {
        if (peer === options.peer && !online) this.fail(new Error('Transfer connection closed'));
      }),
    ];
  }

  async send(artifact: OnlineTransferArtifact): Promise<void> {
    if (this.closed || this.sending) throw new Error('Transfer channel is closed or busy');
    v.parse(kindSchema, artifact.kind);
    if (
      !(artifact.bytes instanceof Uint8Array) ||
      artifact.bytes.length > artifactLimit(artifact.kind)
    )
      throw new RangeError('Transfer artifact exceeds its limit');
    if (!this.options.transport.peers().includes(this.options.peer))
      throw new Error('Transfer peer is not connected');
    if (this.nextId >= MAX_TRANSFERS) {
      const error = new Error('Transfer exchange limit reached');
      this.fail(error);
      throw error;
    }
    const bytes = new Uint8Array(artifact.bytes);
    const digest = toHex(sha256(bytes));
    const id = ++this.nextId;
    this.sending = true;
    try {
      const count = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
      for (let index = 0; index < count; index += 1) {
        if (this.closed) throw new Error('Transfer channel is closed');
        const frame = encode({
          type: 'data',
          scope: this.options.scope,
          id,
          index,
          kind: artifact.kind,
          length: bytes.length,
          digest,
          bytes: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
        });
        // oxlint-disable-next-line no-await-in-loop -- One acknowledged chunk bounds the underlying data-channel queue.
        await new Promise<void>((resolve, reject) => {
          const pending: AwaitingAck = {
            id,
            index,
            frame,
            resolve,
            reject,
            attempts: 0,
            idleTimer: undefined,
            retryTimer: undefined,
          };
          this.awaiting = pending;
          pending.idleTimer = this.options.clock.setTimeout(
            () => this.fail(new Error('Transfer delivery timed out')),
            CHUNK_IDLE_MS,
          );
          this.transmit(pending);
        });
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Transfer delivery failed'));
      throw error;
    } finally {
      if (this.awaiting) this.clearAwaitingTimers(this.awaiting);
      this.awaiting = null;
      this.sending = false;
      bytes.fill(0);
    }
  }

  private receive(bytes: Uint8Array): void {
    if (this.closed || !MAGIC.every((byte, index) => bytes[index] === byte)) return;
    try {
      if (bytes.length > MAX_FRAME_BYTES) throw new RangeError('Transfer frame is oversized');
      const frame = v.parse(frameSchema, canonicalDecode(bytes.subarray(MAGIC.length)));
      if (frame.scope !== this.options.scope) return;
      if (frame.type === 'ack') {
        if (this.awaiting?.id === frame.id && this.awaiting.index === frame.index) {
          const pending = this.awaiting;
          this.awaiting = null;
          this.clearAwaitingTimers(pending);
          pending.resolve();
        }
        return;
      }
      this.receiveData(frame);
    } catch {
      this.fail(new Error('Invalid transfer frame'));
    }
  }

  private receiveData(frame: DataFrame): void {
    const expectedSize = Math.min(CHUNK_BYTES, frame.length - frame.index * CHUNK_BYTES);
    if (
      frame.length > artifactLimit(frame.kind) ||
      expectedSize < 0 ||
      frame.bytes.length !== expectedSize
    )
      throw new Error('Transfer chunk length differs');
    if (frame.id <= this.lastReceived) {
      this.acknowledgeCompletedDuplicate(frame);
      return;
    }
    if (!this.incoming) {
      if (frame.index !== 0) throw new Error('Transfer does not start with its first chunk');
      this.incoming = {
        first: { ...frame, bytes: new Uint8Array(0) },
        bytes: new Uint8Array(frame.length),
        nextIndex: 0,
        timer: undefined,
      };
      this.resetIncomingTimer(this.incoming);
    }
    const incoming = this.incoming;
    const first = incoming.first;
    if (
      frame.id !== first.id ||
      frame.kind !== first.kind ||
      frame.length !== first.length ||
      frame.digest !== first.digest
    )
      throw new Error('Transfer chunks do not match');
    if (frame.index < incoming.nextIndex) {
      if (!this.chunkMatches(incoming.bytes, frame))
        throw new Error('Transfer duplicate chunk differs');
      this.sendAck(frame);
      return;
    }
    if (frame.index !== incoming.nextIndex) throw new Error('Transfer chunks do not match');
    incoming.bytes.set(frame.bytes, frame.index * CHUNK_BYTES);
    incoming.nextIndex += 1;
    this.resetIncomingTimer(incoming);
    const complete = incoming.nextIndex * CHUNK_BYTES >= frame.length;
    if (complete) {
      if (toHex(sha256(incoming.bytes)) !== first.digest)
        throw new Error('Transfer artifact digest differs');
      this.options.clock.clearTimeout(incoming.timer);
      const start = frame.index * CHUNK_BYTES;
      this.completed = {
        id: frame.id,
        kind: first.kind,
        length: first.length,
        digest: first.digest,
        index: frame.index,
        bytes: new Uint8Array(incoming.bytes.subarray(start, start + frame.bytes.length)),
      };
      this.incoming = null;
      this.lastReceived = frame.id;
    }
    this.sendAck(frame);
    if (complete) this.options.onArtifact({ kind: first.kind, bytes: incoming.bytes });
  }

  private transmit(pending: AwaitingAck): void {
    if (this.closed || this.awaiting !== pending) return;
    try {
      this.options.transport.send(this.options.peer, pending.frame);
      pending.attempts += 1;
      if (this.awaiting === pending && pending.attempts < MAX_CHUNK_ATTEMPTS) {
        pending.retryTimer = this.options.clock.setTimeout(() => {
          pending.retryTimer = undefined;
          this.transmit(pending);
        }, RETRY_MS);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Transfer send failed'));
    }
  }

  private clearAwaitingTimers(pending: AwaitingAck): void {
    this.options.clock.clearTimeout(pending.idleTimer);
    this.options.clock.clearTimeout(pending.retryTimer);
    pending.idleTimer = undefined;
    pending.retryTimer = undefined;
  }

  private resetIncomingTimer(incoming: Incoming): void {
    this.options.clock.clearTimeout(incoming.timer);
    incoming.timer = this.options.clock.setTimeout(
      () => this.fail(new Error('Transfer receive timed out')),
      CHUNK_IDLE_MS,
    );
  }

  private chunkMatches(buffer: Uint8Array, frame: DataFrame): boolean {
    const offset = frame.index * CHUNK_BYTES;
    if (frame.bytes.length !== Math.min(CHUNK_BYTES, buffer.length - offset)) return false;
    return frame.bytes.every((byte, index) => byte === buffer[offset + index]);
  }

  private acknowledgeCompletedDuplicate(frame: DataFrame): void {
    const completed = this.completed;
    if (!completed || frame.id !== completed.id) return;
    if (
      frame.kind !== completed.kind ||
      frame.length !== completed.length ||
      frame.digest !== completed.digest ||
      frame.index !== completed.index ||
      !frame.bytes.every((byte, index) => byte === completed.bytes[index]) ||
      frame.bytes.length !== completed.bytes.length
    )
      throw new Error('Completed transfer duplicate differs');
    this.sendAck(frame);
  }

  private sendAck(frame: DataFrame): void {
    this.options.transport.send(
      this.options.peer,
      encode({ type: 'ack', scope: frame.scope, id: frame.id, index: frame.index }),
    );
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.close(error);
    try {
      this.options.onError(error);
    } catch {
      /* A notification cannot interrupt channel cleanup. */
    }
  }

  close(error = new Error('Transfer channel closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.off) off();
    if (this.incoming) {
      this.options.clock.clearTimeout(this.incoming.timer);
      this.incoming.bytes.fill(0);
      this.incoming = null;
    }
    this.awaiting?.reject(error);
    if (this.awaiting) this.clearAwaitingTimers(this.awaiting);
    this.awaiting = null;
    this.completed?.bytes.fill(0);
    this.completed = null;
  }
}
