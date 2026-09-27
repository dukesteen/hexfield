import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { signObject } from '@cp2p/crypto';
import type { Engine, Result, Seat } from '@cp2p/engine';
import { failure } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { beaconOperationId } from './beacon.js';
import { getBeaconOperation } from './beacon-state.js';
import type { CheatClaim } from './cheat-proof.js';
import { entryHash, genesisDigest, signEntry } from './genesis.js';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import { MemoryProtocolJournal } from './journal.js';
import {
  MemoryCheatCandidateStore,
  cheatCandidateId,
  encodeCheatCandidate,
} from './cheat-candidates.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import { validateNextEntry } from './log.js';
import { initialProposalContext, replayCertifiedPrefix } from './replay.js';
import { proposerFor, signProposal, validateCertifiedEntry } from './proposal.js';
import type { ProposalContext } from './proposal.js';
import { createVerifiedDeckSession } from './testing/verified-deck-session.js';
import { ReplicatedLog } from './replicated-log.js';
import type { PeerId, Transport } from './transport.js';
import type { LogEntry } from './types.js';
import { signVote } from './votes.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing cheat log fixture value');
  return item;
}

describe('certified cheat records', () => {
  test('replays historical signed evidence through an earlier finding without changing engine state', async () => {
    const fixture = createVerifiedDeckSession(317, 4, 2);
    let replayCreates = 0;
    const engine: Engine = {
      ...fixture.simulation.engine,
      createGame(...args: Parameters<Engine['createGame']>) {
        replayCreates++;
        return fixture.simulation.engine.createGame(...args);
      },
    };
    const initial = value(initialProposalContext(fixture.entry, engine, fixture.policy));
    const crypto = required(initial.log.crypto);
    const operation = value(getBeaconOperation(crypto.beacon));
    const originalHash = toHex(hashValue(initial.log.state));

    function claim(seat: Seat, at: LogEntry = fixture.entry): CheatClaim {
      const body = {
        operationId: beaconOperationId(operation),
        seat,
        index: 1,
        value: toBase64Url(new Uint8Array(32).fill(200 + seat)),
      };
      const owner = required(fixture.simulation.identities.get(seat));
      return {
        seat,
        evidence: {
          kind: 'beacon-reveal',
          at: { seq: at.seq, hash: entryHash(at) },
          artifact: { body, sig: signObject('beacon-reveal', body, owner.secretKey) },
        },
      };
    }

    function entry(context: ProposalContext, proof: CheatClaim): LogEntry {
      const seq = context.log.head.seq + 1;
      const proposer = proposerFor(seq, 1, context.membership, context.excludedProposers);
      const signer = required(fixture.simulation.identities.get(proposer.seat));
      return signEntry(
        {
          seq,
          term: 1,
          prevHash: entryHash(context.log.head),
          payload: { kind: 'cheat-proof', claim: proof },
          stateHash: originalHash,
          sequencer: proposer.publicKey,
        },
        signer.secretKey,
      );
    }

    function owedDeckEntry(context: ProposalContext): LogEntry {
      const next = required(fixture.deckSetupPasses[0]);
      const seq = context.log.head.seq + 1;
      const proposer = proposerFor(seq, 1, context.membership, context.excludedProposers);
      return signEntry(
        {
          seq,
          term: 1,
          prevHash: entryHash(context.log.head),
          payload: { kind: 'crypto', action: 'deck-pass', evidence: next },
          stateHash: originalHash,
          sequencer: proposer.publicKey,
        },
        required(fixture.simulation.identities.get(proposer.seat)).secretKey,
      );
    }

    function certified(logEntry: LogEntry) {
      return {
        entry: logEntry,
        certificate: initial.membership.voters.slice(0, 3).map((voter) =>
          signVote(
            {
              genesisDigest: genesisDigest(fixture.genesis),
              epoch: 0,
              seat: voter.seat,
              seq: logEntry.seq,
              term: logEntry.term,
              phase: 'precommit',
              valueHash: entryHash(logEntry),
            },
            required(fixture.simulation.identities.get(voter.seat)).secretKey,
          ),
        ),
      };
    }

    const firstClaim = claim(required(initial.membership.voters[0]).seat);
    const firstEntry = entry(initial, firstClaim);
    const first = value(
      validateNextEntry(firstEntry, initial.log, {
        ...initial.policy,
        term: 1,
        sequencer: firstEntry.sequencer,
      }),
    );
    expect(first.input).toBeNull();
    expect(first.events).toEqual([]);
    expect(first.state).toEqual(initial.log.state);
    expect(first.lastNonces).toEqual(initial.log.lastNonces);
    expect(required(first.crypto).cheats).toMatchObject([
      { seat: firstClaim.seat, kind: 'beacon-reveal' },
    ]);
    const afterFirst = value(
      replayCertifiedPrefix(fixture.entry, [certified(firstEntry)], engine, fixture.policy),
    );
    expect(required(afterFirst.context.log.crypto).cheats).toHaveLength(1);
    const wrongSigner = required(
      initial.membership.voters.find((voter) => voter.seat !== firstClaim.seat),
    );
    const forged = {
      ...firstClaim,
      evidence: {
        ...firstClaim.evidence,
        artifact: {
          ...firstClaim.evidence.artifact,
          sig: signObject(
            'beacon-reveal',
            firstClaim.evidence.artifact.body,
            required(fixture.simulation.identities.get(wrongSigner.seat)).secretKey,
          ),
        },
      },
    };
    const beforeForged = replayCreates;
    expect(afterFirst.context.verifyHistoricalCheat?.(forged).ok).toBe(false);
    expect(replayCreates).toBe(beforeForged);
    const wrongParent = {
      ...firstClaim,
      evidence: { ...firstClaim.evidence, at: { seq: 0, hash: 'f'.repeat(64) } },
    };
    expect(afterFirst.context.verifyHistoricalCheat?.(wrongParent)).toMatchObject({
      ok: false,
      error: { code: 'cheat-history' },
    });
    expect(replayCreates).toBe(beforeForged);
    const duplicate = replayCertifiedPrefix(
      fixture.entry,
      [certified(firstEntry), certified(entry(afterFirst.context, firstClaim))],
      engine,
      fixture.policy,
    );
    expect(duplicate).toMatchObject({ ok: false, error: { code: 'cheat-duplicate' } });
    const secondClaim = claim(required(initial.membership.voters[1]).seat);
    const secondEntry = entry(afterFirst.context, secondClaim);
    const replayed = value(
      replayCertifiedPrefix(
        fixture.entry,
        [certified(firstEntry), certified(secondEntry)],
        engine,
        fixture.policy,
      ),
    );
    expect(replayed.inputs).toEqual([]);
    expect(replayed.events).toEqual([]);
    expect(replayed.context.log.state).toEqual(initial.log.state);
    expect(replayed.context.log.lastNonces).toEqual(initial.log.lastNonces);
    expect(required(replayed.context.log.crypto).cheats).toMatchObject([
      { seat: firstClaim.seat, kind: 'beacon-reveal' },
      { seat: secondClaim.seat, kind: 'beacon-reveal' },
    ]);
    const thirdClaim = claim(required(initial.membership.voters[2]).seat, firstEntry);
    const thirdEntry = entry(replayed.context, thirdClaim);
    const afterThird = value(
      replayCertifiedPrefix(
        fixture.entry,
        [certified(firstEntry), certified(secondEntry), certified(thirdEntry)],
        engine,
        fixture.policy,
      ),
    );
    const fourthClaim = claim(required(initial.membership.voters[3]).seat, secondEntry);
    const fourthEntry = entry(afterThird.context, fourthClaim);
    const beforeFour = replayCreates;
    const four = value(
      replayCertifiedPrefix(
        fixture.entry,
        [
          certified(firstEntry),
          certified(secondEntry),
          certified(thirdEntry),
          certified(fourthEntry),
        ],
        engine,
        fixture.policy,
      ),
    );
    expect(required(four.context.log.crypto).cheats).toHaveLength(4);
    expect(replayCreates - beforeFour).toBe(4);

    const journal = new MemoryProtocolJournal();
    const deckBytes = new Map<string, Uint8Array>();
    const receive: { current?: (from: PeerId, bytes: Uint8Array) => void } = {};
    const outgoing: Uint8Array[] = [];
    const statuses: string[] = [];
    const retained = new MemoryCheatCandidateStore();
    let failPut = true;
    let failCheatBroadcast = false;
    let now = 0;
    const local = required(fixture.humans[3]);
    const transport: Transport = {
      self: required(fixture.simulation.identities.get(local.seat)).peerId,
      peers: () => [],
      send: () => undefined,
      broadcast: (bytes) => {
        if (failCheatBroadcast && value(decodeProtocolMessage(bytes)).t === 'CHEAT_CLAIM')
          throw new Error('offline cheat gossip');
        outgoing.push(bytes.slice());
      },
      disconnect: () => undefined,
      onMessage: (listener) => {
        receive.current = listener;
        return () => {
          delete receive.current;
        };
      },
      onPeerChange: () => () => undefined,
    };
    const options = {
      genesisEntry: fixture.entry,
      engine,
      policy: fixture.policy,
      seat: local.seat,
      secretKey: required(fixture.simulation.identities.get(local.seat)).secretKey,
      transport,
      clock: {
        now: () => now,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
      journal,
      onStatus: (status) => {
        if ('code' in status) statuses.push(status.code);
      },
      cheatCandidateStore: {
        loadAll: () => retained.loadAll(),
        putIfAbsent: (id, bytes) =>
          failPut
            ? Promise.reject(new Error('storage unavailable'))
            : retained.putIfAbsent(id, bytes),
        delete: (id) => retained.delete(id),
      },
      beaconSource: fixture.beaconSourceFor(local.seat),
      beaconContributions: new MemoryBeaconContributionStore(),
      deckSetupPasses: fixture.deckSetupPasses,
      botKeys: fixture.botKeysFor(local.seat),
      createDeckSource: fixture.createDeckSourceFor(local.seat),
      deckContributions: {
        load: async (id: string) => deckBytes.get(id)?.slice() ?? null,
        putIfAbsent: async (id: string, bytes: Uint8Array) => {
          if (deckBytes.has(id)) return false;
          deckBytes.set(id, bytes.slice());
          return true;
        },
      },
      countProof: () => failure('count-unused', 'Count proof is not exercised'),
      countContributionStore: new MemoryCountContributionStore(),
      stealContribution: () => failure('steal-unused', 'Steal proof is not exercised'),
      stealResponse: () => failure('steal-unused', 'Steal response is not exercised'),
      stealDeliveryStore: new MemoryStealDeliveryStore(),
    } satisfies Parameters<typeof ReplicatedLog.create>[0];
    const unopenedJournal = new MemoryProtocolJournal();
    const { cheatCandidateStore: _store, ...withoutStore } = options;
    expect(
      await ReplicatedLog.create({
        ...withoutStore,
        journal: unopenedJournal,
      }),
    ).toMatchObject({ ok: false, error: { code: 'replica-cheat-store' } });
    expect(await unopenedJournal.load()).toBeNull();
    const futureClaim = claim(required(initial.membership.voters[2]).seat, firstEntry);
    expect(
      await retained.putIfAbsent(
        cheatCandidateId(futureClaim),
        value(encodeCheatCandidate(futureClaim)).bytes,
      ),
    ).toBe(true);
    const live = value(await ReplicatedLog.create(options));
    expect(statuses).toContain('cheat-store-record');
    expect(await retained.loadAll()).toEqual([]);
    expect(live.getContext().verifyHistoricalCheat?.(futureClaim)).toMatchObject({
      ok: false,
      error: { code: 'cheat-history' },
    });
    const callback = required(receive.current);
    const claimBytes = value(encodeProtocolMessage({ t: 'CHEAT_CLAIM', claim: firstClaim }));
    const relay = wrongSigner.publicKey;
    callback(relay, claimBytes);
    await live.flush();
    expect(await retained.loadAll()).toEqual([]);
    expect(outgoing.some((bytes) => Buffer.from(bytes).equals(Buffer.from(claimBytes)))).toBe(
      false,
    );
    failPut = false;
    now = 10_001;
    callback(relay, claimBytes);
    await live.flush();
    expect(await retained.loadAll()).toHaveLength(1);
    expect(outgoing.some((bytes) => Buffer.from(bytes).equals(Buffer.from(claimBytes)))).toBe(true);
    live.dispose();
    outgoing.length = 0;
    failCheatBroadcast = true;
    const resumed = value(await ReplicatedLog.restore(options));
    expect(statuses).toContain('replica-transport');
    failCheatBroadcast = false;
    value(await resumed['pulse']());
    expect(outgoing.some((bytes) => Buffer.from(bytes).equals(Buffer.from(claimBytes)))).toBe(true);
    expect(required(resumed.getContext().log.crypto).decks).toEqual(crypto.decks);
    const resumedCallback = required(receive.current);
    resumedCallback(
      firstEntry.sequencer,
      value(encodeProtocolMessage({ t: 'COMMIT', certified: certified(firstEntry) })),
    );
    await resumed.flush();
    expect(resumed.getContext().log.head.seq).toBe(1);
    expect(await retained.loadAll()).toEqual([]);
    value(
      validateCertifiedEntry(
        certified(entry(resumed.getContext(), futureClaim)),
        resumed.getContext(),
      ),
    );
    const liveResult = validateCertifiedEntry(certified(secondEntry), resumed.getContext());
    value(liveResult);
    resumed.dispose();
    const restored = value(await ReplicatedLog.restore(options));
    const restoredResult = validateCertifiedEntry(certified(secondEntry), restored.getContext());
    expect(restoredResult.ok).toBe(true);
    expect(restoredResult).toEqual(liveResult);
    const stale = restored.getContext();
    const owed = owedDeckEntry(stale);
    const owedParentClaim = claim(required(initial.membership.voters[2]).seat, owed);
    expect(stale.verifyHistoricalCheat?.(owedParentClaim)).toMatchObject({
      ok: false,
      error: { code: 'cheat-history' },
    });
    value(validateCertifiedEntry(certified(owed), stale));
    required(receive.current)(
      owed.sequencer,
      value(encodeProtocolMessage({ t: 'COMMIT', certified: certified(owed) })),
    );
    await restored.flush();
    expect(restored.getContext().log.head.seq).toBe(2);
    expect(restored.getContext().verifyHistoricalCheat?.(owedParentClaim)).toMatchObject({
      ok: true,
      value: { seat: owedParentClaim.seat },
    });
    expect(required(restored.getContext().log.crypto).decks.decks[0]?.nextPass).toBe(
      required(crypto.decks.decks[0]).nextPass + 1,
    );
    expect(restored.getContext().log.state).toEqual(initial.log.state);
    const selfCiting = entry(stale, claim(required(initial.membership.voters[3]).seat, owed));
    expect(validateCertifiedEntry(certified(selfCiting), stale)).toMatchObject({
      ok: false,
      error: { code: 'cheat-history' },
    });
    const liveParent = restored.getContext();
    const beforeBadParents = replayCreates;
    for (let variant = 0; variant < 4; variant++) {
      const invalidParent = {
        ...firstClaim,
        evidence: {
          ...firstClaim.evidence,
          at: { seq: 0, hash: variant.toString(16).padStart(64, '0') },
        },
      };
      const proposedEntry = entry(liveParent, invalidParent);
      const proposer = required(
        fixture.simulation.identities.get(
          proposerFor(
            proposedEntry.seq,
            proposedEntry.term,
            liveParent.membership,
            liveParent.excludedProposers,
          ).seat,
        ),
      );
      required(receive.current)(
        proposer.peerId,
        value(
          encodeProtocolMessage({
            t: 'PROPOSAL',
            proposal: signProposal(
              {
                genesisDigest: liveParent.membership.genesisDigest,
                epoch: liveParent.membership.epoch,
                entry: proposedEntry,
                validRound: null,
                prevotes: [],
              },
              proposer.secretKey,
            ),
          }),
        ),
      );
    }
    await restored.flush();
    const historicalWork = restored['historicalCheatWorkByPeer'].get(
      proposerFor(3, 1, liveParent.membership, liveParent.excludedProposers).publicKey,
    );
    expect(historicalWork?.seen.size).toBe(3);
    expect(replayCreates).toBe(beforeBadParents);
    now = 20_002;
    const rotating = initial.membership.voters.slice(1).map((voter) => claim(voter.seat, owed));
    for (const item of rotating) {
      required(receive.current)(
        relay,
        value(encodeProtocolMessage({ t: 'CHEAT_CLAIM', claim: item })),
      );
    }
    await restored.flush();
    expect(await retained.loadAll()).toHaveLength(3);
    const beforePulses = outgoing.length;
    for (let pulse = 0; pulse < 3; pulse++) {
      // oxlint-disable-next-line no-await-in-loop -- Each pulse advances the bounded gossip cursor.
      value(await restored['pulse']());
    }
    const retriedClaims = outgoing
      .slice(beforePulses)
      .map((bytes) => value(decodeProtocolMessage(bytes)))
      .filter((message) => message.t === 'CHEAT_CLAIM')
      .map((message) => cheatCandidateId(message.claim));
    expect(retriedClaims).toHaveLength(3);
    expect(new Set(retriedClaims)).toEqual(new Set(rotating.map(cheatCandidateId)));
    expect(restored['cheatWorkByPeer'].get(relay)?.seen.size).toBe(3);
    const historicalClaim = claim(required(initial.membership.voters[1]).seat, firstEntry);
    const historicalEntry = entry(liveParent, historicalClaim);
    const historicalProposer = required(
      fixture.simulation.identities.get(
        proposerFor(3, 1, liveParent.membership, liveParent.excludedProposers).seat,
      ),
    );
    const beforeIndependentProof = replayCreates;
    required(receive.current)(
      relay,
      value(
        encodeProtocolMessage({
          t: 'PROPOSAL',
          proposal: signProposal(
            {
              genesisDigest: liveParent.membership.genesisDigest,
              epoch: liveParent.membership.epoch,
              entry: historicalEntry,
              validRound: null,
              prevotes: [],
            },
            historicalProposer.secretKey,
          ),
        }),
      ),
    );
    await restored.flush();
    expect(restored['historicalCheatWorkByPeer'].get(relay)?.seen.size).toBe(1);
    expect(replayCreates - beforeIndependentProof).toBe(1);
    restored.dispose();
  }, 30_000);
});
