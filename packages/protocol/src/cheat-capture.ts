import type { Seat } from '@cp2p/engine';
import * as v from 'valibot';
import type { CheatClaim, CheatKind, RawSignedArtifact } from './cheat-types.js';
import { entryHash, genesisDigest } from './genesis.js';
import type { LogContext } from './log-types.js';
import {
  hashSchema,
  key32Schema,
  positiveIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { parseCanonical } from './validation.js';
import { decodeMessage } from './wire.js';

const signed = v.strictObject({ body: v.unknown(), sig: signature64Schema });
const signedList = v.pipe(v.array(signed), v.maxLength(6));
const unlocks = v.pipe(v.array(signed), v.minLength(1), v.maxLength(5));
const payloadSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('command'), signed }),
  v.strictObject({
    kind: v.literal('crypto'),
    action: v.picklist(['beacon-fixed', 'deck-pass', 'steal-fixed', 'steal-dispute']),
    evidence: v.unknown(),
  }),
  v.strictObject({
    kind: v.literal('system'),
    input: v.unknown(),
    evidence: v.variant('protocol', [
      v.strictObject({
        kind: v.literal('proof'),
        protocol: v.literal('beacon-v1'),
        data: signedList,
      }),
      v.strictObject({
        kind: v.literal('proof'),
        protocol: v.literal('deck-draw-v1'),
        data: unlocks,
      }),
      v.strictObject({
        kind: v.literal('proof'),
        protocol: v.literal('monopoly-count-v1'),
        data: signed,
      }),
    ]),
  }),
]);

// This only extracts signed artifacts. It never admits a malformed wire message
// for gameplay, nor turns a rejected envelope into a finding by itself.
const rejectedMessageSchema = v.variant('t', [
  v.strictObject({ t: v.literal('SUBMIT'), cmd: signed }),
  v.strictObject({
    t: v.literal('SYS_CONTRIB'),
    genesisDigest: key32Schema,
    contribution: v.strictObject({ kind: v.literal('beacon-reveal'), signed }),
  }),
  v.strictObject({
    t: v.literal('DECK_CONTRIB'),
    genesisDigest: key32Schema,
    contribution: v.strictObject({
      kind: v.literal('deck-unlock'),
      operationId: hashSchema,
      unlocks,
    }),
  }),
  v.strictObject({
    t: v.literal('COUNT_CONTRIB'),
    genesisDigest: key32Schema,
    contribution: signed,
  }),
  v.strictObject({
    t: v.literal('STEAL_CONTRIB'),
    genesisDigest: key32Schema,
    contribution: signed,
  }),
  v.strictObject({
    t: v.literal('STEAL_RESPONSE'),
    genesisDigest: key32Schema,
    response: v.strictObject({ kind: v.literal('dispute'), value: signed }),
  }),
  v.strictObject({ t: v.literal('PROPOSAL'), proposal: signed }),
]);

function artifactSeat(artifact: RawSignedArtifact): Seat | null {
  const body = parseCanonical(artifact.body, v.objectWithRest({ seat: seatSchema }, v.unknown()));
  return body.ok ? body.value.seat : null;
}

function candidate(
  kind: Exclude<CheatKind, 'deck-unlock'>,
  artifact: RawSignedArtifact,
  context: LogContext,
  seat = artifactSeat(artifact),
): CheatClaim[] {
  return seat === null
    ? []
    : [
        {
          seat,
          evidence: {
            kind,
            artifact,
            at: { seq: context.head.seq, hash: entryHash(context.head) },
          },
        },
      ];
}

function unlockCandidates(items: RawSignedArtifact[], context: LogContext): CheatClaim[] {
  return items.flatMap((artifact, index) => {
    const seat = artifactSeat(artifact);
    return seat === null
      ? []
      : [
          {
            seat,
            evidence: {
              kind: 'deck-unlock' as const,
              artifact,
              prefix: items.slice(0, index),
              at: { seq: context.head.seq, hash: entryHash(context.head) },
            },
          },
        ];
  });
}

function payloadCandidates(value: unknown, context: LogContext): CheatClaim[] {
  const parsed = parseCanonical(value, payloadSchema);
  if (!parsed.ok) return [];
  const payload = parsed.value;
  if (payload.kind === 'command') return candidate('command-proof', payload.signed, context);
  if (payload.kind === 'system') {
    const evidence = payload.evidence;
    switch (evidence.protocol) {
      case 'beacon-v1':
        return evidence.data.flatMap((item) => candidate('beacon-reveal', item, context));
      case 'deck-draw-v1':
        return unlockCandidates(evidence.data, context);
      case 'monopoly-count-v1':
        return candidate('count-proof', evidence.data, context);
    }
  }
  if (payload.action === 'beacon-fixed') {
    const items = parseCanonical(payload.evidence, signedList);
    return items.ok ? items.value.flatMap((item) => candidate('beacon-reveal', item, context)) : [];
  }
  if (payload.action === 'deck-pass') {
    const wrapper = parseCanonical(
      payload.evidence,
      v.strictObject({ deckId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)), pass: signed }),
    );
    return wrapper.ok ? candidate('deck-pass', wrapper.value.pass, context) : [];
  }
  const artifact = parseCanonical(payload.evidence, signed);
  if (!artifact.ok) return [];
  switch (payload.action) {
    case 'steal-fixed':
      return candidate('steal-contribution', artifact.value, context);
    case 'steal-dispute':
      return candidate(
        'false-steal-dispute',
        artifact.value,
        context,
        context.crypto?.steal?.operation.thief.seat ?? null,
      );
  }
  return [];
}

/**
 * Consensus-critical extraction under PROTOCOL_VERSION, also used for capture.
 * Changes to accepted proof shapes require a protocol version change. Candidates
 * are detached and bounded; every result still requires verifyCheatProof.
 */
export function rejectedProofCandidates(value: unknown, context: LogContext): CheatClaim[] {
  if (context.genesis.security !== 'verified' || !context.crypto) return [];
  const parsed = parseCanonical(value, rejectedMessageSchema);
  if (!parsed.ok) return [];
  const message = parsed.value;
  if ('genesisDigest' in message && message.genesisDigest !== genesisDigest(context.genesis))
    return [];
  switch (message.t) {
    case 'SUBMIT':
      return candidate('command-proof', message.cmd, context);
    case 'SYS_CONTRIB':
      return candidate('beacon-reveal', message.contribution.signed, context);
    case 'DECK_CONTRIB':
      return unlockCandidates(message.contribution.unlocks, context);
    case 'COUNT_CONTRIB':
      return candidate('count-proof', message.contribution, context);
    case 'STEAL_CONTRIB':
      return candidate('steal-contribution', message.contribution, context);
    case 'STEAL_RESPONSE':
      return candidate(
        'false-steal-dispute',
        message.response.value,
        context,
        context.crypto.steal?.operation.thief.seat ?? null,
      );
    case 'PROPOSAL': {
      const body = parseCanonical(
        message.proposal.body,
        v.objectWithRest(
          {
            genesisDigest: key32Schema,
            entry: v.objectWithRest(
              { seq: positiveIntegerSchema, prevHash: hashSchema, payload: v.unknown() },
              v.unknown(),
            ),
          },
          v.unknown(),
        ),
      );
      return body.ok &&
        body.value.genesisDigest === genesisDigest(context.genesis) &&
        body.value.entry.seq === context.head.seq + 1 &&
        body.value.entry.prevHash === entryHash(context.head)
        ? payloadCandidates(body.value.entry.payload, context)
        : [];
    }
  }
  return [];
}

/** Preserve malformed inner proofs without relaxing the normal wire decoder. */
export function rejectedWireProofCandidates(bytes: Uint8Array, context: LogContext): CheatClaim[] {
  const decoded = decodeMessage(bytes, rejectedMessageSchema);
  return decoded.ok ? rejectedProofCandidates(decoded.value, context) : [];
}

/** A valid delivery dispute attributes the victim only after it is certified. */
export function certifiedDeliveryClaim(context: LogContext): CheatClaim | null {
  const steal = context.crypto?.steal;
  return steal?.dispute
    ? (candidate('bad-steal-delivery', steal.dispute, context, steal.operation.victim.seat)[0] ??
        null)
    : null;
}
