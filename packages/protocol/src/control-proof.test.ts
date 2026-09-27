import { toBase64Url } from '@cp2p/codec';
import { signObject } from '@cp2p/crypto';
import { failure } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { beaconOperationId } from './beacon.js';
import { getBeaconOperation } from './beacon-state.js';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { rejectedProofCandidates } from './cheat-capture.js';
import { createConsensusState, stageAccusation } from './consensus.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { entryHash, signEntry } from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import { proposerFor, signProposal, validateObjectiveForProposal } from './proposal.js';
import { initialProposalContext, replayCertifiedPrefix } from './replay.js';
import { ReplicatedLog } from './replicated-log.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import { createVerifiedDeckSession } from './testing/verified-deck-session.js';
import type { Transport } from './transport.js';
import type { ExcludeProposerControl, LogEntry, SignedProposal } from './types.js';
import { signVote } from './votes.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing proof-control fixture value');
  return item;
}

const fixture = createVerifiedDeckSession(317, 4, 2);
const context = value(
  initialProposalContext(fixture.entry, fixture.simulation.engine, fixture.policy),
);
const operation = value(getBeaconOperation(required(context.log.crypto).beacon));
const identity = (seat: Seat) => required(fixture.simulation.identities.get(seat));

function proposal(
  options: { valid?: boolean; operationId?: string; forged?: boolean; index?: number } = {},
) {
  const body = {
    operationId: options.operationId ?? beaconOperationId(operation),
    seat: 1 as const,
    index: options.index ?? 1,
    value: toBase64Url(
      options.valid
        ? required(fixture.chains[1]?.[options.index ?? 1])
        : new Uint8Array(32).fill(211),
    ),
  };
  const artifact = {
    body,
    sig: signObject('beacon-reveal', body, identity(options.forged ? 2 : 1).secretKey),
  };
  const entry = signEntry(
    {
      seq: 1,
      term: 1,
      prevHash: entryHash(context.log.head),
      payload: { kind: 'crypto', action: 'beacon-fixed', evidence: [artifact] },
      stateHash: context.log.head.stateHash,
      sequencer: identity(0).peerId,
    },
    identity(0).secretKey,
  );
  return signProposal(
    {
      genesisDigest: context.membership.genesisDigest,
      epoch: 0,
      entry,
      validRound: null,
      prevotes: [],
    },
    identity(0).secretKey,
  );
}

function accusation(signed = proposal()): ExcludeProposerControl {
  return {
    kind: 'control',
    action: 'exclude-proposer',
    offender: 0,
    evidence: { kind: 'invalid-proof', proposal: signed },
  };
}

function certified(entry: LogEntry) {
  return {
    entry,
    certificate: context.membership.voters.slice(0, 3).map(({ seat }) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat,
          seq: entry.seq,
          term: entry.term,
          phase: 'precommit',
          valueHash: entryHash(entry),
        },
        identity(seat).secretKey,
      ),
    ),
  };
}

describe('proposer responsibility for invalid cryptographic proofs', () => {
  test('certifies and replays exclusion while retaining every human voter', () => {
    const control = accusation();
    expect(validateObjectiveForProposal(control, context).ok).toBe(true);
    const entry = signEntry(
      {
        seq: 1,
        term: 2,
        prevHash: entryHash(context.log.head),
        payload: control,
        stateHash: context.log.head.stateHash,
        sequencer: identity(1).peerId,
      },
      identity(1).secretKey,
    );
    const replayed = value(
      replayCertifiedPrefix(
        fixture.entry,
        [certified(entry)],
        fixture.simulation.engine,
        fixture.policy,
      ),
    );
    expect(replayed.context.excludedProposers).toEqual([0]);
    expect(replayed.context.membership.voters).toEqual(context.membership.voters);
    expect(replayed.context.log.state).toEqual(context.log.state);
    expect(
      proposerFor(2, 1, replayed.context.membership, replayed.context.excludedProposers).seat,
    ).not.toBe(0);
    expect(replayed.context.verifyHistoricalAccusation?.(control).ok).toBe(true);
  });

  test('does not blame the proposer for valid, stale, or unauthenticated inner evidence', () => {
    for (const candidate of [
      proposal({ valid: true }),
      proposal({ operationId: 'f'.repeat(64) }),
      proposal({ forged: true }),
      proposal({ valid: true, index: 0 }),
      proposal({ valid: true, index: 2 }),
    ]) {
      expect(validateObjectiveForProposal(accusation(candidate), context)).toMatchObject({
        ok: false,
        error: { code: 'control-unproven' },
      });
    }
    const original = proposal();
    const changed: SignedProposal[] = [
      { ...original, sig: signObject('proposal', original.body, identity(1).secretKey) },
      signProposal({ ...original.body, epoch: 1 }, identity(0).secretKey),
      signProposal(
        {
          ...original.body,
          entry: signEntry(
            { ...original.body.entry, prevHash: 'e'.repeat(64) },
            identity(0).secretKey,
          ),
        },
        identity(0).secretKey,
      ),
    ];
    for (const candidate of changed)
      expect(validateObjectiveForProposal(accusation(candidate), context).ok).toBe(false);
    expect(validateObjectiveForProposal({ ...accusation(), offender: 1 }, context).ok).toBe(false);
    const damaged = {
      ...context,
      log: {
        ...context.log,
        state: { ...context.log.state, bank: { ...context.log.state.bank, brick: 0 } },
      },
    };
    expect(validateObjectiveForProposal(accusation(), damaged).ok).toBe(false);
    const localFault = {
      ...context,
      log: {
        ...context.log,
        engine: {
          ...context.log.engine,
          checkInvariants: () => {
            throw new Error('Local state validator failed');
          },
        },
      },
    };
    expect(validateObjectiveForProposal(accusation(), localFault).ok).toBe(false);
  });

  test('preserves local signature safety when an accusation carries our unrecorded proposal', () => {
    const local = value(createConsensusState(context, 0));
    const staged = value(stageAccusation(local, context, accusation()));
    expect(staged.state.halted).toContain('local signing key');
    expect(staged.state.pendingAccusation).toBeNull();

    const original = proposal();
    const unrecorded = signVote(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        seat: 3,
        seq: 1,
        term: 1,
        phase: 'prevote',
        valueHash: entryHash(original.body.entry),
      },
      identity(3).secretKey,
    );
    const withVote = signProposal(
      { ...original.body, prevotes: [unrecorded] },
      identity(0).secretKey,
    );
    const observer = value(createConsensusState(context, 3));
    const halted = value(stageAccusation(observer, context, accusation(withVote)));
    expect(halted.state.halted).toContain('unrecorded local signature');
    expect(halted.state.pendingAccusation).toBeNull();
  });

  test('extracts the signed pass from the real deck entry wrapper', () => {
    const wrapped = required(fixture.deckSetupPasses[0]);
    const original = proposal();
    const signed = signProposal(
      {
        ...original.body,
        entry: signEntry(
          {
            ...original.body.entry,
            payload: { kind: 'crypto', action: 'deck-pass', evidence: wrapped },
          },
          identity(0).secretKey,
        ),
      },
      identity(0).secretKey,
    );
    const claims = rejectedProofCandidates({ t: 'PROPOSAL', proposal: signed }, context.log);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.evidence).toMatchObject({ kind: 'deck-pass', artifact: wrapped.pass });
    expect(validateObjectiveForProposal(accusation(signed), context).ok).toBe(false);
  });

  test('retains and gossips both contributor evidence and proposer accusation across restart', async () => {
    const outgoing: Uint8Array[] = [];
    const receiver: { current?: (from: string, bytes: Uint8Array) => void } = {};
    const transport: Transport = {
      self: identity(3).peerId,
      peers: () => [],
      send: () => undefined,
      broadcast: (bytes) => {
        outgoing.push(bytes.slice());
      },
      disconnect: () => undefined,
      onPeerChange: () => () => undefined,
      onMessage: (listener) => {
        receiver.current = listener;
        return () => {
          delete receiver.current;
        };
      },
    };
    const deckBytes = new Map<string, Uint8Array>();
    const retained = new MemoryCheatCandidateStore();
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.simulation.engine,
      policy: fixture.policy,
      seat: 3 as const,
      secretKey: identity(3).secretKey,
      transport,
      clock: { now: () => 0, setTimeout: () => 1, clearTimeout: () => undefined },
      journal: new MemoryProtocolJournal(),
      cheatCandidateStore: retained,
      beaconSource: fixture.beaconSourceFor(3),
      beaconContributions: new MemoryBeaconContributionStore(),
      deckSetupPasses: fixture.deckSetupPasses,
      botKeys: fixture.botKeysFor(3),
      createDeckSource: fixture.createDeckSourceFor(3),
      deckContributions: {
        load: async (id: string) => deckBytes.get(id)?.slice() ?? null,
        putIfAbsent: async (id: string, bytes: Uint8Array) => {
          if (deckBytes.has(id)) return false;
          deckBytes.set(id, bytes.slice());
          return true;
        },
      },
      countProof: () => failure('unused', 'Not exercised'),
      countContributionStore: new MemoryCountContributionStore(),
      stealContribution: () => failure('unused', 'Not exercised'),
      stealResponse: () => failure('unused', 'Not exercised'),
      stealDeliveryStore: new MemoryStealDeliveryStore(),
    } satisfies Parameters<typeof ReplicatedLog.create>[0];
    const replica = value(await ReplicatedLog.create(options));
    required(receiver.current)(
      identity(0).peerId,
      value(encodeProtocolMessage({ t: 'PROPOSAL', proposal: proposal() })),
    );
    await replica.flush();
    expect(outgoing.map((bytes) => value(decodeProtocolMessage(bytes)))).toContainEqual({
      t: 'ACCUSE',
      control: accusation(),
    });
    expect(await retained.loadAll()).toHaveLength(1);
    expect(replica.getContext().excludedProposers).toEqual([]);
    expect(replica.getContext().membership.voters).toHaveLength(4);
    replica.dispose();
    const restored = value(await ReplicatedLog.restore(options));
    const safety = value(restored['activeController']().snapshot());
    expect(safety.pendingAccusation).toEqual(accusation());
    expect(safety.halted).toBeNull();
    restored.dispose();
  });
});
