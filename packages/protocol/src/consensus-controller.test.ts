import { hashValue, toHex } from '@cp2p/codec';
import type { Result, SystemInput } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { ConsensusController } from './consensus-controller.js';
import type { ConsensusControllerOptions } from './consensus-controller.js';
import type { ConsensusEffect } from './consensus.js';
import {
  entryBody,
  entryHash,
  genesisDigest,
  genesisId,
  signEntry,
  signGenesis,
} from './genesis.js';
import { stubEvidence } from './log.js';
import type { LogContext } from './log.js';
import type { ProposalContext } from './proposal.js';
import { signProposal } from './proposal.js';
import { MemorySafetyStore } from './safety-store.js';
import type { SafetyStore } from './safety-store.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import { signVote } from './votes.js';

function errorCode(result: Result<unknown>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

function deferred() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release() {
      if (!release) throw new Error('Deferred promise was not initialized');
      release();
    },
  };
}

class PausableStore implements SafetyStore {
  readonly inner = new MemorySafetyStore();
  readonly entered = deferred();
  readonly resume = deferred();
  pauseUpdates = false;

  load() {
    return this.inner.load();
  }

  async save(expectedRevision: number | null, bytes: Uint8Array): Promise<boolean> {
    if (this.pauseUpdates && expectedRevision !== null) {
      this.entered.release();
      await this.resume.promise;
    }
    return this.inner.save(expectedRevision, bytes);
  }
}

function setup(store: SafetyStore = new MemorySafetyStore(), fourVoters = false) {
  const fixture = protocolFixture();
  const owner = fixtureAt(fixture.identities, 0);
  const roster: readonly (0 | 1 | 2 | 3)[] = fourVoters ? [0, 1, 2, 3] : [0, 1];
  const body = {
    ...fixture.body,
    seats: fixture.body.seats.map((seat) => ({
      seat: seat.seat,
      kind: 'human' as const,
      publicKey: seat.publicKey,
      name: seat.name,
      colour: seat.colour,
    })),
  };
  const genesis = fourVoters
    ? {
        ...body,
        gameId: genesisId(body),
        signatures: roster.map((seat) =>
          signGenesis(body, seat, fixtureAt(fixture.identities, seat).secretKey),
        ),
      }
    : fixture.genesis;
  const head = fourVoters
    ? signEntry(
        { ...entryBody(fixture.entry), payload: { kind: 'genesis', genesis } },
        owner.secretKey,
      )
    : fixture.entry;
  const log: LogContext = {
    genesis,
    engine: fixture.engine,
    head,
    state: fixture.state,
    crypto: null,
    lastNonces: new Map(),
  };
  const digest = genesisDigest(genesis);
  const context: ProposalContext = {
    log,
    membership: {
      genesisDigest: digest,
      epoch: 0,
      voters: roster.map((seat) => ({
        seat,
        publicKey: fixtureAt(fixture.identities, seat).peerId,
      })),
    },
    excludedProposers: [],
    policy: { allowStub: true },
  };
  const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
  const applied = fixture.engine.apply(fixture.state, input);
  if (!applied.ok) throw new Error(`Fixture input rejected: ${applied.error.code}`);
  const candidate = signEntry(
    {
      seq: 1,
      term: 1,
      prevHash: entryHash(log.head),
      payload: { kind: 'system', input, evidence: stubEvidence(log, input) },
      stateHash: toHex(hashValue(applied.value.state)),
      sequencer: owner.peerId,
    },
    owner.secretKey,
  );
  const emissions: ConsensusEffect[][] = [];
  const options: ConsensusControllerOptions = {
    context,
    seat: 0,
    secretKey: owner.secretKey,
    store,
    onEffects: (effects) => {
      emissions.push([...effects]);
    },
  };
  const certificateSeats: readonly (0 | 1 | 2 | 3)[] = fourVoters ? [1, 2, 3] : [0, 1];
  const certificate = certificateSeats.map((seat) =>
    signVote(
      {
        genesisDigest: digest,
        epoch: 0,
        seat,
        seq: 1,
        term: 1,
        phase: 'precommit',
        valueHash: entryHash(candidate),
      },
      fixtureAt(fixture.identities, seat).secretKey,
    ),
  );
  return { options, store, candidate, certificate, emissions };
}

async function create(options: ConsensusControllerOptions): Promise<ConsensusController> {
  const result = await ConsensusController.create(options);
  if (!result.ok) throw new Error(`Controller create failed: ${result.error.code}`);
  return result.value;
}

async function restore(options: ConsensusControllerOptions): Promise<ConsensusController> {
  const result = await ConsensusController.restore(options);
  if (!result.ok) throw new Error(`Controller restore failed: ${result.error.code}`);
  return result.value;
}

describe('durable consensus controller', () => {
  test('rejected proposal replays reuse a bounded cache without repeating entry derivation', async () => {
    const { options, candidate, store } = setup();
    let derivations = 0;
    const original = options.context.log.engine;
    options.context.log.engine = {
      ...original,
      apply(state, input) {
        derivations++;
        return original.apply(state, input);
      },
    };
    const controller = await create(options);
    const invalid = (variant: number) =>
      signProposal(
        {
          genesisDigest: options.context.membership.genesisDigest,
          epoch: 0,
          entry: signEntry(
            { ...entryBody(candidate), stateHash: variant.toString(16).padStart(64, '0') },
            options.secretKey,
          ),
          validRound: null,
          prevotes: [],
        },
        options.secretKey,
      );
    for (let variant = 0; variant < 17; variant++) {
      // oxlint-disable-next-line no-await-in-loop -- Each unique failure fills the bounded cache in order.
      const received = await controller.dispatch({ kind: 'proposal', proposal: invalid(variant) });
      expect(errorCode(received)).toBe('state-hash');
    }
    expect(derivations).toBe(17);
    expect(errorCode(await controller.dispatch({ kind: 'proposal', proposal: invalid(16) }))).toBe(
      'state-hash',
    );
    expect(derivations).toBe(17);
    expect(errorCode(await controller.dispatch({ kind: 'proposal', proposal: invalid(0) }))).toBe(
      'state-hash',
    );
    expect(derivations).toBe(18);
    expect((await store.load())?.revision).toBe(0);
    expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
    controller.dispose();
  });

  test('rechecks a rejected control replay after proof of a different offender', async () => {
    const { options, store, emissions } = setup(new MemorySafetyStore(), true);
    const controller = await create(options);
    const controlFor = (offender: 1 | 2) => {
      const signer = fixtureAt(protocolFixture().identities, offender);
      const body = {
        genesisDigest: options.context.membership.genesisDigest,
        epoch: 0,
        seat: offender,
        seq: 1,
        term: 1,
        phase: 'prevote' as const,
        valueHash: null,
      };
      return {
        kind: 'control' as const,
        action: 'exclude-proposer' as const,
        offender,
        evidence: {
          kind: 'vote-equivocation' as const,
          first: signVote(body, signer.secretKey),
          second: signVote({ ...body, valueHash: 'e'.repeat(64) }, signer.secretKey),
        },
      };
    };
    const rejectedControl = controlFor(2);
    const entry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(options.context.log.head),
        payload: rejectedControl,
        stateHash: 'f'.repeat(64),
        sequencer: fixtureAt(protocolFixture().identities, 0).peerId,
      },
      options.secretKey,
    );
    const rejectedProposal = signProposal(
      {
        genesisDigest: options.context.membership.genesisDigest,
        epoch: 0,
        entry,
        validRound: null,
        prevotes: [],
      },
      options.secretKey,
    );

    expect(
      errorCode(await controller.dispatch({ kind: 'proposal', proposal: rejectedProposal })),
    ).toBe('control-state');
    expect((await store.load())?.revision).toBe(0);
    expect(
      (await controller.dispatch({ kind: 'stage-accusation', control: controlFor(1) })).ok,
    ).toBe(true);
    const staged = controller.snapshot();
    if (!staged.ok) throw new Error(`Snapshot failed: ${staged.error.code}`);
    expect(staged.value.provenOffender?.control.offender).toBe(1);
    expect(staged.value.haltKind).toBeNull();

    expect(
      (await controller.dispatch({ kind: 'proposal', proposal: structuredClone(rejectedProposal) }))
        .ok,
    ).toBe(true);
    const halted = controller.snapshot();
    if (!halted.ok) throw new Error(`Snapshot failed: ${halted.error.code}`);
    expect(halted.value.haltKind).toBe('terminal');
    expect(halted.value.halted).toContain('second Byzantine voter');
    expect(emissions.flat().filter((effect) => effect.kind === 'halt')).toHaveLength(1);
    expect((await store.load())?.revision).toBe(2);
    controller.dispose();
  });

  test('exact proposal replay skips proof work and leaves the persisted vote intact', async () => {
    const { options, candidate, emissions, store } = setup();
    const controller = await create(options);
    expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
    const proposal = emissions.flat().find((effect) => effect.kind === 'broadcast-proposal');
    if (!proposal || proposal.kind !== 'broadcast-proposal')
      throw new Error('Expected a signed proposal');
    const revision = (await store.load())?.revision;
    expect(
      (
        await controller.dispatch({
          kind: 'proposal',
          proposal: structuredClone(proposal.proposal),
        })
      ).ok,
    ).toBe(true);
    expect((await store.load())?.revision).toBe(revision);
    expect(emissions.flat().filter((effect) => effect.kind === 'broadcast-vote')).toHaveLength(1);
  });

  test('holds signed effects until the new safety record is saved', async () => {
    const store = new PausableStore();
    const { options, candidate, emissions } = setup(store);
    const controller = await create(options);
    store.pauseUpdates = true;
    const pending = controller.dispatch({ kind: 'propose', candidate });
    await store.entered.promise;
    expect(emissions).toHaveLength(0);
    expect((await store.load())?.revision).toBe(0);
    store.resume.release();
    expect((await pending).ok).toBe(true);
    expect((await store.load())?.revision).toBe(1);
    expect(emissions.flat().map((effect) => effect.kind)).toContain('broadcast-proposal');
    expect(emissions.flat().map((effect) => effect.kind)).toContain('broadcast-vote');
  });

  test('serializes concurrent dispatches without signing the same vote twice', async () => {
    const { options, candidate, emissions, store } = setup();
    const controller = await create(options);
    const outcomes = await Promise.all([
      controller.dispatch({ kind: 'propose', candidate }),
      controller.dispatch({ kind: 'propose', candidate }),
    ]);
    expect(outcomes.map((result) => result.ok)).toEqual([true, true]);
    const effects = emissions.flat();
    expect(effects.filter((effect) => effect.kind === 'broadcast-proposal')).toHaveLength(1);
    expect(effects.filter((effect) => effect.kind === 'broadcast-vote')).toHaveLength(1);
    const snapshot = controller.snapshot();
    if (!snapshot.ok) throw new Error(`Snapshot failed: ${snapshot.error.code}`);
    expect(snapshot.value.votes.filter((vote) => vote.body.seat === 0)).toHaveLength(1);
    expect((await store.load())?.revision).toBe(2);
  });

  test('disposal during persistence emits nothing, then restore retransmits saved signatures', async () => {
    const store = new PausableStore();
    const { options, candidate, emissions } = setup(store);
    const controller = await create(options);
    store.pauseUpdates = true;
    const pending = controller.dispatch({ kind: 'propose', candidate });
    await store.entered.promise;
    controller.dispose();
    store.resume.release();
    expect(errorCode(await pending)).toBe('consensus-stopped');
    expect(emissions).toHaveLength(0);
    const recoveredEffects: ConsensusEffect[][] = [];
    const restored = await restore({
      ...options,
      onEffects: (effects) => {
        recoveredEffects.push([...effects]);
      },
    });
    expect((await restored.resume()).ok).toBe(true);
    expect(recoveredEffects.flat().map((effect) => effect.kind)).toContain('broadcast-proposal');
    expect(recoveredEffects.flat().map((effect) => effect.kind)).toContain('broadcast-vote');
  });

  test('failed save emits nothing and stops the controller', async () => {
    const inner = new MemorySafetyStore();
    const store: SafetyStore = {
      load: () => inner.load(),
      save: (revision, bytes) =>
        revision === null ? inner.save(revision, bytes) : Promise.resolve(false),
    };
    const { options, emissions } = setup(store);
    const controller = await create(options);
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-write-conflict',
    );
    expect(emissions).toHaveLength(0);
    expect((await inner.load())?.revision).toBe(0);
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );
  });

  test('a storage exception stops voting without emitting unsaved effects', async () => {
    const inner = new MemorySafetyStore();
    const store: SafetyStore = {
      load: () => inner.load(),
      save: (revision, bytes) => {
        if (revision !== null) throw new Error('disk unavailable');
        return inner.save(revision, bytes);
      },
    };
    const { options, emissions } = setup(store);
    const controller = await create(options);
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-storage',
    );
    expect(emissions).toHaveLength(0);
    expect((await inner.load())?.revision).toBe(0);
    expect(errorCode(await controller.resume())).toBe('consensus-stopped');
  });

  test('a stale CAS writer stops instead of overwriting the newer record', async () => {
    const { options, store, emissions } = setup();
    const first = await create(options);
    const stale = await restore(options);
    expect((await first.dispatch({ kind: 'input-available' })).ok).toBe(true);
    const newer = await store.load();
    expect(newer?.revision).toBe(1);
    const before = emissions.length;
    expect(errorCode(await stale.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-write-conflict',
    );
    expect(emissions).toHaveLength(before);
    expect((await store.load())?.bytes).toEqual(newer?.bytes);
    expect(errorCode(await stale.resume())).toBe('consensus-stopped');
  });

  test('missing, corrupt, cross-parent, and mismatched-key records fail closed', async () => {
    const { options, store } = setup();
    expect(errorCode(await ConsensusController.restore(options))).toBe('consensus-store-missing');
    expect(await store.save(null, new TextEncoder().encode('{'))).toBe(true);
    expect(errorCode(await ConsensusController.restore(options))).toBe('consensus-storage');

    const valid = setup();
    await create(valid.options);
    const alteredContext: ProposalContext = {
      ...valid.options.context,
      log: {
        ...valid.options.context.log,
        head: { ...valid.options.context.log.head, stateHash: 'f'.repeat(64) },
      },
    };
    expect(
      errorCode(await ConsensusController.restore({ ...valid.options, context: alteredContext })),
    ).toBe('consensus-context');
    const otherSecret = fixtureAt(protocolFixture().identities, 1).secretKey;
    expect(
      errorCode(await ConsensusController.restore({ ...valid.options, secretKey: otherSecret })),
    ).toBe('consensus-key');
  });

  test('a callback failure after save stops effects, and restore replays them', async () => {
    const { options, candidate, store } = setup();
    const controller = await create({
      ...options,
      onEffects: () => {
        throw new Error('delivery interrupted');
      },
    });
    expect(errorCode(await controller.dispatch({ kind: 'propose', candidate }))).toBe(
      'consensus-effects',
    );
    expect((await store.load())?.revision).toBe(1);
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );
    const recovered: ConsensusEffect[] = [];
    const restarted = await restore({
      ...options,
      onEffects: (effects) => {
        recovered.push(...effects);
      },
    });
    expect((await restarted.resume()).ok).toBe(true);
    expect(recovered.some((effect) => effect.kind === 'broadcast-proposal')).toBe(true);
    expect(recovered.some((effect) => effect.kind === 'broadcast-vote')).toBe(true);
  });

  test('a snapshot is detached and create never replaces an existing record', async () => {
    const { options, store } = setup();
    const controller = await create(options);
    const original = await store.load();
    const snapshot = controller.snapshot();
    if (!snapshot.ok) throw new Error(`Snapshot failed: ${snapshot.error.code}`);
    snapshot.value.round = 99;
    snapshot.value.timers.propose = true;
    const next = controller.snapshot();
    if (!next.ok) throw new Error(`Snapshot failed: ${next.error.code}`);
    expect(next.value.round).toBe(1);
    expect(next.value.timers.propose).toBe(false);
    expect(errorCode(await ConsensusController.create(options))).toBe('consensus-store-exists');
    expect((await store.load())?.bytes).toEqual(original?.bytes);
    expect((await store.load())?.revision).toBe(original?.revision);
  });

  test('corrupt local derivation stops an active controller until certified-prefix replay', async () => {
    const { options, candidate, store, emissions } = setup();
    const controller = await create(options);
    expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
    const saved = await store.load();
    const freshContext: ProposalContext = {
      ...options.context,
      log: { ...options.context.log },
    };
    const corruptContext: ProposalContext = {
      ...freshContext,
      log: {
        ...freshContext.log,
        state: {
          ...freshContext.log.state,
          counters: {
            ...freshContext.log.state.counters,
            nextOfferId: freshContext.log.state.counters.nextOfferId + 1,
          },
        },
      },
    };
    // The same persisted proposal can no longer be derived from corrupted local state.
    options.context.log.state = corruptContext.log.state;
    expect(errorCode(controller.snapshot())).toBe('consensus-restore');
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );
    expect((await store.load())?.bytes).toEqual(saved?.bytes);
    expect((await store.load())?.revision).toBe(saved?.revision);
    expect(emissions.flat().filter((effect) => effect.kind === 'broadcast-vote')).toHaveLength(1);

    const dispatchContext: ProposalContext = {
      ...freshContext,
      log: { ...freshContext.log },
    };
    const dispatchController = await restore({ ...options, context: dispatchContext });
    dispatchContext.log.state = corruptContext.log.state;
    expect(errorCode(await dispatchController.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-restore',
    );
    expect(errorCode(await dispatchController.resume())).toBe('consensus-stopped');

    const resumeContext: ProposalContext = {
      ...freshContext,
      log: { ...freshContext.log },
    };
    const resumeController = await restore({ ...options, context: resumeContext });
    resumeContext.log.state = corruptContext.log.state;
    expect(errorCode(await resumeController.resume())).toBe('consensus-restore');
    expect(errorCode(await resumeController.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );

    // A fresh controller can only continue after the certified parent is reconstructed.
    const retransmitted: ConsensusEffect[] = [];
    const replayed = await restore({
      ...options,
      context: freshContext,
      onEffects: (effects) => {
        retransmitted.push(...effects);
      },
    });
    expect((await replayed.resume()).ok).toBe(true);
    expect(retransmitted.some((effect) => effect.kind === 'broadcast-proposal')).toBe(true);
    expect(retransmitted.some((effect) => effect.kind === 'broadcast-vote')).toBe(true);
  });

  test('a persisted commit replays after a delivery crash at the commit boundary', async () => {
    const { options, candidate, certificate, store } = setup(new MemorySafetyStore(), true);
    const controller = await create({
      ...options,
      onEffects: (effects) => {
        if (effects.some((effect) => effect.kind === 'commit'))
          throw new Error('crashed after saving the certificate');
      },
    });
    expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
    const certified = { entry: candidate, certificate };
    expect(errorCode(await controller.dispatch({ kind: 'commit', certified }))).toBe(
      'consensus-effects',
    );
    expect((await store.load())?.revision).toBe(2);
    const replayed: ConsensusEffect[] = [];
    const restarted = await restore({
      ...options,
      onEffects: (effects) => {
        replayed.push(...effects);
      },
    });
    expect((await restarted.resume()).ok).toBe(true);
    expect(replayed.filter((effect) => effect.kind === 'commit')).toHaveLength(1);
  });
});
