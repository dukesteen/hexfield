import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Engine, GameEvent, Input, Result } from '@cp2p/engine';
import { entryHash, genesisDigest, validateGenesisEntry } from './genesis.js';
import { objectiveEvidenceSeq, validateObjectiveAccusation } from './control.js';
import { initializeCryptoContext } from './crypto-context.js';
import type { GenesisPolicy } from './genesis.js';
import type { ValidatedEntry } from './log.js';
import { advanceContext, proposerFor, validateCertifiedEntry } from './proposal.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import { authenticatedCheatSigner, verifyCheatProof } from './cheat-proof.js';
import type { CheatFinding } from './cheat-proof.js';
import { initialSeatAuthorities } from './authority.js';
import { advanceTimerAnchors } from './turn-timeout.js';

const MAX_HISTORICAL_CONTEXTS = 16;

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
  const authority = initialSeatAuthorities(genesis);
  if (!authority.ok) return authority;
  const crypto = initializeCryptoContext(
    genesis,
    engine,
    state,
    entry,
    policy.entry.randomDerivations,
    authority.value,
  );
  if (!crypto.ok) return crypto;
  const timers = advanceTimerAnchors(engine, state, entry);
  if (!timers.ok) return timers;
  return success({
    log: {
      genesis,
      engine,
      state,
      head: entry,
      lastNonces: new Map(),
      crypto: crypto.value,
      timers: timers.value,
      authority: authority.value,
      recovery: { authorizations: [], pending: null, completed: [] },
    },
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
  onEntry?: (entry: ValidatedEntry & CertifiedEntry, next: ProposalContext) => Result<void>,
): Result<ReplayedPrefix> {
  return replayCertifiedPrefixWithCache(genesisEntry, entries, engine, policy, new Map(), onEntry);
}

/** Successful findings are shared only within this certified ancestry. */
function replayCertifiedPrefixWithCache(
  genesisEntry: unknown,
  entries: readonly unknown[],
  engine: Engine,
  policy: ReplayPolicy,
  verifiedFindings: Map<string, CheatFinding>,
  onEntry?: (entry: ValidatedEntry & CertifiedEntry, next: ProposalContext) => Result<void>,
): Result<ReplayedPrefix> {
  const initial = initialProposalContext(genesisEntry, engine, policy);
  if (!initial.ok) return initial;
  const certified: CertifiedEntry[] = [];
  const historical = new Map<number, ProposalContext>();
  const cheatHistorical = new Map<number, ProposalContext>();
  const controllerTimeline = [
    {
      atSeq: 0,
      authority: initial.value.log.authority,
      epoch: initial.value.log.crypto?.epoch ?? initial.value.log.authority?.epoch ?? 0,
    },
  ];
  let context: ProposalContext = {
    ...initial.value,
    verifyHistoricalCheat: (claim) => {
      const atSeq = claim.evidence.at.seq;
      if (atSeq > certified.length)
        return failure('cheat-history', 'Certified evidence parent is unavailable');
      const parentEntry = atSeq === 0 ? initial.value.log.head : certified[atSeq - 1]?.entry;
      if (!parentEntry || claim.evidence.at.hash !== entryHash(parentEntry))
        return failure('cheat-history', 'Certified evidence parent hash does not match');
      const parentAuthority = controllerTimeline.findLast((item) => item.atSeq <= atSeq);
      if (
        !parentAuthority ||
        !authenticatedCheatSigner(
          claim,
          initial.value.log.genesis,
          parentAuthority.authority,
          parentAuthority.epoch,
        )
      )
        return failure('cheat-signature', 'Cheat evidence has no authenticated controller');
      const key = toHex(hashValue({ domain: 'cp2p/v1/cheat-claim-cache', claim }));
      const previous = verifiedFindings.get(key);
      if (previous) return success(previous);
      let parent = cheatHistorical.get(atSeq);
      if (!parent) {
        const replayed = replayCertifiedPrefixWithCache(
          genesisEntry,
          certified.slice(0, atSeq),
          engine,
          policy,
          verifiedFindings,
        );
        if (!replayed.ok) return replayed;
        parent = replayed.value.context;
      }
      cheatHistorical.delete(atSeq);
      cheatHistorical.set(atSeq, parent);
      if (cheatHistorical.size > MAX_HISTORICAL_CONTEXTS) {
        const oldest = cheatHistorical.keys().next().value;
        if (oldest !== undefined) cheatHistorical.delete(oldest);
      }
      return verifyCheatProof(claim, parent.log);
    },
    verifyHistoricalAccusation: (control) => {
      const atSeq = objectiveEvidenceSeq(control);
      if (atSeq < 1 || atSeq - 1 > certified.length)
        return failure('control-history', 'Certified evidence parent is unavailable');
      let parent = historical.get(atSeq);
      if (!parent) {
        const replayed = replayCertifiedPrefixWithCache(
          genesisEntry,
          certified.slice(0, atSeq - 1),
          engine,
          policy,
          verifiedFindings,
        );
        if (!replayed.ok) return replayed;
        parent = replayed.value.context;
      }
      // Pending proofs and round hints can reference different certified parents.
      // Keep recent parents together without retaining the whole game state history.
      historical.delete(atSeq);
      historical.set(atSeq, parent);
      if (historical.size > MAX_HISTORICAL_CONTEXTS) {
        const oldest = historical.keys().next().value;
        if (oldest !== undefined) historical.delete(oldest);
      }
      const checked = validateObjectiveAccusation(control, {
        log: parent.log,
        commandPolicy: parent.policy,
        membership: parent.membership,
        excludedProposers: parent.excludedProposers,
        proposerFor: (seq, term) =>
          proposerFor(seq, term, parent.membership, parent.excludedProposers),
      });
      return checked.ok ? success(entryHash(parent.log.head)) : checked;
    },
  };
  const inputs: Input[] = [];
  const events: GameEvent[] = [];
  for (const entry of entries) {
    const checked = validateCertifiedEntry(entry, context);
    if (!checked.ok) return checked;
    const next = checked.value;
    if (next.entry.payload.kind === 'cheat-proof') {
      const claim = next.entry.payload.claim;
      const finding = next.crypto?.cheats.find(
        (item) => item.seat === claim.seat && item.kind === claim.evidence.kind,
      );
      if (!finding)
        return failure('cheat-replay', 'Certified cheat record has no replayed finding');
      verifiedFindings.set(
        toHex(hashValue({ domain: 'cp2p/v1/cheat-claim-cache', claim })),
        finding,
      );
    }
    certified.push({ entry: next.entry, certificate: next.certificate });
    if (next.input !== null) inputs.push(next.input);
    events.push(...next.events);
    const advanced = advanceContext(context, next);
    if (!advanced.ok) return advanced;
    if (advanced.value.log.authority !== context.log.authority) {
      controllerTimeline.push({
        atSeq: next.entry.seq,
        authority: advanced.value.log.authority,
        epoch: advanced.value.log.crypto?.epoch ?? advanced.value.log.authority?.epoch ?? 0,
      });
    }
    const visited = onEntry?.(next, advanced.value);
    if (visited && !visited.ok) return visited;
    context = advanced.value;
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
      crypto: context.log.crypto,
      authority: context.log.authority ?? null,
      recovery: context.log.recovery ?? null,
      timers: context.log.timers ?? [],
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
