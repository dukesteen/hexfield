import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Engine, GameEvent, Input, Result } from '@cp2p/engine';
import { entryHash, genesisDigest, validateGenesisEntry } from './genesis.js';
import type { GenesisPolicy } from './genesis.js';
import { validateCertifiedEntry } from './proposal.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';

export interface ReplayPolicy {
  genesis: GenesisPolicy;
  entry: ProposalContext['policy'];
}

export interface ReplayedPrefix {
  context: ProposalContext;
  entries: CertifiedEntry[];
  inputs: Input[];
  events: GameEvent[];
}

/** Genesis signatures establish the first voter set; transport peers have no say. */
export function initialProposalContext(
  genesisEntry: unknown,
  engine: Engine,
  policy: ReplayPolicy,
): Result<ProposalContext> {
  const checked = validateGenesisEntry(genesisEntry, engine, policy.genesis);
  if (!checked.ok) return checked;
  const { genesis, state, entry } = checked.value;
  return success({
    log: { genesis, engine, state, head: entry, lastNonces: new Map() },
    membership: {
      genesisDigest: genesisDigest(genesis),
      epoch: 0,
      voters: genesis.seats
        .filter((seat) => seat.kind === 'human')
        .map(({ seat, publicKey }) => ({ seat, publicKey })),
    },
    excludedProposers: [],
    policy: policy.entry,
  });
}

/** Replay certificates in order. A claimed snapshot never supplies voter or nonce state. */
export function replayCertifiedPrefix(
  genesisEntry: unknown,
  entries: readonly unknown[],
  engine: Engine,
  policy: ReplayPolicy,
): Result<ReplayedPrefix> {
  const initial = initialProposalContext(genesisEntry, engine, policy);
  if (!initial.ok) return initial;
  let context = initial.value;
  const certified: CertifiedEntry[] = [];
  const inputs: Input[] = [];
  const events: GameEvent[] = [];
  for (const entry of entries) {
    const checked = validateCertifiedEntry(entry, context);
    if (!checked.ok) return checked;
    const next = checked.value;
    certified.push({ entry: next.entry, certificate: next.certificate });
    inputs.push(next.input);
    events.push(...next.events);
    context = {
      ...context,
      log: {
        ...context.log,
        head: next.entry,
        state: next.state,
        lastNonces: next.lastNonces,
      },
    };
  }
  return success({ context, entries: certified, inputs, events });
}

/** A cache for display/load speed, always checked against the certified replay before voting. */
export function snapshotFromContext(context: ProposalContext) {
  return canonicalDecode(
    canonicalEncode({
      genesisDigest: context.membership.genesisDigest,
      seq: context.log.head.seq,
      hash: entryHash(context.log.head),
      state: context.log.state,
      lastNonces: [...context.log.lastNonces].toSorted(([a], [b]) => a - b),
      membership: context.membership,
      excludedProposers: context.excludedProposers,
    }),
  );
}

export function verifyReplaySnapshot(value: unknown, context: ProposalContext): Result<void> {
  try {
    return toHex(hashValue(value)) === toHex(hashValue(snapshotFromContext(context)))
      ? success(undefined)
      : failure('snapshot-mismatch', 'Snapshot differs from the certified replay');
  } catch {
    return failure('snapshot-malformed', 'Snapshot is not canonical data');
  }
}
