import { canonicalEncode, fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import { describe, expect, test } from 'vitest';
import { success } from '@cp2p/engine';
import type { CommandShape, Result, Seat } from '@cp2p/engine';
import { createConsensusState } from './consensus.js';
import { entryHash, genesisId, GENESIS_PREVIOUS_HASH, signEntry, signGenesis } from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import { P2PSession } from './p2p-session.js';
import type { P2PSessionOptions, SessionDriver } from './p2p-session.js';
import type { ReplayPolicy } from './replay.js';
import { replayCertifiedPrefix } from './replay.js';
import { proposerFor } from './proposal.js';
import { createMemnet } from './testing/memnet.js';
import { protocolFixture } from './testing/fixtures.js';
import { SimulationDriver } from './testing/simulation-driver.js';
import { VirtualClock } from './testing/virtual-clock.js';
import type { ProtocolClock } from './transport.js';
import type { Genesis, GenesisBody, LogEntry } from './types.js';
import { signVote } from './votes.js';

const policy: ReplayPolicy = { genesis: { allowStub: true }, entry: { allowStub: true } };

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function twoHumanFixture(withTurnTimer = false) {
  const fixture = protocolFixture();
  const config = {
    ...fixture.body.config,
    seats: [0, 1] as Seat[],
    ...(withTurnTimer
      ? {
          options: {
            ...fixture.body.config.options,
            base: {
              mapLayout: 'random',
              turnTimer: { preRollSec: 5, mainSec: 10, discardSec: 8, robberSec: 6 },
            },
          },
        }
      : {}),
  };
  const identities = fixture.identities.slice(0, 2);
  const seats = fixture.body.seats.slice(0, 2);
  const body: GenesisBody = { ...fixture.body, config, seats };
  const firstIdentity = fixture.identities[0];
  const secondIdentity = fixture.identities[1];
  if (!firstIdentity || !secondIdentity) throw new Error('Missing human identities');
  const genesis: Genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: [
      signGenesis(body, 0, firstIdentity.secretKey),
      signGenesis(body, 1, secondIdentity.secretKey),
    ],
  };
  const state = fixture.engine.createGame(config, fromBase64Url(body.genesisSeed));
  const sequencer = fixture.identities[0];
  if (!sequencer) throw new Error('Missing initial sequencer');
  const entry: LogEntry = signEntry(
    {
      seq: 0,
      term: 1,
      prevHash: GENESIS_PREVIOUS_HASH,
      payload: { kind: 'genesis', genesis },
      stateHash: toHex(hashValue(state)),
      sequencer: sequencer.peerId,
    },
    sequencer.secretKey,
  );
  return { ...fixture, identities, body, genesis, state, entry };
}

function createDriverFactory(committedBySeat?: Map<Seat, number>, clock?: ProtocolClock) {
  return (
    engine: P2PSessionOptions['engine'],
    genesis: Genesis,
    localSeat: Seat,
  ): SessionDriver => {
    const driver = new SimulationDriver(engine, genesis, clock);
    return {
      next: (context) => driver.next(context),
      committed: (before, input, after) => {
        if (committedBySeat)
          committedBySeat.set(localSeat, (committedBySeat.get(localSeat) ?? 0) + 1);
        return driver.committed(before, input, after);
      },
      privateState: (seat) => driver.privateState(seat),
      getTimers: () => driver.getTimers(),
    };
  };
}

function optionsFor(
  fixture: ReturnType<typeof protocolFixture> | ReturnType<typeof twoHumanFixture>,
  seat: Seat,
  transport: ReturnType<ReturnType<typeof createMemnet>['transport']>,
  clock: VirtualClock,
  journal: MemoryProtocolJournal,
  botKeys?: ReadonlyMap<Seat, Uint8Array>,
  committedBySeat?: Map<Seat, number>,
): P2PSessionOptions {
  const identity = fixture.identities[seat];
  if (!identity) throw new Error(`Missing identity for seat ${seat}`);
  return {
    genesisEntry: fixture.entry,
    engine: fixture.engine,
    policy,
    seat,
    secretKey: identity.secretKey,
    transport,
    clock,
    journal,
    ...(botKeys ? { botKeys } : {}),
    createDriver: (engine, genesis, protocolClock) =>
      createDriverFactory(committedBySeat, protocolClock)(engine, genesis, seat),
  };
}

async function settleNetwork(sessions: readonly P2PSession[], clock: VirtualClock): Promise<void> {
  for (let pass = 0; pass < 12; pass++) {
    // oxlint-disable-next-line no-await-in-loop -- Each flush/clock pass drains messages scheduled by the preceding pass.
    await Promise.all(sessions.map((session) => session.flush()));
    clock.advanceBy(0);
  }
  await Promise.all(sessions.map((session) => session.flush()));
}

async function openTwoHumanSessions(fixture: ReturnType<typeof twoHumanFixture>) {
  const peers = fixture.identities.map((identity) => identity.peerId);
  const clock = new VirtualClock();
  const net = createMemnet({ peers, clock });
  const journals = [new MemoryProtocolJournal(), new MemoryProtocolJournal()];
  const committed = new Map<Seat, number>();
  const sessions = await Promise.all(
    ([0, 1] as const).map(async (seat) => {
      const journal = journals[seat];
      if (!journal) throw new Error('Missing session journal');
      return value(
        await P2PSession.create(
          optionsFor(
            fixture,
            seat,
            net.transport(peers[seat] ?? ''),
            clock,
            journal,
            undefined,
            committed,
          ),
        ),
      );
    }),
  );
  await settleNetwork(sessions, clock);
  return { clock, net, journals, sessions, committed, peers };
}

function placementCommand(session: P2PSession, seat: Seat): CommandShape {
  const command = session
    .getLegalCommands(seat)
    .commands.find((candidate) => candidate.type === 'PLACE_SETTLEMENT');
  if (!command) throw new Error(`No setup settlement for seat ${seat}`);
  return command;
}

describe('P2PSession', () => {
  test('setup submission waits for quorum and publishes state/private effects only on commit', async () => {
    const fixture = twoHumanFixture();
    const { clock, net, sessions, committed, peers } = await openTwoHumanSessions(fixture);
    const [first, second] = sessions;
    if (!first || !second) throw new Error('Missing peer sessions');
    expect(first.getState().turn.phase.at(-1)?.id).toBe('setup');
    expect(first.getPrivate(1)).toBeNull();
    expect(second.getPrivate(0)).toBeNull();
    expect(committed.get(0)).toBe(1);

    const activeSeat = first.getState().turn.activeSeat;
    const owner = sessions[activeSeat];
    if (!owner) throw new Error(`No peer owns active seat ${activeSeat}`);
    const command = placementCommand(owner, activeSeat);
    const revision = owner.exportSave().entries.at(-1)?.entry.seq ?? 0;
    const privateBefore = owner.getPrivate(activeSeat);
    const stale = await owner.submit(activeSeat, command, { expectedRevision: revision - 1 });
    expect(stale).toMatchObject({ ok: false, error: { code: 'stale-revision' } });

    const updates: number[] = [];
    const unsubscribe = owner.subscribe((update) => updates.push(update.revision));
    updates.length = 0;
    const eventsBefore = owner.getEvents();
    const commitsBefore = committed.get(activeSeat) ?? 0;
    const otherPeer = peers.find((peer) => peer !== net.transport(peers[activeSeat] ?? '').self);
    if (!otherPeer) throw new Error('Missing second peer id');
    net.disconnect(peers[activeSeat] ?? '', otherPeer);
    let resolved = false;
    const submitted = owner
      .submit(activeSeat, command, { expectedRevision: revision })
      .then((result) => {
        resolved = true;
        return result;
      });
    await settleNetwork(sessions, clock);
    expect(resolved).toBe(false);
    expect(owner.exportSave().entries.at(-1)?.entry.seq ?? 0).toBe(revision);
    expect(owner.getEvents()).toEqual(eventsBefore);
    expect(committed.get(activeSeat) ?? 0).toBe(commitsBefore);
    expect(owner.getPrivate(activeSeat)).toEqual(privateBefore);
    expect(updates.every((item) => item <= revision)).toBe(true);

    net.connect(peers[activeSeat] ?? '', otherPeer);
    await settleNetwork(sessions, clock);
    expect(await submitted).toEqual(success(undefined));
    expect(owner.exportSave().entries.at(-1)?.entry.seq).toBe(revision + 1);
    expect(owner.getState().board.buildings).toHaveLength(1);
    expect(owner.getEvents().length).toBeGreaterThan(0);
    expect(committed.get(activeSeat)).toBe(commitsBefore + 1);
    unsubscribe();

    const ownedCopy = owner.getPrivate(activeSeat);
    if (!ownedCopy) throw new Error('Expected local private state');
    ownedCopy.hand.ore = 999;
    expect(owner.getPrivate(activeSeat)?.hand.ore).not.toBe(999);
    owner.dispose();
    expect(owner.getPrivate(activeSeat)).toBeNull();
    const foreignSeat: Seat = activeSeat === 0 ? 1 : 0;
    expect(owner.getPrivate(foreignSeat)).toBeNull();
    expect(owner.getLegalCommands(activeSeat).commands).toEqual([]);
    expect((await owner.submit(activeSeat, command)).ok).toBe(false);
    second.dispose();
    net.dispose();
  });

  test.each([false, true])(
    'restore reconstructs the owner hand, historical exclusion: %s',
    async (withExclusion) => {
      const fixture = twoHumanFixture(true);
      const { clock, net, journals, sessions, peers } = await openTwoHumanSessions(fixture);
      const maxInputs = 24;
      for (let step = 0; step < maxInputs; step++) {
        // oxlint-disable-next-line no-await-in-loop -- Each certified input determines the next legal setup command.
        await settleNetwork(sessions, clock);
        const state = sessions[0]?.getState();
        if (!state) throw new Error('Missing public state');
        const phase = state.turn.phase.at(-1)?.id;
        if (phase === 'main') break;
        const seat = state.turn.activeSeat;
        const owner = sessions.find((session) => session.controllableSeats().includes(seat));
        if (!owner) throw new Error(`Setup requested uncontrolled seat ${seat}`);
        const command = owner
          .getLegalCommands(seat)
          .commands.find(
            (candidate) =>
              candidate.type === 'PLACE_SETTLEMENT' ||
              candidate.type === 'PLACE_ROAD' ||
              candidate.type === 'ROLL_DICE',
          );
        if (!command) throw new Error(`No legal setup command in ${phase}`);
        const submitted = owner.submit(seat, command);
        // oxlint-disable-next-line no-await-in-loop -- Later setup choices depend on this commit.
        await settleNetwork(sessions, clock);
        // oxlint-disable-next-line no-await-in-loop -- Await each committed placement before deriving the next.
        const result = await submitted;
        if (!result.ok) throw new Error(`Setup submit failed: ${result.error.code}`);
      }
      const first = sessions[0];
      const journal = journals[0];
      const peerId = peers[0];
      if (!first || !journal || !peerId) throw new Error('Missing restore fixture parts');
      expect(first.getState().turn.phase.at(-1)?.id).toBe('main');
      const timers = first.getTimers();
      expect(timers).toHaveLength(1);
      expect(timers[0]).toMatchObject({ phase: 'main', remainingMs: 10_000, paused: false });
      clock.advanceBy(1_250);
      expect(first.getTimers()[0]?.remainingMs).toBe(8_750);
      const privateBefore = first.getPrivate(0);
      if (!privateBefore) throw new Error('Missing human private state');
      expect(
        Object.values(privateBefore.hand).reduce((total, count) => total + count, 0),
      ).toBeGreaterThan(0);
      first.dispose();
      net.crash(peerId);
      if (withExclusion) {
        const saved = await journal.load();
        if (!saved) throw new Error('Missing saved session');
        const context = value(
          replayCertifiedPrefix(saved.genesis, saved.entries, fixture.engine, policy),
        ).context;
        const offender = fixture.identities[1];
        if (!offender) throw new Error('Missing offender identity');
        const voteBody = {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat: 1 as const,
          seq: 1,
          term: 1,
          phase: 'prevote' as const,
          valueHash: null,
        };
        const proposer = proposerFor(
          saved.height,
          1,
          context.membership,
          context.excludedProposers,
        );
        const signer = fixture.identities.find(
          (identity) => identity.peerId === proposer.publicKey,
        );
        if (!signer) throw new Error('Missing exclusion proposer');
        const exclusion = signEntry(
          {
            seq: saved.height,
            term: 1,
            prevHash: entryHash(context.log.head),
            payload: {
              kind: 'control',
              action: 'exclude-proposer',
              offender: 1,
              evidence: {
                kind: 'vote-equivocation',
                first: signVote(voteBody, offender.secretKey),
                second: signVote({ ...voteBody, valueHash: 'a'.repeat(64) }, offender.secretKey),
              },
            },
            stateHash: context.log.head.stateHash,
            sequencer: proposer.publicKey,
          },
          signer.secretKey,
        );
        const certified = {
          entry: exclusion,
          certificate: context.membership.voters.map((voter) => {
            const identity = fixture.identities[voter.seat];
            if (!identity) throw new Error('Missing certificate voter');
            return signVote(
              {
                ...voteBody,
                seat: voter.seat,
                seq: exclusion.seq,
                phase: 'precommit',
                valueHash: entryHash(exclusion),
              },
              identity.secretKey,
            );
          }),
        };
        const next = value(
          replayCertifiedPrefix(
            saved.genesis,
            [...saved.entries, certified],
            fixture.engine,
            policy,
          ),
        ).context;
        const safety = value(createConsensusState(next, 0));
        const committed = await journal.commit(
          saved.height,
          saved.safety.revision,
          certified,
          canonicalEncode(safety),
        );
        if (!committed) throw new Error('Could not append the historical exclusion fixture');
      }
      const transport = net.restart(peerId);
      const restored = value(
        await P2PSession.restore(optionsFor(fixture, 0, transport, clock, journal)),
      );
      expect(restored.getState()).toEqual(sessions[1]?.getState());
      expect(restored.getPrivate(0)).toEqual(privateBefore);
      expect(restored.getPrivate(1)).toBeNull();
      restored.dispose();
      sessions[1]?.dispose();
      net.dispose();
    },
  );

  test('bot signing keys are accepted only by their certified host and are cleared on dispose', async () => {
    const fixture = protocolFixture();
    const peers = fixture.identities.slice(0, 2).map((identity) => identity.peerId);
    const clock = new VirtualClock();
    const net = createMemnet({ peers, clock });
    const first = fixture.identities[0];
    const second = fixture.identities[1];
    const hostedBot = fixture.identities[2];
    const foreignBot = fixture.identities[3];
    if (!first || !second || !hostedBot || !foreignBot) throw new Error('Missing identities');
    const session = value(
      await P2PSession.create(
        optionsFor(
          fixture,
          0,
          net.transport(first.peerId),
          clock,
          new MemoryProtocolJournal(),
          new Map([[2, hostedBot.secretKey]]),
        ),
      ),
    );
    expect(session.getPrivate(2)).not.toBeNull();
    expect(session.getPrivate(3)).toBeNull();

    const invalid = await P2PSession.create(
      optionsFor(
        fixture,
        0,
        net.transport(first.peerId),
        clock,
        new MemoryProtocolJournal(),
        new Map([[3, foreignBot.secretKey]]),
      ),
    );
    expect(invalid).toMatchObject({ ok: false, error: { code: 'session-bot-key' } });
    session.dispose();
    expect(session.getPrivate(0)).toBeNull();
    expect(session.getPrivate(2)).toBeNull();
    expect(second.peerId).toBe(peers[1]);
    net.dispose();
  });
});
