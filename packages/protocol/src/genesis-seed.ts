import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import {
  DERIVATION_LABELS,
  deriveBytes,
  identityFromSecret,
  parsePeerId,
  scalarFromBytes,
  signObject,
  verifyObject,
} from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { hashSchema, key32Schema, seatSchema, signature64Schema } from './schema-values.js';
import { parseCanonical } from './validation.js';

export const genesisSeedModeSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('joint') }),
  v.strictObject({ kind: v.literal('fixed'), seed: key32Schema }),
]);

export type GenesisSeedMode = v.InferOutput<typeof genesisSeedModeSchema>;

const participantSchema = v.strictObject({ seat: seatSchema, publicKey: key32Schema });
const scopeSchema = v.strictObject({
  freezeHash: hashSchema,
  ceremonyNonce: key32Schema,
  ceremonyId: key32Schema,
  participants: v.pipe(v.array(participantSchema), v.minLength(1), v.maxLength(6)),
  mode: genesisSeedModeSchema,
});

const commonBody = {
  protocol: v.literal('genesis-seed-v1'),
  freezeHash: hashSchema,
  ceremonyNonce: key32Schema,
  seat: seatSchema,
};
const commitBodySchema = v.strictObject({ ...commonBody, commit: hashSchema });
const revealBodySchema = v.strictObject({ ...commonBody, share: key32Schema });
const signedCommitSchema = v.strictObject({ body: commitBodySchema, sig: signature64Schema });
const signedRevealSchema = v.strictObject({ body: revealBodySchema, sig: signature64Schema });
const transcriptSchema = v.variant('kind', [
  v.strictObject({
    protocol: v.literal('genesis-seed-v1'),
    kind: v.literal('joint'),
    commits: v.pipe(v.array(signedCommitSchema), v.minLength(1), v.maxLength(6)),
    reveals: v.pipe(v.array(signedRevealSchema), v.minLength(1), v.maxLength(6)),
  }),
  v.strictObject({
    protocol: v.literal('genesis-seed-v1'),
    kind: v.literal('fixed'),
    seed: key32Schema,
  }),
]);

export type GenesisSeedScope = v.InferOutput<typeof scopeSchema>;
export type SignedGenesisSeedCommit = v.InferOutput<typeof signedCommitSchema>;
export type SignedGenesisSeedReveal = v.InferOutput<typeof signedRevealSchema>;
export type GenesisSeedTranscript = v.InferOutput<typeof transcriptSchema>;

function validScope(value: unknown): Result<GenesisSeedScope> {
  const parsed = parseCanonical(value, scopeSchema);
  if (!parsed.ok) return parsed;
  const scope = parsed.value;
  if (scope.participants.some((participant, index) => participant.seat !== index))
    return failure('genesis-seed-scope', 'Seed participants must be in genesis seat order');
  if (
    new Set(scope.participants.map((participant) => participant.publicKey)).size !==
    scope.participants.length
  )
    return failure('genesis-seed-scope', 'Seed participant keys must be distinct');
  try {
    for (const participant of scope.participants) parsePeerId(participant.publicKey);
  } catch {
    return failure('genesis-seed-scope', 'Seed participant identity is invalid');
  }
  return success(scope);
}

function shareCommit(ceremonyNonce: string, seat: Seat, share: string): string {
  return toHex(hashValue({ domain: 'cp2p/v1/genesis-seed-commit', ceremonyNonce, seat, share }));
}

function prepareSeedPacket(
  scopeValue: unknown,
  seat: Seat,
  master: Uint8Array,
  signingKey: Uint8Array,
): Result<{ scope: GenesisSeedScope; share: string }> {
  const checked = validScope(scopeValue);
  if (!checked.ok) return checked;
  const scope = checked.value;
  if (scope.mode.kind !== 'joint')
    return failure('genesis-seed-mode', 'Fixed seed mode has no commit or reveal packets');
  const participant = scope.participants[seat];
  if (!participant || participant.seat !== seat)
    return failure('genesis-seed-seat', 'Seed seat is outside the frozen roster');
  try {
    scalarFromBytes(master, { nonzero: true });
  } catch {
    return failure('genesis-seed-master', 'Seed master must be a nonzero canonical scalar');
  }
  let share: Uint8Array | null = null;
  try {
    const identity = identityFromSecret(signingKey);
    const matches = identity.peerId === participant.publicKey;
    identity.secretKey.fill(0);
    if (!matches) return failure('genesis-seed-signer', 'Seed signer does not own this seat');
    share = deriveBytes(
      master,
      DERIVATION_LABELS.genesisSeed,
      {
        ceremonyNonce: scope.ceremonyNonce,
        seat,
      },
      32,
    );
    return success({ scope, share: toBase64Url(share) });
  } catch {
    return failure('genesis-seed-signing', 'Could not derive or sign the seed packet');
  } finally {
    share?.fill(0);
  }
}

export function createGenesisSeedCommit(
  scope: GenesisSeedScope,
  seat: Seat,
  master: Uint8Array,
  signingKey: Uint8Array,
): Result<SignedGenesisSeedCommit> {
  const prepared = prepareSeedPacket(scope, seat, master, signingKey);
  if (!prepared.ok) return prepared;
  const body = {
    protocol: 'genesis-seed-v1' as const,
    freezeHash: prepared.value.scope.freezeHash,
    ceremonyNonce: prepared.value.scope.ceremonyNonce,
    seat,
    commit: shareCommit(prepared.value.scope.ceremonyNonce, seat, prepared.value.share),
  };
  return success({ body, sig: signObject('genesis-seed-commit-v1', body, signingKey) });
}

export function createGenesisSeedReveal(
  scope: GenesisSeedScope,
  seat: Seat,
  master: Uint8Array,
  signingKey: Uint8Array,
): Result<SignedGenesisSeedReveal> {
  const prepared = prepareSeedPacket(scope, seat, master, signingKey);
  if (!prepared.ok) return prepared;
  const body = {
    protocol: 'genesis-seed-v1' as const,
    freezeHash: prepared.value.scope.freezeHash,
    ceremonyNonce: prepared.value.scope.ceremonyNonce,
    seat,
    share: prepared.value.share,
  };
  return success({ body, sig: signObject('genesis-seed-reveal-v1', body, signingKey) });
}

export function validateGenesisSeedTranscript(
  scopeValue: unknown,
  transcriptValue: unknown,
): Result<{ genesisSeed: string; transcript: GenesisSeedTranscript }> {
  const checked = validScope(scopeValue);
  if (!checked.ok) return checked;
  const scope = checked.value;
  const parsed = parseCanonical(transcriptValue, transcriptSchema);
  if (!parsed.ok) return parsed;
  const transcript = parsed.value;
  if (scope.mode.kind !== transcript.kind)
    return failure('genesis-seed-mode', 'Seed transcript differs from the frozen mode');
  if (scope.mode.kind === 'fixed') {
    if (transcript.kind !== 'fixed' || transcript.seed !== scope.mode.seed)
      return failure('genesis-seed-fixed', 'Fixed seed differs from the frozen choice');
    return success({ genesisSeed: transcript.seed, transcript });
  }
  if (transcript.kind !== 'joint')
    return failure('genesis-seed-mode', 'Joint seed transcript is required');
  if (
    transcript.commits.length !== scope.participants.length ||
    transcript.reveals.length !== scope.participants.length
  )
    return failure('genesis-seed-roster', 'Every seed seat must commit and reveal once');
  const shares: string[] = [];
  for (const [index, participant] of scope.participants.entries()) {
    const commit = transcript.commits[index];
    const reveal = transcript.reveals[index];
    if (
      !commit ||
      !reveal ||
      commit.body.seat !== participant.seat ||
      reveal.body.seat !== participant.seat ||
      commit.body.freezeHash !== scope.freezeHash ||
      reveal.body.freezeHash !== scope.freezeHash ||
      commit.body.ceremonyNonce !== scope.ceremonyNonce ||
      reveal.body.ceremonyNonce !== scope.ceremonyNonce ||
      commit.body.commit !==
        shareCommit(scope.ceremonyNonce, participant.seat, reveal.body.share) ||
      !verifyObject(
        'genesis-seed-commit-v1',
        commit.body,
        commit.sig,
        parsePeerId(participant.publicKey),
      ) ||
      !verifyObject(
        'genesis-seed-reveal-v1',
        reveal.body,
        reveal.sig,
        parsePeerId(participant.publicKey),
      )
    )
      return failure('genesis-seed-proof', 'Seed packets do not match the exact signed roster');
    shares.push(reveal.body.share);
  }
  return success({
    genesisSeed: toBase64Url(
      hashValue({ domain: 'cp2p/v1/genesis-seed', ceremonyId: scope.ceremonyId, shares }),
    ),
    transcript,
  });
}
