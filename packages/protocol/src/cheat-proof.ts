import { hashValue, toHex } from '@cp2p/codec';
import { decodePoint, parsePeerId, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { permitsFrozenOperation, resolveArtifactSigner } from './authority.js';
import type { ArtifactSigner, SeatAuthorities } from './authority-types.js';
import { beaconOperationId, verifyBeaconReveal } from './beacon.js';
import { getBeaconOperation } from './beacon-state.js';
import type { EntryRef } from './beacon-state.js';
import { countOperationId, verifyCountContribution } from './count-reveal.js';
import { MAX_HAND_RESOURCE_COUNT } from './hand-commitments.js';
import {
  deckDrawOperationId,
  deckUnlockers,
  deckUnlockSchema,
  verifyDeckUnlock,
  verifyDeckUnlockPrefix,
} from './deck-draw.js';
import { deckPassHash } from './deck-genesis.js';
import { applyDeckPass, deckPassOperationId } from './deck-setup.js';
import { entryHash, genesisDigest } from './genesis.js';
import { readCommandProofs } from './command-proofs.js';
import { validateCommandForEntry, validateCommandStatement } from './command-validation.js';
import type { LogContext } from './log-types.js';
import type { Genesis } from './types.js';
import type { CheatClaim, CheatFinding, RawSignedArtifact } from './cheat-types.js';
import { hashSchema, nonnegativeIntegerSchema, seatSchema } from './schema-values.js';
import {
  signedStealContributionSchema,
  signedStealDisputeSchema,
  stealReceiptBinding,
  stealOperationId,
  verifyStealContribution,
  verifyStealDispute,
} from './steal-delivery.js';
import { parseCanonical } from './validation.js';
import { cheatClaimSchema } from './cheat-schema.js';

export type {
  RawSignedArtifact,
  CheatKind,
  CheatEvidence,
  CheatClaim,
  CheatFinding,
} from './cheat-types.js';

const operationRouteSchema = v.objectWithRest(
  { operationId: hashSchema, seat: seatSchema },
  v.unknown(),
);
const countBodyRouteSchema = v.strictObject({
  operationId: hashSchema,
  seat: seatSchema,
  count: v.pipe(nonnegativeIntegerSchema, v.maxValue(MAX_HAND_RESOURCE_COUNT)),
  proof: v.unknown(),
});
const stealBodyRouteSchema = v.strictObject({
  ...signedStealContributionSchema.entries.body.entries,
  ephemeralProof: v.unknown(),
  proof: v.unknown(),
});
const unlockBodyRouteSchema = v.strictObject({
  ...deckUnlockSchema.entries.body.entries,
  proof: v.unknown(),
});
const PROOF_FAILURES = new Set([
  'command-proofs-required',
  'command-proofs-count',
  'command-proofs-invalid',
  'hand-proof-count',
  'hand-proof-obligation',
  'hand-proof-invalid',
  'deck-reveal-proof',
  'deck-reveal-kind',
]);

function unproven(): Result<never> {
  return failure('cheat-unproven', 'The signed evidence does not objectively prove a bad proof');
}

function authenticated(artifact: RawSignedArtifact, domain: string, publicKey: string): boolean {
  try {
    return verifyObject(domain, artifact.body, artifact.sig, parsePeerId(publicKey));
  } catch {
    return false;
  }
}

function validSealedEphemeral(point: string): boolean {
  try {
    decodePoint(point, { nonIdentity: true });
    return true;
  } catch {
    return false;
  }
}

/** Cheap historical gate; the full verifier checks the signer’s frozen role. */
export function authenticatedCheatSigner(
  claim: CheatClaim,
  genesis: Genesis,
  authority?: SeatAuthorities,
  epoch = authority?.epoch ?? 0,
): boolean {
  const domain =
    claim.evidence.kind === 'command-proof'
      ? 'cmd'
      : claim.evidence.kind === 'beacon-reveal'
        ? 'beacon-reveal'
        : claim.evidence.kind === 'deck-pass'
          ? 'deck-pass'
          : claim.evidence.kind === 'deck-unlock'
            ? 'deck-unlock'
            : claim.evidence.kind === 'count-proof'
              ? 'monopoly-count'
              : claim.evidence.kind === 'steal-contribution'
                ? 'steal-contribution'
                : 'steal-dispute';
  const seats =
    claim.evidence.kind === 'bad-steal-delivery'
      ? genesis.seats
      : genesis.seats.filter((seat) => seat.seat === claim.seat);
  return seats.some(({ seat }) => {
    const signer = resolveArtifactSigner(authority, genesis, epoch, seat);
    return signer.ok && authenticated(claim.evidence.artifact, domain, signer.value.publicKey);
  });
}

function frozenAtParent(
  operation: { genesisDigest: string; epoch: number; anchor: EntryRef },
  context: LogContext,
  kind: 'beacon' | 'deck' | 'count' | 'steal',
  id: string,
): boolean {
  return (
    operation.genesisDigest === genesisDigest(context.genesis) &&
    context.crypto !== null &&
    permitsFrozenOperation(context.authority, kind, id, operation, context.crypto.epoch) &&
    operation.anchor.seq <= context.head.seq
  );
}

function currentSigner(context: LogContext, seat: Seat): Result<ArtifactSigner> {
  return resolveArtifactSigner(
    context.authority,
    context.genesis,
    context.crypto?.epoch ?? context.authority?.epoch ?? 0,
    seat,
  );
}

function operationRoute(artifact: RawSignedArtifact): Result<{ operationId: string; seat: Seat }> {
  const routed = parseCanonical(artifact.body, operationRouteSchema);
  return routed.ok
    ? success({ operationId: routed.value.operationId, seat: routed.value.seat })
    : routed;
}

function badCommandProof(artifact: RawSignedArtifact, context: LogContext): Result<Seat> {
  const statement = validateCommandStatement(artifact, context);
  if (!statement.ok || !statement.value.plan) return unproven();
  const { body } = statement.value.signed;
  const plan = statement.value.plan;
  const requiresProof =
    plan.obligations.length > 0 ||
    plan.effects.some((effect) => effect.type === 'card-slot-revealed');
  if (!requiresProof) return unproven();
  const sections = readCommandProofs(body.evidence, plan);
  if (!sections.ok)
    return PROOF_FAILURES.has(sections.error.code) ? success(body.seat) : unproven();
  const checked = validateCommandForEntry(artifact, context, {});
  return !checked.ok && PROOF_FAILURES.has(checked.error.code) ? success(body.seat) : unproven();
}

/** Verify against the certified parent named by `at`; historical callers replay to it first. */
export function verifyCheatProof(value: unknown, context: LogContext): Result<CheatFinding> {
  const parsed = parseCanonical(value, cheatClaimSchema);
  if (!parsed.ok) return parsed;
  const claim = parsed.value;
  const { evidence } = claim;
  if (
    evidence.at.seq !== context.head.seq ||
    evidence.at.hash !== entryHash(context.head) ||
    toHex(hashValue(context.state)) !== context.head.stateHash ||
    context.engine.checkInvariants(context.state).length !== 0 ||
    context.genesis.security !== 'verified' ||
    !context.crypto
  )
    return unproven();
  const crypto = context.crypto;
  const artifact = evidence.artifact;
  let offender: Seat | null = null;
  try {
    if (evidence.kind === 'command-proof') {
      const result = badCommandProof(artifact, context);
      if (result.ok) offender = result.value;
    } else if (evidence.kind === 'beacon-reveal') {
      const operation = getBeaconOperation(crypto.beacon);
      const route = operationRoute(artifact);
      if (
        operation.ok &&
        route.ok &&
        route.value.operationId === beaconOperationId(operation.value) &&
        frozenAtParent(operation.value, context, 'beacon', route.value.operationId)
      ) {
        const owner = operation.value.participants.find((item) => item.seat === route.value.seat);
        const signer = owner && currentSigner(context, owner.seat);
        if (signer?.ok && authenticated(artifact, 'beacon-reveal', signer.value.publicKey)) {
          const checked = verifyBeaconReveal(artifact, operation.value, signer.value);
          if (!checked.ok && checked.error.code === 'beacon-link') offender = signer.value.seat;
        }
      }
    } else if (evidence.kind === 'deck-pass') {
      const deck = crypto.decks.decks.find(
        (item) => item.nextPass < item.commitment.passHashes.length,
      );
      const route = operationRoute(artifact);
      if (deck && route.ok && route.value.operationId === deckPassOperationId(deck.setup)) {
        const owner = deck.setup.definition.participants.find(
          (item) => item.seat === route.value.seat,
        );
        if (
          owner &&
          authenticated(artifact, 'deck-pass', owner.publicKey) &&
          owner.seat ===
            deck.setup.definition.participants[
              deck.nextPass % deck.setup.definition.participants.length
            ]?.seat &&
          deckPassHash(artifact) === deck.commitment.passHashes[deck.nextPass]
        ) {
          const applied = applyDeckPass(deck.setup, artifact);
          if (!applied.ok && ['deck-shuffle-proof', 'deck-lock-proof'].includes(applied.error.code))
            offender = owner.seat;
        }
      }
    } else if (evidence.kind === 'deck-unlock') {
      const operation = crypto.decks.active;
      const route = operationRoute(artifact);
      if (
        operation &&
        route.ok &&
        route.value.operationId === deckDrawOperationId(operation) &&
        frozenAtParent(operation, context, 'deck', route.value.operationId) &&
        evidence.prefix.length < operation.participants.length
      ) {
        const owner = deckUnlockers(operation)[evidence.prefix.length];
        const shaped = parseCanonical(artifact.body, unlockBodyRouteSchema);
        const expected = deckUnlockers(operation);
        const signers = expected.map((item) => currentSigner(context, item.seat));
        const signer = signers[evidence.prefix.length];
        if (
          owner?.seat === route.value.seat &&
          shaped.ok &&
          shaped.value.step === evidence.prefix.length &&
          signer?.ok &&
          authenticated(artifact, 'deck-unlock', signer.value.publicKey) &&
          signers.every((item) => item.ok)
        ) {
          const activeSigners = signers.flatMap((item) => (item.ok ? [item.value] : []));
          const prefix = verifyDeckUnlockPrefix(operation, evidence.prefix, activeSigners);
          if (!prefix.ok) return unproven();
          const checked = verifyDeckUnlock(
            operation,
            prefix.value.unlocks,
            artifact,
            activeSigners,
          );
          if (!checked.ok && ['deck-unlock-proof', 'invalid-envelope'].includes(checked.error.code))
            offender = owner.seat;
        }
      }
    } else if (evidence.kind === 'count-proof') {
      const pending = crypto.counts;
      const route = operationRoute(artifact);
      if (
        pending &&
        route.ok &&
        pending.remaining.includes(route.value.seat) &&
        route.value.operationId === countOperationId(pending.operation) &&
        frozenAtParent(pending.operation, context, 'count', route.value.operationId)
      ) {
        const owner = pending.operation.victims.find((item) => item.seat === route.value.seat);
        const shaped = parseCanonical(artifact.body, countBodyRouteSchema);
        const signer = owner && currentSigner(context, owner.seat);
        if (
          signer?.ok &&
          shaped.ok &&
          authenticated(artifact, 'monopoly-count', signer.value.publicKey)
        ) {
          const checked = verifyCountContribution(artifact, pending.operation, signer.value);
          if (!checked.ok && ['count-proof', 'invalid-envelope'].includes(checked.error.code))
            offender = signer.value.seat;
        }
      }
    } else if (evidence.kind === 'steal-contribution') {
      const pending = crypto.steal;
      const route = operationRoute(artifact);
      if (
        pending &&
        !pending.fixed &&
        !pending.dispute &&
        route.ok &&
        route.value.seat === pending.operation.victim.seat &&
        route.value.operationId === stealOperationId(pending.operation) &&
        frozenAtParent(pending.operation, context, 'steal', route.value.operationId)
      ) {
        const owner = pending.operation.victim;
        const shaped = parseCanonical(artifact.body, stealBodyRouteSchema);
        const signer = currentSigner(context, owner.seat);
        if (
          signer.ok &&
          shaped.ok &&
          authenticated(artifact, 'steal-contribution', signer.value.publicKey)
        ) {
          const complete = parseCanonical(artifact, signedStealContributionSchema);
          if (!complete.ok) offender = owner.seat;
          else if (!validSealedEphemeral(complete.value.body.sealed.ephemeral))
            offender = owner.seat;
          else {
            const checked = verifyStealContribution(artifact, pending.operation, signer.value);
            if (
              !checked.ok &&
              ['steal-ephemeral-proof', 'steal-transfer-proof', 'invalid-envelope'].includes(
                checked.error.code,
              )
            )
              offender = owner.seat;
          }
        }
      }
    } else {
      const pending = crypto.steal;
      if (
        pending?.fixed &&
        frozenAtParent(pending.operation, context, 'steal', stealOperationId(pending.operation))
      ) {
        const shaped = parseCanonical(artifact, signedStealDisputeSchema);
        const signer = currentSigner(context, pending.operation.thief.seat);
        if (
          !shaped.ok ||
          toHex(hashValue(shaped.value.body.binding)) !==
            toHex(hashValue(stealReceiptBinding(pending.fixed))) ||
          !signer.ok ||
          !authenticated(artifact, 'steal-dispute', signer.value.publicKey) ||
          (crypto.epoch > 0 && !pending.fixed.signer)
        )
          return unproven();
        if (
          !verifyStealContribution(
            pending.fixed.contribution,
            pending.operation,
            pending.fixed.signer,
          ).ok
        )
          return unproven();
        if (evidence.kind === 'bad-steal-delivery') {
          if (
            pending.dispute &&
            toHex(hashValue(pending.dispute)) === toHex(hashValue(artifact)) &&
            verifyStealDispute(artifact, pending.fixed, signer.value).ok
          )
            offender = pending.operation.victim.seat;
        } else if (!pending.dispute) {
          const checked = verifyStealDispute(artifact, pending.fixed, signer.value);
          if (!checked.ok && checked.error.code === 'steal-good-delivery')
            offender = pending.operation.thief.seat;
        }
      }
    }
  } catch {
    return unproven();
  }
  if (offender === null || offender !== claim.seat) return unproven();
  return success({
    seat: offender,
    kind: evidence.kind,
    at: evidence.at,
    evidenceId: toHex(hashValue({ domain: 'cp2p/v1/cheat-evidence', evidence })),
  });
}

/** Compact replay summary; the complete signed evidence stays in certified history. */
export function firstCheatFindings(
  findings: readonly CheatFinding[],
  next: CheatFinding,
  seats: readonly Seat[],
): readonly CheatFinding[] {
  if (
    !seats.includes(next.seat) ||
    findings.length >= seats.length * 8 ||
    findings.some((item) => item.seat === next.seat && item.kind === next.kind)
  )
    return findings;
  return [...findings, next];
}
