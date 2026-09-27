import { canonicalEncode, fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import {
  createFeldmanShares,
  G,
  decodePoint,
  decodeScalar,
  encodePoint,
  encodeScalar,
  identityFromSecret,
  openSealed,
  parsePeerId,
  scalePoint,
  sealWithEphemeralProof,
  signObject,
  verifyObject,
  verifySealedEphemeralProof,
} from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { deriveEscrowRosters } from './escrow-roster.js';
import { escrowDeliveryContexts, readEscrowShareOpening } from './escrow-opening.js';
import type { EscrowShareEnvelope } from './escrow-types.js';
import type { EscrowDealerRoster } from './escrow-roster.js';
import { deckCeremonyId } from './deck-genesis.js';
import { genesisSchema } from './schemas.js';
import { validateGenesisEncryption } from './genesis-encryption.js';
import { validateGenesisMasters } from './genesis-masters.js';
import type { MasterCommitment } from './genesis-masters.js';
import { hashSchema, key32Schema, seatSchema, signature64Schema } from './schema-values.js';
import type { GenesisBody } from './types.js';
import { parseCanonical } from './validation.js';

export const ESCROW_SHARE_PROTOCOL = 'escrow-share-v1';
export const ESCROW_ACK_PROTOCOL = 'escrow-share-ack-v1';

export type { EscrowShareEnvelope } from './escrow-types.js';

export interface EscrowShareAck {
  readonly body: {
    readonly protocol: typeof ESCROW_ACK_PROTOCOL;
    readonly ceremonyId: string;
    readonly dealerSeat: Seat;
    readonly holderSeat: Seat;
    readonly holderIndex: number;
    readonly masterPub: string;
    readonly shareHash: string;
    readonly envelopeHash: string;
  };
  readonly sig: string;
}

export interface AcceptedEscrowShare {
  readonly dealerSeat: Seat;
  readonly holderSeat: Seat;
  readonly index: number;
  readonly value: bigint;
  readonly shareHash: string;
  readonly ack: EscrowShareAck;
}

export const escrowShareEnvelopeSchema = v.strictObject({
  body: v.strictObject({
    protocol: v.literal(ESCROW_SHARE_PROTOCOL),
    ceremonyId: key32Schema,
    dealer: v.strictObject({ seat: seatSchema, publicKey: key32Schema }),
    holder: v.strictObject({
      seat: seatSchema,
      publicKey: key32Schema,
      index: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)),
      encryptionKey: key32Schema,
    }),
    threshold: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)),
    masterPub: key32Schema,
    commitments: v.pipe(v.array(key32Schema), v.minLength(1), v.maxLength(6)),
    shareHash: hashSchema,
    sealed: v.strictObject({
      ephemeral: key32Schema,
      ciphertext: v.pipe(v.string(), v.maxLength(512), v.regex(/^[A-Za-z0-9_-]+$/)),
    }),
    ephemeralProof: v.strictObject({ commitment: key32Schema, response: key32Schema }),
  }),
  sig: signature64Schema,
});

const ackSchema = v.strictObject({
  body: v.strictObject({
    protocol: v.literal(ESCROW_ACK_PROTOCOL),
    ceremonyId: key32Schema,
    dealerSeat: seatSchema,
    holderSeat: seatSchema,
    holderIndex: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)),
    masterPub: key32Schema,
    shareHash: hashSchema,
    envelopeHash: hashSchema,
  }),
  sig: signature64Schema,
});

function checkedVerifiedGenesis(value: unknown): Result<GenesisBody> {
  const parsed = parseCanonical(
    value,
    v.union([genesisSchema, v.omit(genesisSchema, ['gameId', 'signatures'])]),
  );
  if (!parsed.ok) return failure('escrow-genesis', 'Escrow requires a canonical genesis body');
  if (parsed.value.security !== 'verified')
    return failure('escrow-security', 'Escrow distribution is available only for verified genesis');
  const genesis: GenesisBody = {
    protocolVersion: parsed.value.protocolVersion,
    engineVersion: parsed.value.engineVersion,
    config: parsed.value.config,
    seats: parsed.value.seats,
    genesisSeed: parsed.value.genesisSeed,
    ceremonyNonce: parsed.value.ceremonyNonce,
    security: parsed.value.security,
    takeover: parsed.value.takeover,
    commitments: parsed.value.commitments,
    createdAt: parsed.value.createdAt,
  };
  const encryption = validateGenesisEncryption(genesis);
  if (!encryption.ok) return encryption;
  return success(genesis);
}

interface EscrowContext {
  readonly genesis: GenesisBody;
  readonly ceremonyId: string;
  readonly rosters: readonly EscrowDealerRoster[];
  readonly masters: readonly MasterCommitment[];
}

function checkedContext(value: unknown): Result<EscrowContext> {
  const genesis = checkedVerifiedGenesis(value);
  if (!genesis.ok) return genesis;
  const masters = validateGenesisMasters(genesis.value);
  if (!masters.ok) return masters;
  const rosters = deriveEscrowRosters(genesis.value);
  if (!rosters.ok) return rosters;
  return success({
    genesis: genesis.value,
    ceremonyId: deckCeremonyId(genesis.value),
    rosters: rosters.value,
    masters: masters.value,
  });
}

function matchesMaster(
  context: EscrowContext,
  dealerSeat: Seat,
  expectedMasterPub: string,
): boolean {
  return context.masters.some(
    (master) => master.seat === dealerSeat && master.masterPub === expectedMasterPub,
  );
}

function expectedPayloadLength(body: EscrowShareEnvelope['body']): number {
  return canonicalEncode({
    protocol: ESCROW_SHARE_PROTOCOL,
    ceremonyId: body.ceremonyId,
    dealerSeat: body.dealer.seat,
    holderSeat: body.holder.seat,
    holderIndex: body.holder.index,
    threshold: body.threshold,
    masterPub: body.masterPub,
    share: encodeScalar(0n),
  }).length;
}

function dealerRoster(rosters: readonly EscrowDealerRoster[], dealerSeat: Seat) {
  return rosters.find((roster) => roster.dealer.seat === dealerSeat);
}

/** Stable ACK binding for the exact signed, sealed delivery bytes. */
export function escrowShareEnvelopeHash(envelope: EscrowShareEnvelope): string {
  return toHex(hashValue({ domain: 'cp2p/v1/escrow-signed-envelope', envelope }));
}

function expectedHolder(roster: EscrowDealerRoster, holderSeat: Seat, genesis: GenesisBody) {
  const holder = roster.holders.find((item) => item.seat === holderSeat);
  const seat = genesis.seats.find((item) => item.seat === holderSeat);
  return holder && seat?.encryptionKey ? { holder, encryptionKey: seat.encryptionKey } : undefined;
}

function parseAndCheckEnvelope(
  value: unknown,
  context: EscrowContext,
  dealerSeat: Seat,
  expectedMasterPub: string,
): Result<{ envelope: EscrowShareEnvelope; roster: EscrowDealerRoster }> {
  const { genesis, ceremonyId } = context;
  if (!matchesMaster(context, dealerSeat, expectedMasterPub))
    return failure('escrow-master', 'Expected master differs from the genesis manifest');
  const parsed = parseCanonical(value, escrowShareEnvelopeSchema);
  if (!parsed.ok) return failure('escrow-envelope', 'Escrow share envelope is malformed');
  const envelope = parsed.value as EscrowShareEnvelope;
  const roster = dealerRoster(context.rosters, dealerSeat);
  if (!roster?.eligible)
    return failure('escrow-roster', 'Dealer or holder is not eligible in the original roster');
  const { body } = envelope;
  const recipient = expectedHolder(roster, body.holder.seat, genesis);
  if (!recipient)
    return failure('escrow-roster', 'Dealer or holder is not eligible in the original roster');
  if (
    body.ceremonyId !== ceremonyId ||
    body.dealer.seat !== dealerSeat ||
    body.dealer.publicKey !== roster.dealer.publicKey ||
    body.holder.publicKey !== recipient.holder.publicKey ||
    body.holder.index !== recipient.holder.index ||
    body.holder.encryptionKey !== recipient.encryptionKey ||
    body.threshold !== roster.threshold ||
    body.masterPub !== expectedMasterPub ||
    body.commitments.length !== roster.threshold ||
    body.commitments[0] !== expectedMasterPub
  )
    return failure('escrow-binding', 'Escrow share differs from its frozen ceremony roster');
  try {
    parsePeerId(body.dealer.publicKey);
    parsePeerId(body.holder.publicKey);
    if (!verifyObject('escrow-share', body, envelope.sig, parsePeerId(roster.dealer.publicKey)))
      return failure('escrow-signature', 'Escrow share dealer signature is invalid');
    const ciphertext = fromBase64Url(body.sealed.ciphertext);
    if (
      toBase64Url(ciphertext) !== body.sealed.ciphertext ||
      ciphertext.length !== expectedPayloadLength(body)
    )
      return failure(
        'escrow-ciphertext',
        'Escrow ciphertext is not canonical or has the wrong size',
      );
    decodePoint(expectedMasterPub, { nonIdentity: true });
    // Honest generation derives nonzero coefficients. Reject a lower-degree escrow.
    try {
      for (const commitment of body.commitments) decodePoint(commitment, { nonIdentity: true });
    } catch {
      return failure('escrow-coefficient', 'Escrow coefficients must be nonidentity group points');
    }
    decodePoint(body.holder.encryptionKey, { nonIdentity: true });
    const contexts = escrowDeliveryContexts(body);
    if (
      !verifySealedEphemeralProof(
        body.sealed,
        body.holder.encryptionKey,
        body.ephemeralProof,
        contexts.seal,
        contexts.proof,
      )
    )
      return failure(
        'escrow-ephemeral-proof',
        'Escrow sender did not prove ephemeral-key knowledge',
      );
    return success({ envelope, roster });
  } catch {
    return failure('escrow-envelope', 'Escrow share envelope cryptographic values are invalid');
  }
}

/** Create one individually signed, sealed share for every immutable roster holder. */
export function createEscrowShareEnvelopes(input: {
  readonly genesis: GenesisBody;
  readonly dealerSeat: Seat;
  readonly expectedMasterPub: string;
  readonly masterSecret: bigint;
  readonly entropy: Uint8Array;
  readonly dealerSigningKey: Uint8Array;
}): Result<readonly EscrowShareEnvelope[]> {
  let entropy: Uint8Array | undefined;
  try {
    const context = checkedContext(input.genesis);
    if (!context.ok) return context;
    const { dealerSeat, expectedMasterPub, masterSecret } = input;
    if (!matchesMaster(context.value, dealerSeat, expectedMasterPub))
      return failure('escrow-master', 'Expected master differs from the genesis manifest');
    const { genesis, ceremonyId } = context.value;
    const parsedId = parseCanonical(ceremonyId, key32Schema);
    if (!parsedId.ok) return failure('escrow-ceremony', 'Escrow ceremony identifier is invalid');
    decodePoint(expectedMasterPub, { nonIdentity: true });
    decodeScalar(encodeScalar(masterSecret));
    if (masterSecret === 0n) return failure('escrow-master', 'Master secret is invalid');
    if (encodePoint(scalePoint(G, masterSecret)) !== expectedMasterPub)
      return failure('escrow-master', 'Dealer secret differs from the checked manifest key');
    const roster = dealerRoster(context.value.rosters, dealerSeat);
    if (!roster?.eligible || roster.holders.length === 0)
      return failure('escrow-ineligible', 'This original roster has no escrow distribution');
    const dealerIdentity = identityFromSecret(input.dealerSigningKey);
    const dealerMatches = dealerIdentity.peerId === roster.dealer.publicKey;
    dealerIdentity.secretKey.fill(0);
    if (!dealerMatches)
      return failure('escrow-dealer-key', 'Dealer signing key does not match roster');
    if (
      !(input.entropy instanceof Uint8Array) ||
      input.entropy.length !== 32 ||
      input.entropy.every((byte) => byte === 0)
    )
      return failure('escrow-entropy', 'Escrow entropy must be a private nonzero 32-byte seed');
    // Retain this private entropy for retries of the same ceremony attempt. Never publish it.
    entropy = Uint8Array.from(input.entropy);
    const indices = roster.holders.map(({ index }) => index);
    const distribution = createFeldmanShares(masterSecret, indices, roster.threshold, entropy, {
      protocol: ESCROW_SHARE_PROTOCOL,
      ceremonyId,
      dealerSeat,
      dealerPublicKey: roster.dealer.publicKey,
      masterPub: expectedMasterPub,
      threshold: roster.threshold,
      holders: roster.holders,
    });
    if (distribution.commitments[0] !== expectedMasterPub)
      return failure('escrow-master', 'Master secret does not match the checked manifest key');
    const envelopes = [] as EscrowShareEnvelope[];
    for (const holder of roster.holders) {
      const recipient = expectedHolder(roster, holder.seat, genesis);
      if (!recipient) return failure('escrow-encryption-key', 'Holder encryption key is missing');
      decodePoint(recipient.encryptionKey, { nonIdentity: true });
      const share = distribution.shares.find((item) => item.index === holder.index);
      if (!share) return failure('escrow-share', 'Feldman share was not generated');
      const payload = canonicalEncode({
        protocol: ESCROW_SHARE_PROTOCOL,
        ceremonyId,
        dealerSeat,
        holderSeat: holder.seat,
        holderIndex: holder.index,
        threshold: roster.threshold,
        masterPub: expectedMasterPub,
        share: encodeScalar(share.value),
      });
      const shareHash = toHex(hashValue({ domain: 'cp2p/v1/escrow-share-payload', payload }));
      const contexts = escrowDeliveryContexts({
        protocol: ESCROW_SHARE_PROTOCOL,
        ceremonyId,
        dealer: { seat: dealerSeat, publicKey: roster.dealer.publicKey },
        holder: {
          seat: holder.seat,
          publicKey: holder.publicKey,
          index: holder.index,
          encryptionKey: recipient.encryptionKey,
        },
        threshold: roster.threshold,
        masterPub: expectedMasterPub,
        commitments: distribution.commitments,
        shareHash,
      });
      let sealed: ReturnType<typeof sealWithEphemeralProof>;
      try {
        sealed = sealWithEphemeralProof(
          payload,
          recipient.encryptionKey,
          entropy,
          contexts.seal,
          contexts.proof,
        );
      } finally {
        payload.fill(0);
      }
      const body = {
        protocol: ESCROW_SHARE_PROTOCOL,
        ceremonyId,
        dealer: { seat: dealerSeat, publicKey: roster.dealer.publicKey },
        holder: {
          seat: holder.seat,
          publicKey: holder.publicKey,
          index: holder.index,
          encryptionKey: recipient.encryptionKey,
        },
        threshold: roster.threshold,
        masterPub: expectedMasterPub,
        commitments: distribution.commitments,
        shareHash,
        sealed: sealed.sealed,
        ephemeralProof: sealed.ephemeralProof,
      } as const;
      envelopes.push({ body, sig: signObject('escrow-share', body, input.dealerSigningKey) });
    }
    return success(envelopes);
  } catch {
    return failure('escrow-create', 'Could not create the bounded escrow share distribution');
  } finally {
    entropy?.fill(0);
  }
}

/** Authenticate the envelope and ephemeral-scalar proof before opening any ciphertext. */
export function verifyEscrowShareEphemeralProof(
  value: unknown,
  genesis: GenesisBody,
  dealerSeat: Seat,
  expectedMasterPub: string,
): Result<EscrowShareEnvelope> {
  const context = checkedContext(genesis);
  if (!context.ok) return context;
  try {
    const checked = parseAndCheckEnvelope(value, context.value, dealerSeat, expectedMasterPub);
    return checked.ok ? success(checked.value.envelope) : checked;
  } catch {
    return failure('escrow-genesis', 'Escrow ceremony context is invalid');
  }
}

/** Decrypt, check the exact Feldman opening, and sign its holder acknowledgement. */
export function acceptEscrowShare(input: {
  readonly envelope: unknown;
  readonly genesis: GenesisBody;
  readonly dealerSeat: Seat;
  readonly expectedMasterPub: string;
  readonly holderSeat: Seat;
  readonly recipientEncryptionSecret: bigint;
  readonly holderSigningKey: Uint8Array;
}): Result<AcceptedEscrowShare> {
  let plaintext: Uint8Array | undefined;
  let signingSecret: Uint8Array | undefined;
  try {
    const context = checkedContext(input.genesis);
    if (!context.ok) return context;
    const { genesis } = context.value;
    const checked = parseAndCheckEnvelope(
      input.envelope,
      context.value,
      input.dealerSeat,
      input.expectedMasterPub,
    );
    if (!checked.ok) return checked;
    const { envelope, roster } = checked.value;
    const { body } = envelope;
    if (body.holder.seat !== input.holderSeat)
      return failure('escrow-holder', 'Escrow envelope is addressed to a different holder');
    const recipient = expectedHolder(roster, input.holderSeat, genesis);
    if (!recipient) return failure('escrow-holder', 'Holder is not in the immutable roster');
    const recipientPoint = encodePoint(scalePoint(G, input.recipientEncryptionSecret));
    if (recipientPoint !== body.holder.encryptionKey)
      return failure('escrow-encryption-key', 'Recipient secret does not match the roster key');
    const holderIdentity = identityFromSecret(input.holderSigningKey);
    const holderMatches = holderIdentity.peerId === body.holder.publicKey;
    holderIdentity.secretKey.fill(0);
    if (!holderMatches)
      return failure('escrow-holder-key', 'Holder signing key does not match roster');
    const contexts = escrowDeliveryContexts(body);
    plaintext = openSealed(body.sealed, input.recipientEncryptionSecret, contexts.seal);
    const share = readEscrowShareOpening(plaintext, body);
    if (!share.ok) return share;
    signingSecret = Uint8Array.from(input.holderSigningKey);
    const ackBody = {
      protocol: ESCROW_ACK_PROTOCOL,
      ceremonyId: deckCeremonyId(genesis),
      dealerSeat: input.dealerSeat,
      holderSeat: input.holderSeat,
      holderIndex: body.holder.index,
      masterPub: input.expectedMasterPub,
      shareHash: body.shareHash,
      envelopeHash: escrowShareEnvelopeHash(envelope),
    } as const;
    return success({
      dealerSeat: input.dealerSeat,
      holderSeat: input.holderSeat,
      index: body.holder.index,
      value: share.value.value,
      shareHash: body.shareHash,
      ack: { body: ackBody, sig: signObject('escrow-share-ack', ackBody, signingSecret) },
    });
  } catch {
    return failure('escrow-share-open', 'Could not open and verify the escrow share');
  } finally {
    plaintext?.fill(0);
    signingSecret?.fill(0);
  }
}

export interface ExpectedEscrowAck {
  ceremonyId: string;
  dealerSeat: Seat;
  holderSeat: Seat;
  expectedMasterPub: string;
  shareHash: string;
  envelopeHash: string;
}

function checkAck(
  value: unknown,
  context: EscrowContext,
  expected: ExpectedEscrowAck,
): Result<EscrowShareAck> {
  const parsed = parseCanonical(value, ackSchema);
  if (!parsed.ok) return failure('escrow-ack', 'Escrow acknowledgement is malformed');
  const roster = dealerRoster(context.rosters, expected.dealerSeat);
  const holder = roster?.holders.find((item) => item.seat === expected.holderSeat);
  const { body } = parsed.value;
  if (
    !roster?.eligible ||
    !holder ||
    !matchesMaster(context, expected.dealerSeat, expected.expectedMasterPub) ||
    body.protocol !== ESCROW_ACK_PROTOCOL ||
    body.ceremonyId !== expected.ceremonyId ||
    body.dealerSeat !== expected.dealerSeat ||
    body.holderSeat !== expected.holderSeat ||
    body.holderIndex !== holder.index ||
    body.masterPub !== expected.expectedMasterPub ||
    body.shareHash !== expected.shareHash ||
    body.envelopeHash !== expected.envelopeHash ||
    expected.ceremonyId !== context.ceremonyId
  )
    return failure('escrow-ack-binding', 'Escrow acknowledgement differs from expected share');
  try {
    if (!verifyObject('escrow-share-ack', body, parsed.value.sig, parsePeerId(holder.publicKey)))
      return failure('escrow-ack-signature', 'Escrow holder acknowledgement signature is invalid');
    return success(parsed.value as EscrowShareAck);
  } catch {
    return failure('escrow-ack-signature', 'Escrow holder acknowledgement signature is invalid');
  }
}

export function verifyEscrowShareAck(
  value: unknown,
  genesis: GenesisBody,
  expected: ExpectedEscrowAck,
): Result<EscrowShareAck> {
  const context = checkedContext(genesis);
  return context.ok ? checkAck(value, context.value, expected) : context;
}

/** Keep the detached checked genesis private while verifying a complete transcript. */
export function prepareEscrowVerifier(genesis: GenesisBody) {
  const context = checkedContext(genesis);
  if (!context.ok) return context;
  const checked = context.value;
  return success({
    envelope(
      value: unknown,
      dealerSeat: Seat,
      expectedMasterPub: string,
    ): Result<EscrowShareEnvelope> {
      const result = parseAndCheckEnvelope(value, checked, dealerSeat, expectedMasterPub);
      return result.ok ? success(result.value.envelope) : result;
    },
    ack(value: unknown, expected: ExpectedEscrowAck): Result<EscrowShareAck> {
      return checkAck(value, checked, expected);
    },
  });
}
