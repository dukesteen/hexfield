import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import {
  G,
  encodePoint,
  identityFromSecret,
  openSealed,
  parsePeerId,
  recoverSecret,
  scalarToBytes,
  scalePoint,
  sealWithEphemeralProof,
  signObject,
  verifyObject,
  verifySealedEphemeralProof,
} from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { resolveArtifactSigner } from './authority.js';
import { escrowShareEnvelopeHash } from './escrow-distribution.js';
import { escrowDeliveryContexts, readEscrowShareOpening } from './escrow-opening.js';
import type { EscrowShareEnvelope } from './escrow-types.js';
import { validateGenesisEscrow } from './genesis-escrow.js';
import { entryHash, genesisDigest } from './genesis.js';
import type { ProtocolJournal } from './journal.js';
import type { LogContext } from './log-types.js';
import { replayCertifiedPrefix } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { MAX_MESSAGE_BYTES, parseCanonical } from './validation.js';

const refSchema = v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema });
const releaseBindingSchema = v.strictObject({
  protocol: v.literal('recovery-share-v1'),
  genesisDigest: key32Schema,
  authorization: refSchema,
  dealerSeat: seatSchema,
  holderSeat: seatSchema,
  holderIndex: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)),
  recipientSeat: seatSchema,
  recipientPublicKey: key32Schema,
  recipientEncryptionKey: key32Schema,
  envelopeHash: hashSchema,
  shareHash: hashSchema,
});
export const recoveryReleaseSchema = v.strictObject({
  body: v.strictObject({
    ...releaseBindingSchema.entries,
    sealed: v.strictObject({
      ephemeral: key32Schema,
      ciphertext: v.pipe(v.string(), v.maxLength(512), v.regex(/^[A-Za-z0-9_-]+$/)),
    }),
    ephemeralProof: v.strictObject({ commitment: key32Schema, response: key32Schema }),
  }),
  sig: signature64Schema,
});
export type RecoveryRelease = v.InferOutput<typeof recoveryReleaseSchema>;
type ReleaseBinding = v.InferOutput<typeof releaseBindingSchema>;

export interface RecoveryReleaseStore {
  load(id: string): Promise<Uint8Array | null>;
  /** True only after an immutable write has committed. An unknown outcome must throw. */
  putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
}

function same(left: unknown, right: unknown): boolean {
  return toHex(hashValue(left)) === toHex(hashValue(right));
}
function contexts(binding: ReleaseBinding) {
  return {
    seal: { domain: 'cp2p/v1/recovery-sealed-share', ...binding },
    proof: { domain: 'cp2p/v1/recovery-share-proof', ...binding },
  };
}

function releaseBinding(
  context: LogContext,
  dealerSeat: Seat,
  holderSeat: Seat,
  recipientSeat: Seat,
): Result<{ binding: ReleaseBinding; envelope: EscrowShareEnvelope }> {
  const recovery = context.recovery;
  const authorization = recovery?.authorizations.find((item) => same(item.entry, recovery.pending));
  if (!recovery?.pending || !authorization || !context.authority || !context.crypto)
    return failure(
      'recovery-release-unauthorized',
      'Shares need a locally certified pending recovery',
    );
  if (!authorization.statement.replacements.some((item) => item.seat === dealerSeat))
    return failure('recovery-release-dealer', 'This dealer is not named in the authorization');
  const recipient = authorization.statement.recoverers.find((item) => item.seat === recipientSeat);
  const currentRecipient = resolveArtifactSigner(
    context.authority,
    context.genesis,
    context.crypto.epoch,
    recipientSeat,
  );
  const originalRecipient = context.genesis.seats.find((item) => item.seat === recipientSeat);
  if (
    !recipient ||
    !currentRecipient.ok ||
    currentRecipient.value.publicKey !== recipient.publicKey ||
    !originalRecipient?.encryptionKey
  )
    return failure('recovery-release-recipient', 'Recipient is not a current authorized recoverer');
  const escrow = validateGenesisEscrow(context.genesis);
  if (!escrow.ok) return escrow;
  const envelope = escrow.value
    .find((item) => item.dealerSeat === dealerSeat)
    ?.shares.find((item) => item.envelope.body.holder.seat === holderSeat)?.envelope;
  if (!envelope)
    return failure('recovery-release-holder', 'Holder has no original share for this dealer');
  return success({
    envelope,
    binding: {
      protocol: 'recovery-share-v1',
      genesisDigest: genesisDigest(context.genesis),
      authorization: authorization.entry,
      dealerSeat,
      holderSeat,
      holderIndex: envelope.body.holder.index,
      recipientSeat,
      recipientPublicKey: recipient.publicKey,
      recipientEncryptionKey: originalRecipient.encryptionKey,
      envelopeHash: escrowShareEnvelopeHash(envelope),
      shareHash: envelope.body.shareHash,
    },
  });
}

/** Authenticates the release against a replayed current parent before decrypting any share. */
export function verifyRecoveryRelease(
  value: unknown,
  context: LogContext,
): Result<{ release: RecoveryRelease; envelope: EscrowShareEnvelope }> {
  const parsed = parseCanonical(value, recoveryReleaseSchema);
  if (!parsed.ok) return parsed;
  const release = parsed.value;
  const expected = releaseBinding(
    context,
    release.body.dealerSeat,
    release.body.holderSeat,
    release.body.recipientSeat,
  );
  if (!expected.ok) return expected;
  const { sealed, ephemeralProof, ...binding } = release.body;
  if (!same(binding, expected.value.binding))
    return failure(
      'recovery-release-binding',
      'Release differs from its certified authorization or original share',
    );
  const signer = resolveArtifactSigner(
    context.authority,
    context.genesis,
    context.crypto?.epoch ?? 0,
    binding.holderSeat,
  );
  if (!signer.ok) return signer;
  if (
    !verifyObject('recovery-share', release.body, release.sig, parsePeerId(signer.value.publicKey))
  )
    return failure(
      'recovery-release-signature',
      'Share release needs its current holder controller',
    );
  const transcript = contexts(binding);
  if (
    !verifySealedEphemeralProof(
      sealed,
      binding.recipientEncryptionKey,
      ephemeralProof,
      transcript.seal,
      transcript.proof,
    )
  )
    return failure('recovery-release-proof', 'Release encryption proof is invalid');
  return success({ release, envelope: expected.value.envelope });
}

/**
 * Reads the local durable branch itself. A proposal, timeout, imported snapshot or
 * caller approval callback cannot authorize disclosure. The live session must
 * serialize this operation with its journal commits and outbound queue.
 */
export async function prepareRecoveryRelease(input: {
  readonly journal: ProtocolJournal;
  readonly engine: Engine;
  readonly policy: ReplayPolicy;
  readonly genesisDigest: string;
  readonly dealerSeat: Seat;
  readonly holderSeat: Seat;
  readonly recipientSeat: Seat;
  readonly holderEncryptionSecret: bigint;
  readonly holderSigningKey: Uint8Array;
  readonly entropy: Uint8Array;
  readonly store: RecoveryReleaseStore;
}): Promise<Result<RecoveryRelease>> {
  let signingKey: Uint8Array | undefined;
  let entropy: Uint8Array | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    const {
      journal,
      engine,
      policy,
      store,
      genesisDigest: expectedDigest,
      dealerSeat,
      holderSeat,
      recipientSeat,
      holderEncryptionSecret,
    } = input;
    if (
      !(input.holderSigningKey instanceof Uint8Array) ||
      input.holderSigningKey.length !== 32 ||
      !(input.entropy instanceof Uint8Array) ||
      input.entropy.length !== 32
    )
      return failure('recovery-release-key', 'Release signing key and entropy must be 32 bytes');
    signingKey = input.holderSigningKey.slice();
    entropy = input.entropy.slice();
    const record = await journal.load();
    if (!record || record.height !== record.entries.length + 1)
      return failure(
        'recovery-release-history',
        'Durable certified history and safety height are required',
      );
    const replayed = replayCertifiedPrefix(record.genesis, record.entries, engine, policy);
    if (!replayed.ok)
      return failure('recovery-release-history', 'Durable history failed certified replay');
    const context = replayed.value.context.log;
    if (genesisDigest(context.genesis) !== expectedDigest || context.head.seq + 1 !== record.height)
      return failure(
        'recovery-release-history',
        'Journal differs from the requested game and height',
      );
    const expected = releaseBinding(context, dealerSeat, holderSeat, recipientSeat);
    if (!expected.ok) return expected;
    const signer = resolveArtifactSigner(
      context.authority,
      context.genesis,
      context.crypto?.epoch ?? 0,
      holderSeat,
    );
    if (!signer.ok) return signer;
    const identity = identityFromSecret(signingKey);
    const matchingKey = identity.peerId === signer.value.publicKey;
    identity.secretKey.fill(0);
    if (
      !matchingKey ||
      encodePoint(scalePoint(G, holderEncryptionSecret)) !==
        expected.value.envelope.body.holder.encryptionKey
    )
      return failure(
        'recovery-release-key',
        'Local keys differ from the current holder and original encryption key',
      );
    const slot = `recovery-release/${expectedDigest}/${expected.value.binding.authorization.hash}/${dealerSeat}/${holderSeat}/${recipientSeat}/${signer.value.generation.hash}`;
    const readStored = (bytes: Uint8Array): Result<RecoveryRelease> => {
      if (bytes.byteLength > MAX_MESSAGE_BYTES)
        return failure('recovery-release-store', 'Stored release exceeds its limit');
      const checked = verifyRecoveryRelease(canonicalDecode(bytes), context);
      if (!checked.ok) return checked;
      const { sealed: _sealed, ephemeralProof: _proof, ...binding } = checked.value.release.body;
      return same(binding, expected.value.binding)
        ? success(checked.value.release)
        : failure('recovery-release-store', 'Stored release belongs to another recipient or share');
    };
    const previous = await store.load(slot);
    let result: Result<RecoveryRelease>;
    if (previous !== null) result = readStored(previous);
    else {
      const original = expected.value.envelope.body;
      plaintext = openSealed(
        original.sealed,
        holderEncryptionSecret,
        escrowDeliveryContexts(original).seal,
      );
      const opening = readEscrowShareOpening(plaintext.slice(), original);
      if (!opening.ok) return opening;
      const transcript = contexts(expected.value.binding);
      const sealed = sealWithEphemeralProof(
        plaintext,
        expected.value.binding.recipientEncryptionKey,
        entropy,
        transcript.seal,
        transcript.proof,
      );
      const body = { ...expected.value.binding, ...sealed };
      const release: RecoveryRelease = {
        body,
        sig: signObject('recovery-share', body, signingKey),
      };
      const bytes = canonicalEncode(release);
      if (await store.putIfAbsent(slot, bytes)) result = success(release);
      else {
        const winner = await store.load(slot);
        result = winner
          ? readStored(winner)
          : failure('recovery-release-store', 'Winning release record is missing');
      }
    }
    if (!result.ok) return result;
    const latest = await journal.load();
    if (
      !latest ||
      latest.height !== record.height ||
      entryHash(latest.genesis) !== entryHash(record.genesis) ||
      entryHash(latest.entries.at(-1)?.entry ?? latest.genesis) !== entryHash(context.head)
    )
      return failure(
        'recovery-release-stale',
        'Certified head changed before release; retry at the latest parent',
      );
    return result;
  } catch {
    return failure(
      'recovery-release-failed',
      'Could not verify or durably prepare this share release',
    );
  } finally {
    signingKey?.fill(0);
    entropy?.fill(0);
    plaintext?.fill(0);
  }
}

/** Released corrupt shares cannot be mistaken for evidence of a bad dealer master. */
export function openRecoveryRelease(
  value: unknown,
  context: LogContext,
  recipientSeat: Seat,
  encryptionSecret: bigint,
): Result<{ dealerSeat: Seat; holderSeat: Seat; index: number; value: bigint }> {
  try {
    const verified = verifyRecoveryRelease(value, context);
    if (!verified.ok) return verified;
    const { release, envelope } = verified.value;
    const { sealed, ephemeralProof: _proof, ...binding } = release.body;
    if (
      binding.recipientSeat !== recipientSeat ||
      encodePoint(scalePoint(G, encryptionSecret)) !== binding.recipientEncryptionKey
    )
      return failure(
        'recovery-release-recipient',
        'Recipient encryption secret differs from the authorized identity',
      );
    const plaintext = openSealed(sealed, encryptionSecret, contexts(binding).seal);
    const share = readEscrowShareOpening(plaintext, envelope.body);
    return share.ok
      ? success({ dealerSeat: binding.dealerSeat, holderSeat: binding.holderSeat, ...share.value })
      : share;
  } catch {
    return failure(
      'recovery-release-opening',
      'Released share could not be authenticated and opened',
    );
  }
}

/** Requires every original holder exactly once; current quorum never reduces escrow threshold. */
export function recoverAuthorizedMaster(
  releases: readonly unknown[],
  context: LogContext,
  dealerSeat: Seat,
  recipientSeat: Seat,
  encryptionSecret: bigint,
): Result<Uint8Array> {
  try {
    const escrow = validateGenesisEscrow(context.genesis);
    if (!escrow.ok) return escrow;
    const dealer = escrow.value.find((item) => item.dealerSeat === dealerSeat);
    if (
      !dealer ||
      releases.length !== dealer.shares.length ||
      releases.length < 1 ||
      releases.length > 5
    )
      return failure('recovery-release-threshold', 'Every original holder share is required');
    const opened = [];
    for (const release of releases) {
      const share = openRecoveryRelease(release, context, recipientSeat, encryptionSecret);
      if (!share.ok) return share;
      if (share.value.dealerSeat !== dealerSeat)
        return failure(
          'recovery-release-dealer',
          'Recovery cannot mix shares from different dealers',
        );
      opened.push(share.value);
    }
    const expected = dealer.shares
      .map((item) => item.envelope.body.holder.index)
      .toSorted((a, b) => a - b);
    if (
      !same(
        opened.map((item) => item.index).toSorted((a, b) => a - b),
        expected,
      )
    )
      return failure('recovery-release-threshold', 'Missing or duplicated original holder indices');
    const envelope = dealer.shares[0]?.envelope;
    if (!envelope) return failure('recovery-release-threshold', 'Original escrow is missing');
    const secret = recoverSecret(opened, envelope.body.threshold);
    if (encodePoint(scalePoint(G, secret)) !== envelope.body.masterPub)
      return failure(
        'recovery-release-master',
        'Recovered scalar differs from the committed master',
      );
    return success(scalarToBytes(secret));
  } catch {
    return failure(
      'recovery-release-reconstruction',
      'Could not reconstruct the authorized master',
    );
  }
}
