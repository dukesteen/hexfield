import { canonicalEncode, fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import { describe, expect, test, vi } from 'vitest';
import { failure, success } from '@cp2p/engine';
import type { CommandShape, Engine, Result, Seat, SystemInput } from '@cp2p/engine';
import { createConsensusState } from './consensus.js';
import {
  entryHash,
  genesisDigest,
  genesisId,
  GENESIS_PREVIOUS_HASH,
  signEntry,
  signGenesis,
} from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import type { JournalRecord, ProtocolJournal } from './journal.js';
import { P2PSession } from './p2p-session.js';
import { ReplicatedLog } from './replicated-log.js';
import type { P2PSessionOptions, SessionDriver } from './p2p-session.js';
import type { ReplayPolicy } from './replay.js';
import { replayCertifiedPrefix } from './replay.js';
import { initialProposalContext, snapshotFromContext } from './replay.js';
import { proposerFor } from './proposal.js';
import type { CertifiedEntry } from './proposal.js';
import { createMemnet } from './testing/memnet.js';
import { protocolFixture } from './testing/fixtures.js';
import { SimulationDriver } from './testing/simulation-driver.js';
import { VirtualClock } from './testing/virtual-clock.js';
import type { ProtocolClock } from './transport.js';
import type { ExcludeProposerControl, Genesis, GenesisBody, LogEntry } from './types.js';
import { signVote } from './votes.js';
import { stubEvidence } from './log.js';
import { encodeProtocolMessage } from './messages.js';
import type { LogContext, ValidatedEntry } from './log.js';

const policy: ReplayPolicy = {
  genesis: { allowStub: true },
  entry: {
    allowStub: true,
    verifyCommand(signed) {
      const expected = {
        protocol: 'test-owner-proof',
        data: {
          headHash: signed.body.headHash,
          nonce: signed.body.nonce,
          command: signed.body.command.type,
        },
      };
      return toHex(hashValue(signed.body.evidence)) === toHex(hashValue(expected))
        ? success(undefined)
        : failure('test-evidence', 'Owner evidence differs from the signed intent');
    },
  },
};
type SessionFixture = Omit<ReturnType<typeof protocolFixture>, 'identities'> & {
  identities: readonly ReturnType<typeof protocolFixture>['identities'][number][];
};

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

function fourHumanFixture() {
  const fixture = protocolFixture();
  const seats = fixture.body.seats.map(({ seat }, index) => {
    const identity = fixture.identities[index];
    if (!identity) throw new Error(`Missing identity for seat ${seat}`);
    return {
      seat,
      kind: 'human' as const,
      publicKey: identity.peerId,
      name: `Human ${seat}`,
      colour: fixture.body.seats[seat]?.colour ?? '#386b6d',
    };
  });
  const body: GenesisBody = { ...fixture.body, seats };
  const genesis: Genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: body.seats.map(({ seat }) => {
      const identity = fixture.identities[seat];
      if (!identity) throw new Error(`Missing identity for seat ${seat}`);
      return signGenesis(body, seat, identity.secretKey);
    }),
  };
  const sequencer = fixture.identities[0];
  if (!sequencer) throw new Error('Missing initial sequencer');
  const entry = signEntry(
    {
      seq: 0,
      term: 1,
      prevHash: GENESIS_PREVIOUS_HASH,
      payload: { kind: 'genesis', genesis },
      stateHash: toHex(hashValue(fixture.state)),
      sequencer: sequencer.peerId,
    },
    sequencer.secretKey,
  );
  return { ...fixture, body, genesis, entry };
}

function createDriverFactory(
  committedBySeat?: Map<Seat, number>,
  clock?: ProtocolClock,
  committedEntry?: SessionDriver['committedEntry'],
  nextOverride?: (
    context: LogContext,
    defaultNext: SessionDriver['next'],
  ) => ReturnType<SessionDriver['next']>,
) {
  return (
    engine: P2PSessionOptions['engine'],
    genesis: Genesis,
    localSeat: Seat,
  ): SessionDriver => {
    const driver = new SimulationDriver(engine, genesis, clock);
    return {
      next: (context) =>
        nextOverride
          ? nextOverride(context, (current) => driver.next(current))
          : driver.next(context),
      committed: (before, input, after) => {
        if (committedBySeat)
          committedBySeat.set(localSeat, (committedBySeat.get(localSeat) ?? 0) + 1);
        return driver.committed(before, input, after);
      },
      ...(committedEntry
        ? {
            committedEntry: (
              entry: ValidatedEntry & CertifiedEntry,
              before: LogContext,
              after: LogContext,
            ) => committedEntry(entry, before, after),
          }
        : {}),
      privateState: (seat) => driver.privateState(seat),
      getTimers: () => driver.getTimers(),
    };
  };
}

function optionsFor(
  fixture: SessionFixture,
  seat: Seat,
  transport: ReturnType<ReturnType<typeof createMemnet>['transport']>,
  clock: VirtualClock,
  journal: ProtocolJournal,
  botKeys?: ReadonlyMap<Seat, Uint8Array>,
  committedBySeat?: Map<Seat, number>,
  committedEntry?: SessionDriver['committedEntry'],
  driverHooks: Partial<
    Pick<SessionDriver, 'prepareCommand' | 'dispose' | 'privateState' | 'getTimers'>
  > = {},
  ownedSeatsSeen?: Seat[][],
  nextOverride?: (
    context: LogContext,
    defaultNext: SessionDriver['next'],
  ) => ReturnType<SessionDriver['next']>,
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
    createDriver: (engine, genesis, protocolClock, ownedSeats) => {
      ownedSeatsSeen?.push([...ownedSeats]);
      const driver = createDriverFactory(
        committedBySeat,
        protocolClock,
        committedEntry,
        nextOverride,
      )(engine, genesis, seat);
      return {
        ...driver,
        ...driverHooks,
      };
    },
  };
}

async function openHumanSessions(
  fixture: ReturnType<typeof protocolFixture>,
  entryHookForSeat?: (seat: Seat) => SessionDriver['committedEntry'],
) {
  const seats = fixture.body.seats.map(({ seat }) => seat);
  const peers = fixture.identities.map((identity) => identity.peerId);
  const clock = new VirtualClock();
  const net = createMemnet({ peers, clock });
  const journals = seats.map(() => new MemoryProtocolJournal());
  const committed = new Map<Seat, number>();
  const sessions = await Promise.all(
    seats.map(async (seat) => {
      const journal = journals[seat];
      const peerId = peers[seat];
      if (!journal || !peerId) throw new Error(`Missing fixture for seat ${seat}`);
      return value(
        await P2PSession.create(
          optionsFor(
            fixture,
            seat,
            net.transport(peerId),
            clock,
            journal,
            undefined,
            committed,
            entryHookForSeat?.(seat),
          ),
        ),
      );
    }),
  );
  await settleNetwork(sessions, clock);
  return { clock, net, journals, sessions, committed, peers };
}

async function settleNetwork(sessions: readonly P2PSession[], clock: VirtualClock): Promise<void> {
  for (let pass = 0; pass < 12; pass++) {
    // oxlint-disable-next-line no-await-in-loop -- Each flush/clock pass drains messages scheduled by the preceding pass.
    await Promise.all(sessions.map((session) => session.flush()));
    clock.advanceBy(0);
  }
  await Promise.all(sessions.map((session) => session.flush()));
}

async function openTwoHumanSessions(
  fixture: ReturnType<typeof twoHumanFixture>,
  entryHookForSeat?: (seat: Seat) => SessionDriver['committedEntry'],
  driverHooks: Partial<
    Pick<SessionDriver, 'prepareCommand' | 'dispose' | 'privateState' | 'getTimers'>
  > = {},
  nextOverride?: (
    context: LogContext,
    defaultNext: SessionDriver['next'],
  ) => ReturnType<SessionDriver['next']>,
) {
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
            entryHookForSeat?.(seat),
            driverHooks,
            undefined,
            nextOverride,
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

function automaticCommandFixture() {
  const fixture = twoHumanFixture();
  const engine = fixture.engine;
  let enabled = false;
  fixture.engine = {
    ...engine,
    getAutomaticInput(state, privates) {
      if (!enabled) return engine.getAutomaticInput(state, privates);
      const seat = state.turn.activeSeat;
      const privateState = privates.get(seat);
      if (!privateState) return null;
      const command = engine.getLegalCommands(state, seat, privateState).commands[0];
      return command ? { kind: 'command', seat, command } : null;
    },
  };
  return {
    fixture,
    enable: () => {
      enabled = true;
    },
    disable: () => {
      enabled = false;
    },
  };
}

function ownerEvidence(body: { headHash: string; nonce: number; command: CommandShape }) {
  return success({
    protocol: 'test-owner-proof',
    data: { headHash: body.headHash, nonce: body.nonce, command: body.command.type },
  });
}

function voteEquivocationControl(fixture: SessionFixture, seq: number): ExcludeProposerControl {
  const offender = fixture.identities[3];
  if (!offender) throw new Error('Missing offender identity');
  const body = {
    genesisDigest: genesisDigest(fixture.genesis),
    epoch: 0,
    seat: 3 as const,
    seq: seq - 1,
    term: 1,
    phase: 'prevote' as const,
    valueHash: null,
  };
  return {
    kind: 'control',
    action: 'exclude-proposer',
    offender: 3,
    evidence: {
      kind: 'vote-equivocation',
      first: signVote(body, offender.secretKey),
      second: signVote({ ...body, valueHash: 'a'.repeat(64) }, offender.secretKey),
    },
  };
}

describe('P2PSession', () => {
  test('a certified replica retirement clears private ownership and disables actions', async () => {
    const create = vi.spyOn(ReplicatedLog, 'create');
    const fixture = twoHumanFixture();
    const opened = await openTwoHumanSessions(fixture);
    try {
      const session = opened.sessions[0];
      if (!session) throw new Error('Missing local session');
      const callback = create.mock.calls.find(([options]) => options.seat === 0)?.[0].onStatus;
      if (!callback) throw new Error('Missing replica status callback');
      const privateBefore = session.getPrivate(0);
      expect(privateBefore).not.toBeNull();
      const snapshot = session.getState();
      const statuses: string[] = [];
      session.subscribe((update) => statuses.push(update.status.kind));
      // Replica tests establish certificate validation and durable retirement;
      // this test exercises its application callback boundary.
      callback({ kind: 'retired', seat: 0 });
      expect(statuses.at(-1)).toBe('error');
      expect(session.getProtocolStatus()).toEqual({ kind: 'retired', seat: 0 });
      expect(session.controllableSeats()).toEqual([]);
      expect(session.getPrivate(0)).toBeNull();
      expect(session.getPending()).toEqual([]);
      expect(session.getTimers()).toEqual([]);
      expect(session.getLegalCommands(0)).toEqual({ commands: [], templates: [] });
      expect(session.getState()).toEqual(snapshot);
      expect(session.exportSave().mode).toBe('p2p');
    } finally {
      create.mockRestore();
      opened.sessions.forEach((session) => session.dispose());
      opened.net.dispose();
    }
  });

  test('contains subscriber exceptions so later subscribers receive commits and consensus continues', async () => {
    const fixture = twoHumanFixture();
    const opened = await openTwoHumanSessions(fixture);
    const first = opened.sessions[0];
    if (!first) throw new Error('Missing first session');
    const seat = first.getState().turn.activeSeat;
    const owner = opened.sessions[seat];
    if (!owner) throw new Error(`Missing owner for seat ${seat}`);
    const startingRevision = owner.getCommittedHead().seq;
    const throwingUnsubscribe = owner.subscribe((update) => {
      if (update.revision > startingRevision) throw new Error('Injected subscriber failure');
    });
    const laterUpdates: number[] = [];
    const laterUnsubscribe = owner.subscribe((update) => laterUpdates.push(update.revision));
    laterUpdates.length = 0;

    const submitted = owner.submit(seat, placementCommand(owner, seat)).catch(() => undefined);
    await settleNetwork(opened.sessions, opened.clock);
    expect(await submitted).toEqual(success(undefined));

    expect(owner.getCommittedHead().seq).toBeGreaterThan(startingRevision);
    expect(laterUpdates).toContain(owner.getCommittedHead().seq);
    expect(owner.getProtocolStatus()?.kind).not.toBe('halted');
    const nextSeat = owner.getState().turn.activeSeat;
    const nextOwner = opened.sessions[nextSeat];
    if (!nextOwner) throw new Error(`Missing next owner for seat ${nextSeat}`);
    const nextCommand = nextOwner.getLegalCommands(nextSeat).commands[0];
    if (!nextCommand) throw new Error(`No legal command for seat ${nextSeat}`);
    const nextRevision = owner.getCommittedHead().seq;
    const nextSubmitted = nextOwner.submit(nextSeat, nextCommand);
    await settleNetwork(opened.sessions, opened.clock);
    expect(await nextSubmitted).toEqual(success(undefined));
    expect(owner.getCommittedHead().seq).toBe(nextRevision + 1);
    expect(laterUpdates).toContain(owner.getCommittedHead().seq);
    expect(opened.sessions.map((session) => session.getCommittedHead())).toEqual([
      owner.getCommittedHead(),
      owner.getCommittedHead(),
    ]);
    expect(owner.getProtocolStatus()?.kind).not.toBe('halted');
    throwingUnsubscribe();
    laterUnsubscribe();
    opened.sessions.forEach((session) => session.dispose());
    opened.net.dispose();
  });

  test('contains automatic-input exceptions after applying a certified commit', async () => {
    const fixture = twoHumanFixture();
    const engine = fixture.engine;
    const getAutomaticInput = engine.getAutomaticInput.bind(engine);
    let throwOnAutomaticInput = false;
    let automaticInputCalls = 0;
    fixture.engine = {
      ...engine,
      getAutomaticInput: (...args) => {
        automaticInputCalls++;
        if (throwOnAutomaticInput) throw new Error('Injected automatic-input failure');
        return getAutomaticInput(...args);
      },
    };
    const opened = await openTwoHumanSessions(fixture, undefined, {}, (_context, defaultNext) =>
      throwOnAutomaticInput ? null : defaultNext(_context),
    );
    const first = opened.sessions[0];
    if (!first) throw new Error('Missing first session');
    const seat = first.getState().turn.activeSeat;
    const owner = opened.sessions[seat];
    if (!owner) throw new Error(`Missing owner for seat ${seat}`);
    const startingRevision = owner.getCommittedHead().seq;
    const command = placementCommand(owner, seat);
    const unsubscribe = owner.subscribe(() => {
      if (owner.getCommittedHead().seq > startingRevision) throwOnAutomaticInput = true;
    });

    const submitted = owner.submit(seat, command).catch(() => undefined);
    await settleNetwork(opened.sessions, opened.clock);
    await submitted;

    expect(owner.getCommittedHead().seq).toBeGreaterThan(startingRevision);
    expect(owner.getState().board.buildings).toHaveLength(1);
    expect(owner.getProtocolStatus()?.kind).not.toBe('halted');
    expect(owner.getProtocolStatus()).toMatchObject({
      kind: 'rejected',
      code: 'session-automatic-input',
    });
    expect(automaticInputCalls).toBeGreaterThan(0);
    const faultedHead = owner.getCommittedHead();
    expect(owner.getLegalCommands(seat)).toEqual({ commands: [], templates: [] });
    expect(owner.validate(seat, command)).toMatchObject({
      ok: false,
      error: { code: 'automatic-input-unavailable' },
    });
    expect(await owner.submit(seat, command)).toMatchObject({
      ok: false,
      error: { code: 'automatic-input-unavailable' },
    });
    expect(owner.getCommittedHead()).toEqual(faultedHead);
    unsubscribe();
    const other = opened.sessions.find((session) => session !== owner);
    expect(other?.getCommittedHead()).toEqual(owner.getCommittedHead());
    throwOnAutomaticInput = false;
    const road = owner.getLegalCommands(seat).commands.find((item) => item.type === 'PLACE_ROAD');
    if (!road) throw new Error('Expected road placement after getter recovery');
    const recovered = owner.submit(seat, road);
    await settleNetwork(opened.sessions, opened.clock);
    expect(await recovered).toEqual(success(undefined));
    expect(owner.getCommittedHead().seq).toBeGreaterThan(faultedHead.seq);
    expect(other?.getCommittedHead()).toEqual(owner.getCommittedHead());
    opened.sessions.forEach((session) => session.dispose());
    opened.net.dispose();
  });

  test('contains timer projection exceptions after applying a certified commit', async () => {
    const fixture = twoHumanFixture();
    let throwOnTimerProjection = false;
    const opened = await openTwoHumanSessions(fixture, undefined, {
      getTimers() {
        if (throwOnTimerProjection) throw new Error('Injected timer projection failure');
        return [];
      },
    });
    const first = opened.sessions[0];
    if (!first) throw new Error('Missing first session');
    const seat = first.getState().turn.activeSeat;
    const owner = opened.sessions[seat];
    if (!owner) throw new Error(`Missing owner for seat ${seat}`);
    const unsubscribe = opened.sessions.map((session) => session.subscribe(() => undefined));
    throwOnTimerProjection = true;

    const submitted = owner.submit(seat, placementCommand(owner, seat));
    await settleNetwork(opened.sessions, opened.clock);
    expect(await submitted).toEqual(success(undefined));

    expect(opened.sessions.map((session) => session.getCommittedHead())).toEqual([
      owner.getCommittedHead(),
      owner.getCommittedHead(),
    ]);
    expect(owner.getState().board.buildings).toHaveLength(1);
    expect(owner.getProtocolStatus()?.kind).not.toBe('halted');
    unsubscribe.forEach((stop) => stop());
    opened.sessions.forEach((session) => session.dispose());
    opened.net.dispose();
  });

  test('retries an automatic command after a transient proof rejection without an immediate loop', async () => {
    const automatic = automaticCommandFixture();
    let attempts = 0;
    let automaticEnabled = false;
    const opened = await openTwoHumanSessions(automatic.fixture, undefined, {
      prepareCommand(body) {
        if (automaticEnabled) {
          attempts++;
          if (attempts === 1) return failure('proof-temporary', 'Proof source is busy');
        }
        return ownerEvidence(body);
      },
    });
    const session = opened.sessions[0];
    if (!session) throw new Error('Missing first session');
    const seat = session.getState().turn.activeSeat;
    const owner = opened.sessions[seat];
    if (!owner) throw new Error(`Missing owner for seat ${seat}`);
    const before = owner.getCommittedHead().seq;
    const submitted = owner.submit(seat, placementCommand(owner, seat));
    automaticEnabled = true;
    automatic.enable();
    await settleNetwork(opened.sessions, opened.clock);
    expect(await submitted).toEqual(success(undefined));
    expect(attempts).toBe(1);
    expect(owner.getCommittedHead().seq).toBe(before + 1);

    opened.clock.advanceBy(249);
    await settleNetwork(opened.sessions, opened.clock);
    expect(attempts).toBe(1);
    const localPeer = opened.peers[seat];
    const otherPeer = opened.peers.find((peer) => peer !== localPeer);
    if (!localPeer || !otherPeer) throw new Error('Missing automatic retry peers');
    opened.net.disconnect(localPeer, otherPeer);
    opened.clock.advanceBy(1);
    await settleNetwork(opened.sessions, opened.clock);
    expect(attempts).toBe(2);
    expect(owner.getCommittedHead().seq).toBe(before + 1);
    expect(owner.getLegalCommands(seat)).toEqual({ commands: [], templates: [] });
    opened.clock.advanceBy(8_000);
    await settleNetwork(opened.sessions, opened.clock);
    expect(attempts).toBe(2);
    expect(owner.getCommittedHead().seq).toBe(before + 1);
    opened.sessions.forEach((peer) => peer.dispose());
    opened.net.dispose();
  });

  test('retries after validation throws before automatic command admission', async () => {
    const automatic = automaticCommandFixture();
    let automaticEnabled = false;
    let ownerSeat: Seat | null = null;
    let proofAttempts = 0;
    const opened = await openTwoHumanSessions(automatic.fixture, undefined, {
      prepareCommand(body) {
        if (automaticEnabled) {
          proofAttempts++;
          automaticEnabled = false;
          automatic.disable();
        }
        return ownerEvidence(body);
      },
    });
    const session = opened.sessions[0];
    if (!session) throw new Error('Missing first session');
    ownerSeat = session.getState().turn.activeSeat;
    const owner = opened.sessions[ownerSeat];
    if (!owner) throw new Error(`Missing owner for seat ${ownerSeat}`);
    const originalValidate = owner.validate.bind(owner);
    let throwNextValidation = false;
    let validationThrows = 0;
    const validationSpy = vi.spyOn(owner, 'validate').mockImplementation((seat, command) => {
      if (throwNextValidation) {
        throwNextValidation = false;
        validationThrows++;
        throw new Error('Injected automatic validation failure');
      }
      return originalValidate(seat, command);
    });
    const before = owner.getCommittedHead().seq;
    const submitted = owner.submit(ownerSeat, placementCommand(owner, ownerSeat));
    throwNextValidation = true;
    automaticEnabled = true;
    automatic.enable();
    await settleNetwork(opened.sessions, opened.clock);
    expect(await submitted).toEqual(success(undefined));
    expect(validationThrows).toBe(1);
    expect(proofAttempts).toBe(0);
    expect(owner.getProtocolStatus()).toMatchObject({
      kind: 'rejected',
      code: 'session-command-preparation',
    });
    expect(owner.getCommittedHead().seq).toBe(before + 1);

    opened.clock.advanceBy(249);
    await settleNetwork(opened.sessions, opened.clock);
    expect(proofAttempts).toBe(0);
    opened.clock.advanceBy(1);
    await settleNetwork(opened.sessions, opened.clock);
    expect(proofAttempts).toBe(1);
    expect(owner.getCommittedHead().seq).toBe(before + 2);
    validationSpy.mockRestore();
    opened.sessions.forEach((peer) => peer.dispose());
    opened.net.dispose();
  });

  test('does not arm an automatic retry when its diagnostic listener disposes the session', async () => {
    const automatic = automaticCommandFixture();
    let automaticEnabled = false;
    let attempts = 0;
    const opened = await openTwoHumanSessions(automatic.fixture, undefined, {
      prepareCommand(body) {
        if (automaticEnabled) {
          attempts++;
          return failure('proof-temporary', 'Proof source is busy');
        }
        return ownerEvidence(body);
      },
    });
    const session = opened.sessions[0];
    if (!session) throw new Error('Missing first session');
    const seat = session.getState().turn.activeSeat;
    const owner = opened.sessions[seat];
    if (!owner) throw new Error(`Missing owner for seat ${seat}`);
    const unsubscribe = owner.subscribe(() => {
      const status = owner.getProtocolStatus();
      if (status?.kind === 'rejected' && status.code === 'proof-temporary') owner.dispose();
    });
    const submitted = owner.submit(seat, placementCommand(owner, seat));
    automaticEnabled = true;
    automatic.enable();
    await settleNetwork(opened.sessions, opened.clock);
    expect(await submitted).toEqual(success(undefined));
    expect(attempts).toBe(1);
    expect(owner.getProtocolStatus()).toMatchObject({ kind: 'rejected', code: 'proof-temporary' });
    unsubscribe();
    opened.sessions.filter((peer) => peer !== owner).forEach((peer) => peer.dispose());
    opened.net.dispose();
    expect(opened.clock.pendingTimerCount()).toBe(0);
  });

  test('keeps the automatic proof rejection diagnostic when a subscriber throws', async () => {
    const automatic = automaticCommandFixture();
    let automaticEnabled = false;
    let attempts = 0;
    const opened = await openTwoHumanSessions(automatic.fixture, undefined, {
      prepareCommand(body) {
        if (automaticEnabled) {
          attempts++;
          return failure('proof-temporary', 'Proof source is busy');
        }
        return ownerEvidence(body);
      },
    });
    const session = opened.sessions[0];
    if (!session) throw new Error('Missing first session');
    const seat = session.getState().turn.activeSeat;
    const owner = opened.sessions[seat];
    if (!owner) throw new Error(`Missing owner for seat ${seat}`);
    const unsubscribe = owner.subscribe(() => {
      if (owner.getProtocolStatus()?.kind === 'rejected')
        throw new Error('Injected listener failure');
    });
    const submitted = owner.submit(seat, placementCommand(owner, seat));
    automaticEnabled = true;
    automatic.enable();
    await settleNetwork(opened.sessions, opened.clock);
    expect(await submitted).toEqual(success(undefined));
    expect(attempts).toBe(1);
    expect(owner.getProtocolStatus()).toMatchObject({ kind: 'rejected', code: 'proof-temporary' });
    unsubscribe();
    opened.sessions.forEach((peer) => peer.dispose());
    opened.net.dispose();
  });

  test('bounds repeated automatic proof failures and cancels its retry on dispose', async () => {
    const automatic = automaticCommandFixture();
    let automaticEnabled = false;
    let attempts = 0;
    const opened = await openTwoHumanSessions(automatic.fixture, undefined, {
      prepareCommand(body) {
        if (automaticEnabled) {
          attempts++;
          return failure('proof-permanent', 'Proof source remains unavailable');
        }
        return ownerEvidence(body);
      },
    });
    const session = opened.sessions[0];
    if (!session) throw new Error('Missing first session');
    const seat = session.getState().turn.activeSeat;
    const owner = opened.sessions[seat];
    if (!owner) throw new Error(`Missing owner for seat ${seat}`);
    const submitted = owner.submit(seat, placementCommand(owner, seat));
    automaticEnabled = true;
    automatic.enable();
    await settleNetwork(opened.sessions, opened.clock);
    expect(await submitted).toEqual(success(undefined));
    expect(attempts).toBe(1);

    for (const [index, delay] of [250, 500, 1_000, 2_000, 4_000, 4_000].entries()) {
      opened.clock.advanceBy(delay - 1);
      // oxlint-disable-next-line no-await-in-loop -- The retry attempt must settle before asserting its count.
      await settleNetwork(opened.sessions, opened.clock);
      expect(attempts).toBe(index + 1);
      opened.clock.advanceBy(1);
      // oxlint-disable-next-line no-await-in-loop -- The retry attempt must settle before asserting its count.
      await settleNetwork(opened.sessions, opened.clock);
      expect(attempts).toBe(index + 2);
    }

    opened.sessions.forEach((peer) => peer.dispose());
    opened.net.dispose();
    expect(opened.clock.pendingTimerCount()).toBe(0);
    opened.clock.advanceBy(8_000);
    expect(attempts).toBe(7);
  });

  test('a fresh certified parent cancels the old retry and starts with the initial backoff', async () => {
    const automatic = automaticCommandFixture();
    let automaticEnabled = false;
    let attempts = 0;
    const opened = await openTwoHumanSessions(automatic.fixture, undefined, {
      prepareCommand(body) {
        if (automaticEnabled) {
          attempts++;
          return failure('proof-temporary', 'Proof source is busy');
        }
        return ownerEvidence(body);
      },
    });
    const session = opened.sessions[0];
    if (!session) throw new Error('Missing first session');
    let seat = session.getState().turn.activeSeat;
    let owner = opened.sessions[seat];
    if (!owner) throw new Error(`Missing owner for seat ${seat}`);
    const initialSubmit = owner.submit(seat, placementCommand(owner, seat));
    automaticEnabled = true;
    automatic.enable();
    await settleNetwork(opened.sessions, opened.clock);
    expect(await initialSubmit).toEqual(success(undefined));
    expect(attempts).toBe(1);

    automatic.disable();
    seat = owner.getState().turn.activeSeat;
    const nextCommand = owner.getLegalCommands(seat).commands[0];
    if (!nextCommand) throw new Error(`Missing command for next parent seat ${seat}`);
    const beforeParentChange = owner.getCommittedHead().seq;
    automaticEnabled = false;
    const parentChangingSubmit = owner.submit(seat, nextCommand);
    automaticEnabled = true;
    automatic.enable();
    await settleNetwork(opened.sessions, opened.clock);
    expect(await parentChangingSubmit).toEqual(success(undefined));
    expect(owner.getCommittedHead().seq).toBe(beforeParentChange + 1);
    expect(attempts).toBe(2);

    opened.clock.advanceBy(249);
    await settleNetwork(opened.sessions, opened.clock);
    expect(attempts).toBe(2);
    opened.clock.advanceBy(1);
    await settleNetwork(opened.sessions, opened.clock);
    expect(attempts).toBe(3);
    opened.sessions.forEach((peer) => peer.dispose());
    opened.net.dispose();
  });

  test.each(['explicit repair', 'snapshot repair'] as const)(
    'successful %s clears the session error after replaying a retained certificate',
    async (path) => {
      const fixture = fourHumanFixture();
      const baseEngine = fixture.engine;
      let broken = true;
      const engine: Engine = {
        ...baseEngine,
        apply: (state, input) =>
          broken
            ? failure('test-engine-failure', 'Engine cannot derive the certified value')
            : baseEngine.apply(state, input),
      };
      fixture.engine = engine;
      const identities = fixture.identities;
      const local = identities[3];
      const sequencer = identities[0];
      const snapshotPeer = identities[1];
      if (!local || !sequencer || !snapshotPeer) throw new Error('Missing repair identities');
      const clock = new VirtualClock();
      const net = createMemnet({ peers: identities.map(({ peerId }) => peerId), clock });
      const journal = new MemoryProtocolJournal();
      const session = value(
        await P2PSession.create(
          optionsFor(fixture, 3, net.transport(local.peerId), clock, journal),
        ),
      );
      const initial = value(initialProposalContext(fixture.entry, baseEngine, policy));
      const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 3 };
      const applied = value(baseEngine.apply(initial.log.state, input));
      const entry = signEntry(
        {
          seq: 1,
          term: 1,
          prevHash: entryHash(initial.log.head),
          payload: { kind: 'system', input, evidence: stubEvidence(initial.log, input) },
          stateHash: toHex(hashValue(applied.state)),
          sequencer: sequencer.peerId,
        },
        sequencer.secretKey,
      );
      const hash = entryHash(entry);
      const certificate = ([0, 1, 2] as const).map((seat) => {
        const identity = identities[seat];
        if (!identity) throw new Error(`Missing certificate voter ${seat}`);
        return signVote(
          {
            genesisDigest: genesisDigest(fixture.genesis),
            epoch: 0,
            seat,
            seq: 1,
            term: 1,
            phase: 'precommit',
            valueHash: hash,
          },
          identity.secretKey,
        );
      });
      net
        .transport(snapshotPeer.peerId)
        .broadcast(
          value(encodeProtocolMessage({ t: 'COMMIT', certified: { entry, certificate } })),
        );
      await settleNetwork([session], clock);
      expect(session.getProtocolStatus()?.kind).toBe('halted');
      expect((await journal.load())?.height).toBe(1);
      broken = false;

      let repaired: Result<void>;
      if (path === 'explicit repair') {
        repaired = await session.repair();
      } else {
        net.transport(snapshotPeer.peerId).broadcast(
          value(
            encodeProtocolMessage({
              t: 'SNAPSHOT_RES',
              genesisDigest: initial.membership.genesisDigest,
              atSeq: 0,
              snapshot: snapshotFromContext(initial),
            }),
          ),
        );
        await settleNetwork([session], clock);
        repaired = success(undefined);
      }
      expect(repaired).toEqual(success(undefined));

      expect(session.getCommittedHead().seq).toBe(1);
      expect(session.getProtocolStatus()?.kind).not.toBe('halted');
      expect(session.getPending()).toEqual(engine.getPending(session.getState()));
      const localPrivate = session.getPrivate(3);
      if (!localPrivate) throw new Error('Missing local private state after repair');
      expect(session.getLegalCommands(3)).toEqual(
        engine.getLegalCommands(session.getState(), 3, localPrivate),
      );
      expect(session.getLegalCommands(3).commands.length).toBeGreaterThan(0);
      session.dispose();
      net.dispose();
    },
  );

  test('rejects restore when private replay and replica restore observe different certified prefixes', async () => {
    const fixture = twoHumanFixture();
    const opened = await openTwoHumanSessions(fixture);
    const session = opened.sessions[0];
    const sourceJournal = opened.journals[0];
    const peerId = opened.peers[0];
    if (!session || !sourceJournal || !peerId) throw new Error('Missing restore fixture');

    const firstSeat = session.getState().turn.activeSeat;
    const firstOwner = opened.sessions[firstSeat];
    if (!firstOwner) throw new Error(`Missing first setup owner ${firstSeat}`);
    const firstSubmit = firstOwner.submit(firstSeat, placementCommand(firstOwner, firstSeat));
    await settleNetwork(opened.sessions, opened.clock);
    expect(await firstSubmit).toEqual(success(undefined));
    const prefix = await sourceJournal.load();
    if (!prefix) throw new Error('Missing certified prefix snapshot');

    const nextSeat = session.getState().turn.activeSeat;
    const nextOwner = opened.sessions[nextSeat];
    if (!nextOwner) throw new Error(`Missing next setup owner ${nextSeat}`);
    const nextCommand = nextOwner.getLegalCommands(nextSeat).commands[0];
    if (!nextCommand) throw new Error(`Missing second setup command for seat ${nextSeat}`);
    const nextSubmit = nextOwner.submit(nextSeat, nextCommand);
    await settleNetwork(opened.sessions, opened.clock);
    expect(await nextSubmit).toEqual(success(undefined));
    const latest = await sourceJournal.load();
    if (!latest) throw new Error('Missing latest certified history');
    expect(latest.entries).toHaveLength(prefix.entries.length + 1);

    let loads = 0;
    const splitJournal: ProtocolJournal = {
      load: async (): Promise<JournalRecord | null> => {
        loads += 1;
        return loads === 1 ? prefix : sourceJournal.load();
      },
      initialize: (...args) => sourceJournal.initialize(...args),
      loadSafety: (...args) => sourceJournal.loadSafety(...args),
      saveSafety: (...args) => sourceJournal.saveSafety(...args),
      commit: (...args) => sourceJournal.commit(...args),
    };
    opened.sessions.forEach((peer) => peer.dispose());
    const restored = await P2PSession.restore(
      optionsFor(fixture, 0, opened.net.transport(peerId), opened.clock, splitJournal),
    );
    if (restored.ok) restored.value.dispose();
    expect(loads).toBeGreaterThanOrEqual(2);
    expect(restored).toMatchObject({
      ok: false,
      error: { code: 'session-replay-head' },
    });
    opened.net.dispose();
  });

  test('prepares owner evidence before signing and contains failed or mutating proof hooks', async () => {
    const fixture = twoHumanFixture();
    let mode: 'reject' | 'throw' | 'prepare' = 'reject';
    let disposed = 0;
    const opened = await openTwoHumanSessions(fixture, undefined, {
      prepareCommand(body, context) {
        if (mode === 'reject') return failure('test-proof', 'Owner proof unavailable');
        if (mode === 'throw') throw new Error('Injected proof-source failure');
        const evidence = {
          protocol: 'test-owner-proof',
          data: { headHash: body.headHash, nonce: body.nonce, command: body.command.type },
        };
        // Hooks receive snapshots, so they cannot rewrite the pending signed intent.
        Object.assign(body, { nonce: 900 });
        Object.assign(context.head, { stateHash: 'a'.repeat(64) });
        return success(evidence);
      },
      dispose() {
        disposed++;
      },
    });
    const first = opened.sessions[0];
    if (!first) throw new Error('Missing first session');
    const pending = first.getPending().find((item) => item.kind === 'player');
    if (!pending || pending.kind !== 'player') throw new Error('Expected setup placement');
    const session = opened.sessions[pending.seat];
    if (!session) throw new Error('Missing placement owner');
    const command = placementCommand(session, pending.seat);
    const before = session.getCommittedHead();
    const privateBefore = session.getPrivate(pending.seat);
    expect(await session.submit(pending.seat, command)).toMatchObject({
      ok: false,
      error: { code: 'test-proof' },
    });
    mode = 'throw';
    expect(await session.submit(pending.seat, command)).toMatchObject({
      ok: false,
      error: { code: 'session-command-proof' },
    });
    expect(session.getCommittedHead()).toEqual(before);
    expect(session.getPrivate(pending.seat)).toEqual(privateBefore);
    mode = 'prepare';
    const submitted = session.submit(pending.seat, command);
    await settleNetwork(opened.sessions, opened.clock);
    expect(await submitted).toEqual(success(undefined));
    const last = session.exportSave().entries.at(-1)?.entry;
    if (last?.payload.kind !== 'command') throw new Error('Expected certified command');
    expect(last.payload.signed.body).toMatchObject({
      headSeq: before.seq,
      headHash: before.hash,
      nonce: 1,
      evidence: {
        protocol: 'test-owner-proof',
        data: { headHash: before.hash, nonce: 1, command: command.type },
      },
    });
    opened.sessions.forEach((peer) => peer.dispose());
    expect(disposed).toBe(2);
    opened.net.dispose();
  });

  test('committedEntry sees input-null control entries live and during restore', async () => {
    const fixture = fourHumanFixture();
    const seen = new Map<Seat, (ValidatedEntry & CertifiedEntry)[]>();
    const hookForSeat =
      (seat: Seat): SessionDriver['committedEntry'] =>
      (entry) => {
        if (entry.entry.payload.kind === 'control') {
          const entries = seen.get(seat) ?? [];
          entries.push(entry);
          seen.set(seat, entries);
        }
        return success(undefined);
      };
    const opened = await openHumanSessions(fixture, hookForSeat);
    const first = opened.sessions[0];
    if (!first) throw new Error('Missing first peer session');
    const seq = first.getCommittedHead().seq + 1;
    const control = voteEquivocationControl(fixture, seq);
    const packet = value(encodeProtocolMessage({ t: 'ACCUSE', control }));
    opened.net.transport(opened.peers[0] ?? '').broadcast(packet);
    await settleNetwork(opened.sessions, opened.clock);

    const certified = first
      .exportSave()
      .entries.find((item) => item.entry.payload.kind === 'control');
    expect(certified).toBeDefined();
    const expectedState = first.getState();
    const expectedHistory = first.exportSave();
    for (const seat of [0, 1, 2] as const) {
      const controlEntry = seen.get(seat)?.find((entry) => entry.entry.payload.kind === 'control');
      expect(controlEntry?.input).toBeNull();
      expect(controlEntry?.entry.payload).toEqual(control);
      expect(controlEntry?.certificate).toEqual(certified?.certificate);
      expect(controlEntry?.entry.seq).toBe(seq);
    }

    first.dispose();
    opened.sessions.forEach((session) => session.dispose());
    const replaySeen: { input: ValidatedEntry['input']; payload: unknown; seq: number }[] = [];
    const journal = opened.journals[0];
    const peerId = opened.peers[0];
    if (!journal || !peerId) throw new Error('Missing restore fixture');
    const restored = value(
      await P2PSession.restore(
        optionsFor(
          fixture,
          0,
          opened.net.transport(peerId),
          opened.clock,
          journal,
          undefined,
          undefined,
          (entry, _before, after) => {
            if (entry.entry.payload.kind === 'control')
              replaySeen.push({
                input: entry.input,
                payload: { ...entry.entry.payload },
                seq: entry.entry.seq,
              });
            Object.assign(entry.entry.payload, { offender: 2 });
            Object.assign(entry, { crypto: { tampered: true } });
            Object.assign(after, {
              state: fixture.engine.createGame(
                fixture.body.config,
                fromBase64Url(fixture.body.genesisSeed),
              ),
              crypto: { tampered: true },
            });
            return success(undefined);
          },
        ),
      ),
    );
    const replayedControl = replaySeen[0];
    expect(replayedControl?.input).toBeNull();
    expect(replayedControl?.payload).toEqual(control);
    expect(replayedControl?.seq).toBe(seq);
    expect(restored.getState()).toEqual(expectedState);
    expect(restored.exportSave()).toEqual(expectedHistory);
    restored.dispose();
    opened.net.dispose();
  });

  test('committedEntry failure prevents legacy private updates and session publication', async () => {
    const fixture = twoHumanFixture();
    const opened = await openTwoHumanSessions(
      fixture,
      () => (entry) =>
        entry.input?.kind === 'command'
          ? failure('driver-entry-rejected', 'Driver rejected certified input')
          : success(undefined),
    );
    const first = opened.sessions[0];
    if (!first) throw new Error('Missing local session');
    const seat = first.getState().turn.activeSeat;
    const owner = opened.sessions[seat];
    if (!owner) throw new Error(`Missing controller for seat ${seat}`);
    const beforeHead = owner.getCommittedHead();
    const beforeState = owner.getState();
    const beforePrivate = owner.getPrivate(seat);
    const journal = opened.journals[seat];
    const peerId = opened.peers[seat];
    if (!journal || !peerId) throw new Error('Missing owner journal');
    const submitted = owner.submit(seat, placementCommand(owner, seat)).catch(() => undefined);
    await settleNetwork(opened.sessions, opened.clock);
    await submitted;
    expect(owner.getCommittedHead()).toEqual(beforeHead);
    expect(owner.getState()).toEqual(beforeState);
    expect(owner.getPrivate(seat)).toEqual(beforePrivate);
    expect(owner.getProtocolStatus()?.kind).toBe('halted');
    expect(opened.committed.size).toBe(0);
    const saved = await journal.load();
    expect(saved?.entries.at(-1)?.entry.payload.kind).toBe('command');
    opened.sessions.forEach((session) => session.dispose());
    const restored = await P2PSession.restore(
      optionsFor(
        fixture,
        seat,
        opened.net.transport(peerId),
        opened.clock,
        journal,
        undefined,
        undefined,
        (entry) =>
          entry.input?.kind === 'command'
            ? failure('driver-entry-rejected', 'Driver rejected certified input')
            : success(undefined),
      ),
    );
    expect(restored).toMatchObject({
      ok: false,
      error: { code: 'driver-entry-rejected' },
    });
    opened.net.dispose();
  });

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
    const ownedSeatsSeen: Seat[][] = [];
    const session = value(
      await P2PSession.create(
        optionsFor(
          fixture,
          0,
          net.transport(first.peerId),
          clock,
          new MemoryProtocolJournal(),
          new Map([[2, hostedBot.secretKey]]),
          undefined,
          undefined,
          {},
          ownedSeatsSeen,
        ),
      ),
    );
    expect(ownedSeatsSeen).toEqual([[0, 2]]);
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

    const missingStateJournal = new MemoryProtocolJournal();
    const missingState = await P2PSession.create(
      optionsFor(
        fixture,
        0,
        net.transport(first.peerId),
        clock,
        missingStateJournal,
        new Map([[2, hostedBot.secretKey]]),
        undefined,
        undefined,
        { privateState: (seat) => (seat === 0 ? null : null) },
      ),
    );
    expect(missingState).toMatchObject({
      ok: false,
      error: { code: 'session-driver-seats' },
    });
    expect(await missingStateJournal.load()).toBeNull();
    session.dispose();
    expect(session.getPrivate(0)).toBeNull();
    expect(session.getPrivate(2)).toBeNull();
    expect(second.peerId).toBe(peers[1]);
    net.dispose();
  });
});
