import { fromBase64Url, hashValue, toBase64Url } from '@cp2p/codec';
import { parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import type { PeerId } from '@cp2p/protocol';
import { aggregateManualSdp } from './manual-sdp.js';
import { decodeManualSdpWire, encodeManualSdpWire } from './manual-sdp-codec.js';

const PREFIX = 'HX1.';
const MAX_CODE_CHARS = 2_048;
const MAX_COMPRESSED_BYTES = 1_533;
const MAX_DECOMPRESSED_BYTES = 70_000;
const MAX_SCOPE_LENGTH = 128;
const NONCE_BYTES = 16;
const HASH_BYTES = 32;
const CODE_DOMAIN = 'p2p-manual-bootstrap';
const WIRE_VERSION = 0xa1;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export type ManualCodeBody =
  | {
      readonly v: 1;
      readonly k: 'o';
      readonly sc: string;
      readonly f: PeerId;
      readonly n: string;
      readonly s: string;
      readonly t?: PeerId;
    }
  | {
      readonly v: 1;
      readonly k: 'a';
      readonly sc: string;
      readonly f: PeerId;
      readonly t: PeerId;
      readonly n: string;
      readonly h: string;
      readonly s: string;
    };

export interface SignedManualCode {
  readonly b: ManualCodeBody;
  readonly g: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function validBase64(value: unknown, length: number): value is string {
  if (typeof value !== 'string') return false;
  try {
    const bytes = fromBase64Url(value);
    return bytes.length === length && toBase64Url(bytes) === value;
  } catch {
    return false;
  }
}

function exactUtf8(value: string): boolean {
  return decoder.decode(encoder.encode(value)) === value;
}

function validBody(value: unknown): value is ManualCodeBody {
  if (
    !record(value) ||
    value.v !== 1 ||
    !['o', 'a'].includes(String(value.k)) ||
    typeof value.sc !== 'string' ||
    value.sc.length < 1 ||
    value.sc.length > MAX_SCOPE_LENGTH ||
    !exactUtf8(value.sc) ||
    typeof value.f !== 'string' ||
    !validBase64(value.n, NONCE_BYTES) ||
    typeof value.s !== 'string' ||
    value.s.length > 65_536 ||
    !exactUtf8(value.s)
  )
    return false;
  if (value.k === 'o') {
    if (
      !exact(
        value,
        value.t === undefined
          ? ['v', 'k', 'sc', 'f', 'n', 's']
          : ['v', 'k', 'sc', 'f', 'n', 's', 't'],
      )
    )
      return false;
  } else if (
    !exact(value, ['v', 'k', 'sc', 'f', 't', 'n', 'h', 's']) ||
    !validBase64(value.h, HASH_BYTES)
  )
    return false;
  try {
    parsePeerId(value.f);
    if (value.t !== undefined) {
      if (typeof value.t !== 'string' || value.t === value.f) return false;
      parsePeerId(value.t);
    }
    aggregateManualSdp(value.s);
    return true;
  } catch {
    return false;
  }
}

function validSigned(value: unknown): value is SignedManualCode {
  return (
    record(value) &&
    exact(value, ['b', 'g']) &&
    validBody(value.b) &&
    typeof value.g === 'string' &&
    validBase64(value.g, 64)
  );
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  if (length > MAX_DECOMPRESSED_BYTES)
    throw new RangeError('Manual code evidence exceeds its size limit');
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function wireBytes(signed: SignedManualCode): Uint8Array {
  const { b } = signed;
  const scope = encoder.encode(b.sc);
  if (scope.length > 0xffff) throw new RangeError('Manual code scope is too long');
  return join([
    new Uint8Array([WIRE_VERSION, b.k === 'o' ? 0 : 1, b.t === undefined ? 0 : 1]),
    new Uint8Array([scope.length >>> 8, scope.length & 255]),
    scope,
    fromBase64Url(b.f),
    fromBase64Url(b.n),
    ...(b.t === undefined ? [] : [fromBase64Url(b.t)]),
    ...(b.k === 'o' ? [] : [fromBase64Url(b.h)]),
    fromBase64Url(signed.g),
    encodeManualSdpWire(b.s),
  ]);
}

function signedFromWire(bytes: Uint8Array): SignedManualCode {
  let offset = 0;
  const take = (length: number): Uint8Array => {
    if (length < 0 || length > bytes.length - offset)
      throw new TypeError('Manual code wire is truncated');
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const version = take(1)[0];
  const kind = take(1)[0];
  const flags = take(1)[0];
  const length = take(2);
  const scopeLength = ((length[0] ?? 0) << 8) | (length[1] ?? 0);
  if (
    version !== WIRE_VERSION ||
    (kind !== 0 && kind !== 1) ||
    (flags !== 0 && flags !== 1) ||
    (kind === 1 && flags !== 1) ||
    scopeLength > MAX_SCOPE_LENGTH * 4
  )
    throw new TypeError('Manual code wire header is invalid');
  const sc = decoder.decode(take(scopeLength));
  const f = toBase64Url(take(32));
  const n = toBase64Url(take(NONCE_BYTES));
  const t = flags === 1 ? toBase64Url(take(32)) : undefined;
  const h = kind === 1 ? toBase64Url(take(HASH_BYTES)) : undefined;
  const g = toBase64Url(take(64));
  const s = decodeManualSdpWire(take(bytes.length - offset));
  let b: ManualCodeBody;
  if (kind === 0) b = { v: 1, k: 'o', sc, f, n, s, ...(t === undefined ? {} : { t }) };
  else {
    if (t === undefined || h === undefined) throw new TypeError('Manual answer wire is incomplete');
    b = { v: 1, k: 'a', sc, f, t, n, h, s };
  }
  return { b, g };
}

async function transform(bytes: Uint8Array, mode: 'compress' | 'decompress'): Promise<Uint8Array> {
  if (
    (mode === 'compress' && typeof CompressionStream === 'undefined') ||
    (mode === 'decompress' && typeof DecompressionStream === 'undefined')
  )
    throw new Error('This browser does not support manual code compression');
  const stream =
    mode === 'compress'
      ? new CompressionStream('deflate-raw')
      : new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const input = new Uint8Array(bytes.length);
  input.set(bytes);
  const writing = writer.write(input).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  let length = 0;
  const limit = mode === 'compress' ? MAX_COMPRESSED_BYTES : MAX_DECOMPRESSED_BYTES;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- Compressed output must be capped while streaming.
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > limit) throw new RangeError('Manual code exceeds its size limit');
      chunks.push(next.value);
    }
    await writing;
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  } catch (error) {
    await Promise.allSettled([reader.cancel(), writer.abort()]);
    void writing.catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

/** One signed, bounded non-trickle bootstrap offer or answer. */
export async function encodeManualCode(
  body: ManualCodeBody,
  secretKey: Uint8Array,
): Promise<string> {
  if (!validBody(body)) throw new TypeError('Manual code body is invalid');
  const signed: SignedManualCode = { b: body, g: signObject(CODE_DOMAIN, body, secretKey) };
  if (!verifyObject(CODE_DOMAIN, body, signed.g, parsePeerId(body.f)))
    throw new TypeError('Manual code key does not match its claimed sender');
  const wire = wireBytes(signed);
  const restored = signedFromWire(wire);
  if (restored.b.sc !== body.sc || restored.b.s !== body.s)
    throw new TypeError('Manual code cannot restore its signed body exactly');
  const compressed = await transform(wire, 'compress');
  const code = PREFIX + toBase64Url(compressed);
  if (code.length > MAX_CODE_CHARS) throw new RangeError('Manual code exceeds its size limit');
  return code;
}

/** Strict decoding validates canonical bytes, signature, scope and optional recipient. */
export async function decodeManualCode(
  code: string,
  scope?: string,
  recipient?: PeerId,
): Promise<SignedManualCode> {
  if (typeof code !== 'string' || !code.startsWith(PREFIX) || code.length > MAX_CODE_CHARS)
    throw new TypeError('Manual code has an invalid HX1 prefix or length');
  const encoded = code.slice(PREFIX.length);
  const compressed = fromBase64Url(encoded);
  if (compressed.length > MAX_COMPRESSED_BYTES || toBase64Url(compressed) !== encoded)
    throw new TypeError('Manual code is not canonical base64url');
  const decodedBytes = await transform(compressed, 'decompress');
  let decoded: SignedManualCode;
  try {
    decoded = signedFromWire(decodedBytes);
  } catch {
    throw new TypeError('Manual code contains invalid compact data');
  }
  const canonical = wireBytes(decoded);
  if (
    !validSigned(decoded) ||
    decodedBytes.length !== canonical.length ||
    !decodedBytes.every((byte, index) => byte === canonical[index]) ||
    (scope !== undefined && decoded.b.sc !== scope) ||
    (recipient !== undefined && decoded.b.t !== undefined && decoded.b.t !== recipient) ||
    !verifyObject(CODE_DOMAIN, decoded.b, decoded.g, parsePeerId(decoded.b.f))
  )
    throw new TypeError('Manual code signature, scope or recipient is invalid');
  return decoded;
}

/** Read only a signed first-offer room hint; the room still verifies the full offer. */
export async function readManualLobbyOffer(
  code: string,
): Promise<{ roomId: string; from: PeerId; to?: PeerId }> {
  const signed = await decodeManualCode(code);
  const match = /^lobby:([a-z2-7]{10})$/.exec(signed.b.sc);
  if (signed.b.k !== 'o' || !match) throw new TypeError('Not a manual lobby offer');
  const roomId = match[1];
  if (!roomId) throw new TypeError('Manual lobby room is missing');
  return {
    roomId,
    from: signed.b.f,
    ...(signed.b.t === undefined ? {} : { to: signed.b.t }),
  };
}

/** The answer binds the complete signed offer, including its SDP fingerprint. */
export function manualOfferHash(offer: SignedManualCode): string {
  if (!validSigned(offer) || offer.b.k !== 'o') throw new TypeError('Manual offer is invalid');
  return toBase64Url(hashValue(offer));
}
