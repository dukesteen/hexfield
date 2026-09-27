import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { hashSchema, key32Schema, seatSchema, signature64Schema } from './schema-values.js';
import type { PeerId } from './transport.js';
import { parseCanonical, MAX_MESSAGE_BYTES } from './validation.js';

export const ONLINE_CEREMONY_PROTOCOL = 'online-ceremony-v1';
export const ONLINE_CEREMONY_DOMAIN = 'online-ceremony-message-v1';

export const onlineCeremonyKindSchema = v.picklist([
  'created-at',
  'binding',
  'approval',
  'escrow-envelope',
  'escrow-accepted',
  'escrow-dispute',
  'escrow-invalid',
  'beacon-tip',
  'seed-commit',
  'seed-reveal',
  'deck-pass',
  'consent',
  'genesis-entry',
] as const);

export type OnlineCeremonyKind = v.InferOutput<typeof onlineCeremonyKindSchema>;

export const onlineCeremonyPacketSchema = v.strictObject({
  body: v.strictObject({
    protocol: v.literal(ONLINE_CEREMONY_PROTOCOL),
    freezeHash: hashSchema,
    ceremonyNonce: key32Schema,
    senderDevice: key32Schema,
    kind: onlineCeremonyKindSchema,
    seat: seatSchema,
    step: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(64)),
    payload: v.unknown(),
  }),
  sig: signature64Schema,
});

export type OnlineCeremonyPacket = v.InferOutput<typeof onlineCeremonyPacketSchema>;

export function onlineCeremonySlot(kind: OnlineCeremonyKind, seat: Seat, step: number): string {
  return `${kind}/${seat}/${step}`;
}

export function onlineCeremonyAttemptId(freezeHash: string, nonce: string): string {
  return toHex(hashValue({ domain: 'cp2p/v1/online-attempt', freezeHash, nonce }));
}

export function signOnlineCeremonyPacket(
  body: OnlineCeremonyPacket['body'],
  signingKey: Uint8Array,
): Result<{ packet: OnlineCeremonyPacket; bytes: Uint8Array }> {
  const parsed = parseCanonical(body, onlineCeremonyPacketSchema.entries.body);
  if (!parsed.ok) return parsed;
  try {
    const packet = {
      body: parsed.value,
      sig: signObject(ONLINE_CEREMONY_DOMAIN, parsed.value, signingKey),
    };
    const bytes = canonicalEncode(packet);
    return bytes.byteLength <= MAX_MESSAGE_BYTES
      ? success({ packet, bytes })
      : failure('online-ceremony-size', 'Ceremony packet exceeds the wire limit');
  } catch {
    return failure('online-ceremony-sign', 'Could not sign the ceremony packet');
  }
}

export function verifyOnlineCeremonyPacket(
  bytes: Uint8Array,
  from: PeerId,
  freezeHash: string,
  nonce: string,
): Result<OnlineCeremonyPacket> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_MESSAGE_BYTES)
    return failure('online-ceremony-size', 'Ceremony packet exceeds the wire limit');
  try {
    const parsed = parseCanonical(canonicalDecode(bytes), onlineCeremonyPacketSchema);
    if (!parsed.ok) return parsed;
    const packet = parsed.value;
    if (
      packet.body.freezeHash !== freezeHash ||
      packet.body.ceremonyNonce !== nonce ||
      packet.body.senderDevice !== from ||
      !verifyObject(ONLINE_CEREMONY_DOMAIN, packet.body, packet.sig, parsePeerId(from))
    )
      return failure('online-ceremony-auth', 'Packet is outside the frozen authenticated attempt');
    const canonical = canonicalEncode(packet);
    if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index]))
      return failure('online-ceremony-wire', 'Ceremony packet bytes are not canonical');
    return success(packet);
  } catch {
    return failure('online-ceremony-wire', 'Ceremony packet is malformed');
  }
}
