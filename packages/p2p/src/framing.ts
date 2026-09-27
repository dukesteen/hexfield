import { sha256, toHex } from '@cp2p/codec';

export const MAX_MESSAGE_BYTES = 1_048_576;
export const MAX_FRAME_BYTES = 16_384;
export const FRAME_HEADER_BYTES = 8;
const FRAME_PAYLOAD_BYTES = MAX_FRAME_BYTES - FRAME_HEADER_BYTES;
const MAX_PARTIAL_MESSAGES = 8;
const MAX_PARTIAL_BYTES = 2 * MAX_MESSAGE_BYTES;
const PARTIAL_TTL_MS = 30_000;
const RECENT_IDS = 64;

interface PartialMessage {
  count: number;
  chunks: Map<number, Uint8Array>;
  bytes: number;
  expires: number;
}

interface CompletedMessage {
  count: number;
  hashes: ReadonlyMap<number, string>;
}

/** One ID space for both negotiated channels of a single connection. */
export class MessageFramer {
  private nextId = 0;
  private partialBytes = 0;
  private readonly partial = new Map<number, PartialMessage>();
  private readonly completed = new Map<number, CompletedMessage>();

  split(message: Uint8Array): Uint8Array[] {
    if (!(message instanceof Uint8Array) || message.byteLength > MAX_MESSAGE_BYTES)
      throw new RangeError('Transport message exceeds 1 MiB');
    if (this.nextId > 0xffff_ffff) throw new Error('Frame ID space exhausted');
    const id = this.nextId++;
    const count = Math.max(1, Math.ceil(message.byteLength / FRAME_PAYLOAD_BYTES));
    const frames: Uint8Array[] = [];
    for (let index = 0; index < count; index++) {
      const payload = message.subarray(
        index * FRAME_PAYLOAD_BYTES,
        (index + 1) * FRAME_PAYLOAD_BYTES,
      );
      const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
      const view = new DataView(frame.buffer);
      view.setUint32(0, id);
      view.setUint16(4, index);
      view.setUint16(6, count);
      frame.set(payload, FRAME_HEADER_BYTES);
      frames.push(frame);
    }
    return frames;
  }

  accept(frame: Uint8Array, now: number): Uint8Array | null {
    if (
      !(frame instanceof Uint8Array) ||
      frame.byteLength < FRAME_HEADER_BYTES ||
      frame.byteLength > MAX_FRAME_BYTES ||
      !Number.isFinite(now)
    )
      throw new Error('Malformed transport frame');
    if (this.expire(now) > 0) throw new Error('Transport reassembly timed out');
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const id = view.getUint32(0);
    const index = view.getUint16(4);
    const count = view.getUint16(6);
    if (count === 0 || count > Math.ceil(MAX_MESSAGE_BYTES / FRAME_PAYLOAD_BYTES) || index >= count)
      throw new Error('Invalid transport frame indices');
    const payload = frame.slice(FRAME_HEADER_BYTES);
    const completed = this.completed.get(id);
    if (completed) {
      if (completed.count !== count || completed.hashes.get(index) !== toHex(sha256(payload)))
        throw new Error('Conflicting completed transport frame');
      return null;
    }
    let pending = this.partial.get(id);
    if (!pending) {
      if (this.partial.size >= MAX_PARTIAL_MESSAGES) throw new Error('Too many partial messages');
      pending = { count, chunks: new Map(), bytes: 0, expires: now + PARTIAL_TTL_MS };
      this.partial.set(id, pending);
    }
    if (pending.count !== count) throw new Error('Conflicting transport frame count');
    const prior = pending.chunks.get(index);
    if (prior) {
      if (prior.length !== payload.length || prior.some((byte, at) => byte !== payload[at]))
        throw new Error('Conflicting duplicate transport frame');
      pending.expires = now + PARTIAL_TTL_MS;
      return null;
    }
    if (
      pending.bytes + payload.length > MAX_MESSAGE_BYTES ||
      this.partialBytes + payload.length > MAX_PARTIAL_BYTES
    )
      throw new Error('Transport reassembly limit exceeded');
    pending.chunks.set(index, payload);
    pending.expires = now + PARTIAL_TTL_MS;
    pending.bytes += payload.length;
    this.partialBytes += payload.length;
    if (pending.chunks.size !== count) return null;
    const result = new Uint8Array(pending.bytes);
    let offset = 0;
    for (let part = 0; part < count; part++) {
      const chunk = pending.chunks.get(part);
      if (!chunk) throw new Error('Missing transport frame');
      result.set(chunk, offset);
      offset += chunk.length;
    }
    this.partial.delete(id);
    this.partialBytes -= pending.bytes;
    this.completed.set(id, {
      count,
      hashes: new Map([...pending.chunks].map(([part, chunk]) => [part, toHex(sha256(chunk))])),
    });
    if (this.completed.size > RECENT_IDS) {
      const oldest = this.completed.keys().next().value;
      if (oldest !== undefined) this.completed.delete(oldest);
    }
    return result;
  }

  expire(now: number): number {
    let expired = 0;
    for (const [id, pending] of this.partial) {
      if (pending.expires > now) continue;
      this.partial.delete(id);
      this.partialBytes -= pending.bytes;
      expired++;
    }
    return expired;
  }

  clear(): void {
    this.partial.clear();
    this.completed.clear();
    this.partialBytes = 0;
  }
}
