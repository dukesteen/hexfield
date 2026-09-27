import { canonicalEncode, fromBase64Url, toBase64Url } from '@cp2p/codec';
import { parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import type { PeerId, Unsubscribe } from '@cp2p/protocol';
import type { SignalBlob } from './signaling.js';

const MAX_ENVELOPE_BYTES = 70_000;
const MAX_DESCRIPTION_BYTES = 65_536;
const MAX_CANDIDATE_BYTES = 4_096;

export interface SignalEnvelopeBody {
  readonly version: 1;
  readonly scope: string;
  readonly from: PeerId;
  readonly to: PeerId;
  /** Fresh random 128-bit ID for one offer/answer and its ICE candidates. */
  readonly attemptId: string;
  /** Random process session; only attemptSeq orders attempts within it. */
  readonly sessionId: string;
  readonly attemptSeq: number;
  readonly blob: SignalBlob;
}

export interface SignedSignalEnvelope {
  readonly body: SignalEnvelopeBody;
  readonly sig: string;
}

/** Adapter sender metadata is untrusted until the contained signature verifies. */
export interface EnvelopeSignalingAdapter {
  send(to: PeerId, value: SignedSignalEnvelope): Promise<void>;
  onSignal(listener: (from: PeerId, value: unknown) => void): Unsubscribe;
  close(): void;
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

export function validAttemptId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return fromBase64Url(value).length === 16 && toBase64Url(fromBase64Url(value)) === value;
  } catch {
    return false;
  }
}

/** Validation occurs before signing and before any untrusted value reaches PeerLink. */
export function validSignalEnvelopeBody(value: unknown): value is SignalEnvelopeBody {
  if (
    !record(value) ||
    !exact(value, [
      'version',
      'scope',
      'from',
      'to',
      'attemptId',
      'sessionId',
      'attemptSeq',
      'blob',
    ]) ||
    value.version !== 1 ||
    typeof value.scope !== 'string' ||
    value.scope.length < 1 ||
    value.scope.length > 128 ||
    typeof value.from !== 'string' ||
    typeof value.to !== 'string' ||
    value.from === value.to ||
    !validAttemptId(value.attemptId) ||
    !validAttemptId(value.sessionId) ||
    !Number.isSafeInteger(value.attemptSeq) ||
    Number(value.attemptSeq) < 1 ||
    !record(value.blob)
  )
    return false;
  try {
    parsePeerId(value.from);
    parsePeerId(value.to);
  } catch {
    return false;
  }
  const blob = value.blob;
  if (
    !Number.isSafeInteger(blob.generation) ||
    Number(blob.generation) < 0 ||
    !Number.isSafeInteger(blob.revision) ||
    Number(blob.revision) < 1
  )
    return false;
  if (blob.kind === 'description') {
    if (
      !exact(blob, ['kind', 'generation', 'revision', 'description']) ||
      !record(blob.description) ||
      !exact(blob.description, ['type', 'sdp']) ||
      !['offer', 'answer'].includes(String(blob.description.type)) ||
      typeof blob.description.sdp !== 'string' ||
      blob.description.sdp.length > MAX_DESCRIPTION_BYTES
    )
      return false;
  } else if (blob.kind === 'candidate') {
    if (!exact(blob, ['kind', 'generation', 'revision', 'candidate'])) return false;
    if (
      blob.candidate !== null &&
      (!record(blob.candidate) ||
        typeof blob.candidate.candidate !== 'string' ||
        blob.candidate.candidate.length > MAX_CANDIDATE_BYTES)
    )
      return false;
  } else return false;
  try {
    return canonicalEncode(value).byteLength <= MAX_ENVELOPE_BYTES;
  } catch {
    return false;
  }
}

export function signSignalEnvelope(
  body: SignalEnvelopeBody,
  key: Uint8Array,
): SignedSignalEnvelope {
  if (!validSignalEnvelopeBody(body)) throw new TypeError('Invalid signaling envelope body');
  return { body, sig: signObject('p2p-signal', body, key) };
}

export function verifySignalEnvelope(
  value: unknown,
  scope: string,
  recipient: PeerId,
  expectedSenders: ReadonlySet<PeerId>,
): SignedSignalEnvelope | null {
  let detached: unknown;
  try {
    detached = structuredClone(value);
  } catch {
    return null;
  }
  if (
    !record(detached) ||
    !exact(detached, ['body', 'sig']) ||
    !validSignalEnvelopeBody(detached.body) ||
    typeof detached.sig !== 'string'
  )
    return null;
  const body = detached.body;
  if (body.scope !== scope || body.to !== recipient || !expectedSenders.has(body.from)) return null;
  try {
    return verifyObject('p2p-signal', body, detached.sig, parsePeerId(body.from))
      ? { body, sig: detached.sig }
      : null;
  } catch {
    return null;
  }
}
