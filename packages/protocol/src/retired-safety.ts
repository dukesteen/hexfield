import { hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { restoreConsensusState } from './consensus.js';
import { entryHash } from './genesis.js';
import { advanceContext, validateCertifiedEntry } from './proposal.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  seatSchema,
} from './schema-values.js';
import { parseCanonical } from './validation.js';

const retiredSafetySchema = v.strictObject({
  kind: v.literal('retired-controller'),
  version: v.literal(1),
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  height: positiveIntegerSchema,
  parentHash: hashSchema,
  localSeat: seatSchema,
  localPublicKey: key32Schema,
  lastVotingStateHash: hashSchema,
});

/** A terminal local signing record, never accepted by ConsensusController. */
export type RetiredSafety = v.InferOutput<typeof retiredSafetySchema>;

/** Persist this marker and the removal certificate in the same journal transaction. */
export function createRetiredSafety(
  previous: ProposalContext,
  certified: CertifiedEntry,
  localSeat: Seat,
  priorSafety: unknown,
): Result<RetiredSafety> {
  const prior = restoreConsensusState(priorSafety, previous, localSeat);
  if (!prior.ok) return prior;
  const checked = validateCertifiedEntry(certified, previous);
  if (!checked.ok) return checked;
  const advanced = advanceContext(previous, checked.value);
  if (!advanced.ok) return advanced;
  const next = advanced.value;
  const marker: RetiredSafety = {
    kind: 'retired-controller',
    version: 1,
    genesisDigest: next.membership.genesisDigest,
    epoch: next.membership.epoch,
    height: next.log.head.seq + 1,
    parentHash: entryHash(next.log.head),
    localSeat,
    localPublicKey: prior.value.localPublicKey,
    lastVotingStateHash: toHex(hashValue(prior.value)),
  };
  return restoreRetiredSafety(marker, next, localSeat, prior.value.localPublicKey);
}

/** Replay supplies authority; a marker alone can neither remove nor activate a voter. */
export function restoreRetiredSafety(
  value: unknown,
  context: ProposalContext,
  localSeat: Seat,
  publicKey: string,
): Result<RetiredSafety> {
  const parsed = parseCanonical(value, retiredSafetySchema);
  if (!parsed.ok) return parsed;
  const marker = parsed.value;
  const controller = context.log.authority?.controllers.find((item) => item.seat === localSeat);
  if (
    marker.genesisDigest !== context.membership.genesisDigest ||
    marker.epoch !== context.membership.epoch ||
    marker.height !== context.log.head.seq + 1 ||
    marker.parentHash !== entryHash(context.log.head) ||
    marker.localSeat !== localSeat ||
    marker.localPublicKey !== publicKey ||
    context.membership.voters.some((member) => member.publicKey === publicKey) ||
    !controller ||
    (controller.kind !== 'bot' && controller.publicKey === publicKey) ||
    !context.log.authority?.usedPublicKeys.includes(publicKey)
  )
    return failure('replica-retirement', 'Retired signing record differs from certified removal');
  return success(marker);
}
