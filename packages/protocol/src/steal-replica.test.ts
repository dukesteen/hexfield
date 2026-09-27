import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import {
  DERIVATION_LABELS,
  deriveScalar,
  encodeScalar,
  pedersenCommit,
  proveHiddenTransfer,
  scalarToBytes,
  sealWithEphemeralProof,
  signObject,
} from '@cp2p/crypto';
import { RESOURCES, success } from '@cp2p/engine';
import type { CommandShape, Engine, Resource, Result, Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { entryHash, genesisDigest, signEntry } from './genesis.js';
import { verifyHandOpening } from './hand-commitments.js';
import { createHandSecretSource } from './hand-source.js';
import { MemoryProtocolJournal } from './journal.js';
import { validateNextEntry } from './log.js';
import { decodeProtocolMessage } from './messages.js';
import { P2PSession } from './p2p-session.js';
import { reconstructPrivateSeats } from './private-replay.js';
import { proposerFor } from './proposal.js';
import { replayCertifiedPrefix } from './replay.js';
import type { P2PSessionOptions } from './p2p-session.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import type { StealDeliveryStore } from './steal-contributions.js';
import {
  openStealContribution,
  stealOperationId,
  stealReceiptBinding,
  verifyStealContribution,
  verifyStealReceipt,
} from './steal-delivery.js';
import type { SignedStealContribution, StealOperation } from './steal-delivery.js';
import { verifyStealResult } from './steal-state.js';
import type { StealSourceFactory } from './steal-source.js';
import { createMemnet } from './testing/memnet.js';
import { createVerifiedDeckSession } from './testing/verified-deck-session.js';
import type { VirtualClock } from './testing/virtual-clock.js';
import type { PeerId, Transport } from './transport.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing live steal fixture value');
  return item;
}

async function settle(sessions: readonly P2PSession[], clock: VirtualClock, passes = 16) {
  for (let pass = 0; pass < passes; pass++) {
    // oxlint-disable-next-line no-await-in-loop -- Drain deliveries before the next network pass.
    await Promise.all(sessions.map((session) => session.flush()));
    clock.advanceBy(0);
    // oxlint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all(sessions.map((session) => session.flush()));
}

interface Gate {
  held: boolean;
  sent: Uint8Array[];
}

function gated(inner: Transport, gate: Gate): Transport {
  const drop = (bytes: Uint8Array) => {
    const message = value(decodeProtocolMessage(bytes));
    if (message.t === 'STEAL_CONTRIB') {
      gate.sent.push(bytes.slice());
      return gate.held;
    }
    return (
      gate.held &&
      message.t === 'PROPOSAL' &&
      message.proposal.body.entry.payload.kind === 'crypto' &&
      message.proposal.body.entry.payload.action === 'steal-fixed'
    );
  };
  return {
    self: inner.self,
    peers: () => inner.peers(),
    send(to: PeerId, bytes: Uint8Array) {
      if (!drop(bytes)) inner.send(to, bytes);
    },
    broadcast(bytes: Uint8Array) {
      if (!drop(bytes)) inner.broadcast(bytes);
    },
    onMessage: (listener) => inner.onMessage(listener),
    onPeerChange: (listener) => inner.onPeerChange(listener),
    disconnect: (peer) => inner.disconnect(peer),
  };
}

async function reachFirstSteal(
  live: readonly P2PSession[],
  clock: VirtualClock,
  ownerIndex: (seat: Seat) => number,
  engine: Engine,
  seats: readonly Seat[],
): Promise<{ thief: Seat; victim: Seat }> {
  for (let step = 0; step < 100; step++) {
    const session = required(live[0]);
    const state = session.getState();
    const pending = session.getPending().find((item) => item.kind === 'player');
    if (!pending || pending.kind !== 'player')
      throw new Error(
        `Unexpected pending at step ${step}: ${JSON.stringify(session.getPending())}`,
      );
    const host = required(live[ownerIndex(pending.seat)]);
    const legal = host.getLegalCommands(pending.seat);
    let command: CommandShape | undefined;
    if (legal.templates.some((item) => item.type === 'DISCARD')) {
      const hand = required(host.getPrivate(pending.seat)).hand;
      let remaining = Math.floor(
        required(state.seats.find((item) => item.seat === pending.seat)).resources.total / 2,
      );
      const cards = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
      for (const resource of RESOURCES) {
        cards[resource] = Math.min(hand[resource] ?? 0, remaining);
        remaining -= cards[resource];
      }
      command = { type: 'DISCARD', cards };
    }
    command ??= legal.commands.find((item) => item.type === 'STEAL');
    const victimTarget = command?.type === 'STEAL' ? command.victim : null;
    const victim = seats.find((seat) => seat === victimTarget) ?? null;
    command ??= legal.commands.find((item) => {
      if (item.type !== 'MOVE_ROBBER') return false;
      const moved = engine.apply(state, {
        kind: 'command',
        seat: pending.seat,
        command: item,
      });
      return (
        moved.ok &&
        engine
          .getPending(moved.value.state)
          .some((next) => next.kind === 'player' && next.allowed.includes('STEAL'))
      );
    });
    command ??=
      legal.commands.find((item) => item.type === 'ROLL_DICE') ??
      legal.commands.find((item) => item.type === 'END_TURN') ??
      legal.commands[0];
    if (!command) throw new Error(`No legal command at step ${step}`);
    const completion: { current: Result<void> | null } = { current: null };
    void host.submit(pending.seat, command).then((result) => {
      completion.current = result;
      return undefined;
    });
    // oxlint-disable-next-line no-await-in-loop -- Each command needs the preceding certificate.
    await settle(live, clock, 32);
    if (!completion.current) {
      clock.advanceBy(2_000);
      // oxlint-disable-next-line no-await-in-loop
      await settle(live, clock, 32);
    }
    value(required(completion.current));
    if (victim !== null) return { thief: pending.seat, victim };
  }
  throw new Error('The bounded legal command path did not reach a steal');
}

function mismatchedSealedContribution(
  operation: StealOperation,
  hand: Readonly<Record<string, number>>,
  seed: Uint8Array,
  signingKey: Uint8Array,
): SignedStealContribution {
  const counts: Record<Resource, number> = {
    brick: hand.brick ?? -1,
    lumber: hand.lumber ?? -1,
    wool: hand.wool ?? -1,
    grain: hand.grain ?? -1,
    ore: hand.ore ?? -1,
  };
  // This is the first steal; certified public movements leave all hand blindings at zero.
  const blindings = Object.fromEntries(RESOURCES.map((resource) => [resource, encodeScalar(0n)]));
  value(
    verifyHandOpening(
      [{ seat: operation.victim.seat, commitments: operation.commitments }],
      [operation.victim.seat],
      operation.victim.seat,
      counts,
      blindings,
    ),
  );
  const operationId = stealOperationId(operation);
  const transferBlindings = RESOURCES.map((resource) =>
    deriveScalar(seed, DERIVATION_LABELS.transferBlind, { operationId, resource }),
  );
  let prefix = 0;
  const selected = RESOURCES.findIndex((resource) => {
    prefix += counts[resource];
    return operation.index < prefix;
  });
  if (selected < 0) throw new Error('Frozen index has no private resource');
  const transfer = transferBlindings.map((blinding, index) =>
    pedersenCommit(index === selected ? 1n : 0n, blinding),
  );
  // The public one-hot proof selects the correct card. The sealed opening lies about it.
  const opening = canonicalEncode({
    type: (selected + 1) % RESOURCES.length,
    blindings: transferBlindings.map(encodeScalar),
  });
  const { sealed, ephemeralProof } = sealWithEphemeralProof(
    opening,
    operation.thief.encryptionKey,
    seed,
    { protocol: 'steal-seal-v1', operationId, transfer },
    { protocol: 'steal-ephemeral-v1', operationId, transfer },
  );
  opening.fill(0);
  const proof = proveHiddenTransfer(
    {
      commitments: RESOURCES.map((resource) => operation.commitments[resource]),
      transfer,
      handSize: operation.handSize,
      index: operation.index,
      payloadHash: toHex(hashValue(sealed)),
    },
    {
      counts: RESOURCES.map((resource) => counts[resource]),
      blindings: RESOURCES.map(() => 0n),
      transferBlindings,
    },
    seed,
    { protocol: 'steal-transfer-v1', operationId },
  );
  const body = {
    operationId,
    seat: operation.victim.seat,
    transfer,
    sealed,
    ephemeralProof,
    proof,
  };
  return { body, sig: signObject('steal-contribution', body, signingKey) };
}

test('a live hidden steal survives a dropped delivery and restart with one private transfer', async () => {
  const fixture = createVerifiedDeckSession(317, 2, 128);
  const peers = fixture.humans.map((human) => human.publicKey);
  const network = createMemnet({ peers });
  const gate: Gate = { held: true, sent: [] };
  const stealStoreLoads = new Map<PeerId, { count: () => number; proofSeeds: () => number }>();
  const options: P2PSessionOptions[] = fixture.humans.map((human) => {
    const deckSource = fixture.createDeckSourceFor(human.seat);
    const createSource = fixture.createStealSourceFor(human.seat);
    const digest = genesisDigest(fixture.genesis);
    const backingStore = new MemoryStealDeliveryStore();
    let loadCount = 0;
    let transferProofSeeds = 0;
    const stealSource: StealSourceFactory = (seat) => {
      const source = createSource(seat);
      return {
        encryptionSecret: () => source.encryptionSecret(),
        proofSeed(role, context) {
          if (role === 'transfer') transferProofSeeds += 1;
          return source.proofSeed(role, context);
        },
        dispose: () => source.dispose(),
      };
    };
    const stealDeliveryStore: StealDeliveryStore = {
      async load(id) {
        loadCount += 1;
        return backingStore.load(id);
      },
      putIfAbsent: (id, bytes) => backingStore.putIfAbsent(id, bytes),
    };
    stealStoreLoads.set(human.publicKey, {
      count: () => loadCount,
      proofSeeds: () => transferProofSeeds,
    });
    return {
      genesisEntry: fixture.entry,
      engine: fixture.simulation.engine,
      policy: fixture.policy,
      seat: human.seat,
      secretKey: required(fixture.simulation.identities.get(human.seat)).secretKey,
      botKeys: fixture.botKeysFor(human.seat),
      transport: gated(network.transport(human.publicKey), gate),
      clock: network.clock,
      journal: new MemoryProtocolJournal(),
      cheatCandidateStore: new MemoryCheatCandidateStore(),
      beaconSource: fixture.beaconSourceFor(human.seat),
      beaconContributions: new MemoryBeaconContributionStore(),
      deckSetupPasses: fixture.deckSetupPasses,
      createDeckSource: deckSource,
      deckContributions: new MemoryStealDeliveryStore(),
      countContributionStore: new MemoryCountContributionStore(),
      stealDeliveryStore,
      createDriver: (engine, genesis, _clock, owned) =>
        new VerifiedSessionDriver(
          engine,
          genesis,
          owned,
          deckSource,
          (seat) => createHandSecretSource(scalarToBytes(BigInt(71 + seat)), digest, seat),
          stealSource,
        ),
    };
  });
  let live = (await Promise.all(options.map((item) => P2PSession.create(item)))).map(value);
  const ownerIndex = (seat: Seat): number => {
    const owner = required(fixture.genesis.seats.find((item) => item.seat === seat));
    const peer = owner.kind === 'bot' ? owner.botHost : owner.publicKey;
    const index = peers.indexOf(peer);
    if (index < 0) throw new Error('Missing private owner');
    return index;
  };
  const allHands = () =>
    fixture.genesis.config.seats.map((seat) =>
      required(required(live[ownerIndex(seat)]).getPrivate(seat)),
    );
  try {
    await settle(live, network.clock, 32);
    const { thief: thiefSeat, victim: victimSeat } = await reachFirstSteal(
      live,
      network.clock,
      ownerIndex,
      fixture.simulation.engine,
      fixture.genesis.config.seats,
    );
    expect(gate.sent.length).toBeGreaterThan(0);
    const firstDelivery = required(gate.sent[0]);
    const victimOwner = peers[ownerIndex(victimSeat)];
    const victimStore = required(stealStoreLoads.get(required(victimOwner)));
    const loadsBeforePulse = victimStore.count();
    const proofSeedsBeforePulse = victimStore.proofSeeds();
    expect(loadsBeforePulse).toBeGreaterThan(0);
    expect(proofSeedsBeforePulse).toBeGreaterThan(0);
    const sendsBeforePulse = gate.sent.length;
    network.clock.advanceBy(2_000);
    await settle(live, network.clock, 32);
    expect(gate.sent.length).toBeGreaterThan(sendsBeforePulse);
    expect(victimStore.count()).toBe(loadsBeforePulse);
    expect(victimStore.proofSeeds()).toBe(proofSeedsBeforePulse);
    for (const bytes of gate.sent) expect(bytes).toEqual(firstDelivery);
    const before = allHands();
    const publicBefore = required(live[0]).getState();
    for (const session of live) session.dispose();
    const sentBeforeRestore = gate.sent.length;
    live = (await Promise.all(options.map((item) => P2PSession.restore(item)))).map(value);
    await settle(live, network.clock, 32);
    expect(allHands()).toEqual(before);
    expect(required(live[0]).getState()).toEqual(publicBefore);
    expect(gate.sent.length).toBeGreaterThan(sentBeforeRestore);
    for (const bytes of gate.sent) expect(bytes).toEqual(firstDelivery);
    gate.held = false;
    const stealResults = () =>
      required(live[0])
        .exportSave()
        .entries.filter(
          ({ entry }) =>
            entry.payload.kind === 'system' && entry.payload.input.type === 'STEAL_RESULT',
        );
    for (let attempt = 0; attempt < 8 && stealResults().length === 0; attempt++) {
      network.clock.advanceBy(1_000);
      // oxlint-disable-next-line no-await-in-loop -- Each virtual tick can schedule the next consensus phase.
      await settle(live, network.clock, 16);
    }
    const results = stealResults();
    expect(results).toHaveLength(1);
    const after = allHands();
    const botSeats = fixture.genesis.seats
      .filter((seat) => seat.kind === 'bot')
      .map((seat) => seat.seat);
    expect(botSeats.some((seat) => seat === thiefSeat || seat === victimSeat)).toBe(true);
    const reconstructed = value(
      reconstructPrivateSeats({
        genesisEntry: fixture.entry,
        entries: required(live[0]).exportSave().entries,
        engine: fixture.simulation.engine,
        policy: fixture.policy,
        secrets: botSeats.map((seat) => ({ seat, master: scalarToBytes(BigInt(17 + seat)) })),
      }),
    );
    try {
      for (const seat of botSeats)
        expect(reconstructed.driver.privateState(seat)).toEqual(
          required(after.find((hand) => hand.seat === seat)),
        );
    } finally {
      reconstructed.dispose();
    }
    const thiefBefore = required(before.find((item) => item.seat === thiefSeat));
    const thiefAfter = required(after.find((item) => item.seat === thiefSeat));
    const victimBefore = required(before.find((item) => item.seat === victimSeat));
    const victimAfter = required(after.find((item) => item.seat === victimSeat));
    const gained = RESOURCES.filter(
      (resource) => (thiefAfter.hand[resource] ?? 0) === (thiefBefore.hand[resource] ?? 0) + 1,
    );
    expect(gained).toHaveLength(1);
    for (const resource of RESOURCES) {
      const delta = resource === gained[0] ? 1 : 0;
      expect(thiefAfter.hand[resource]).toBe((thiefBefore.hand[resource] ?? 0) + delta);
      expect(victimAfter.hand[resource]).toBe((victimBefore.hand[resource] ?? 0) - delta);
    }
    for (const peer of live) expect(peer.getState()).toEqual(required(live[0]).getState());
    for (const session of live) session.dispose();
    live = (await Promise.all(options.map((item) => P2PSession.restore(item)))).map(value);
    await settle(live, network.clock, 16);
    expect(allHands()).toEqual(after);
    expect(
      required(live[0])
        .exportSave()
        .entries.filter(
          ({ entry }) =>
            entry.payload.kind === 'system' && entry.payload.input.type === 'STEAL_RESULT',
        ),
    ).toHaveLength(1);
  } finally {
    for (const session of live) session.dispose();
  }
}, 60_000);

test('a certified bad sealed steal opening yields a victim finding without a steal result', async () => {
  const fixture = createVerifiedDeckSession(317, 2, 128);
  const peers = fixture.humans.map((human) => human.publicKey);
  const network = createMemnet({ peers });
  const gate: Gate = { held: true, sent: [] };
  const digest = genesisDigest(fixture.genesis);
  const options: P2PSessionOptions[] = fixture.humans.map((human) => {
    const deckSource = fixture.createDeckSourceFor(human.seat);
    const stealSource = fixture.createStealSourceFor(human.seat);
    return {
      genesisEntry: fixture.entry,
      engine: fixture.simulation.engine,
      policy: fixture.policy,
      seat: human.seat,
      secretKey: required(fixture.simulation.identities.get(human.seat)).secretKey,
      botKeys: fixture.botKeysFor(human.seat),
      transport: gated(network.transport(human.publicKey), gate),
      clock: network.clock,
      journal: new MemoryProtocolJournal(),
      cheatCandidateStore: new MemoryCheatCandidateStore(),
      beaconSource: fixture.beaconSourceFor(human.seat),
      beaconContributions: new MemoryBeaconContributionStore(),
      deckSetupPasses: fixture.deckSetupPasses,
      createDeckSource: deckSource,
      deckContributions: new MemoryStealDeliveryStore(),
      countContributionStore: new MemoryCountContributionStore(),
      stealDeliveryStore: new MemoryStealDeliveryStore(),
      createDriver: (engine, genesis, _clock, owned) => {
        const driver = new VerifiedSessionDriver(
          engine,
          genesis,
          owned,
          deckSource,
          (seat) => createHandSecretSource(scalarToBytes(BigInt(71 + seat)), digest, seat),
          stealSource,
        );
        driver.produceStealContribution = (operation, seat, _context, signingKey) => {
          const hand = required(driver.privateState(seat)).hand;
          const source = stealSource(seat);
          const seed = source.proofSeed('transfer', {
            protocol: 'steal-transfer-source-v1',
            operationId: stealOperationId(operation),
          });
          try {
            return success(mismatchedSealedContribution(operation, hand, seed, signingKey));
          } finally {
            seed.fill(0);
            source.dispose();
          }
        };
        return driver;
      },
    };
  });
  const live = (await Promise.all(options.map((item) => P2PSession.create(item)))).map(value);
  const ownerIndex = (seat: Seat): number => {
    const owner = required(fixture.genesis.seats.find((item) => item.seat === seat));
    const peer = owner.kind === 'bot' ? owner.botHost : owner.publicKey;
    const index = peers.indexOf(peer);
    if (index < 0) throw new Error('Missing private owner');
    return index;
  };
  const entries = () => required(live[0]).exportSave().entries;
  try {
    await settle(live, network.clock, 32);
    const { victim } = await reachFirstSteal(
      live,
      network.clock,
      ownerIndex,
      fixture.simulation.engine,
      fixture.genesis.config.seats,
    );
    const privateBefore = fixture.genesis.config.seats.map((seat) =>
      required(required(live[ownerIndex(seat)]).getPrivate(seat)),
    );
    const publicBefore = required(live[0]).getState();
    const parent = value(
      replayCertifiedPrefix(fixture.entry, entries(), fixture.simulation.engine, fixture.policy),
    ).context.log;
    const operation = required(parent.crypto?.steal).operation;
    expect(required(parent.crypto?.steal).fixed).toBeNull();
    const delivery = value(decodeProtocolMessage(required(gate.sent[0])));
    if (delivery.t !== 'STEAL_CONTRIB') throw new Error('Expected signed steal contribution');
    expect(verifyStealContribution(delivery.contribution, operation).ok).toBe(true);
    const thiefHost = required(fixture.humans[ownerIndex(operation.thief.seat)]);
    const thiefSource = fixture.createStealSourceFor(thiefHost.seat)(operation.thief.seat);
    try {
      expect(
        openStealContribution(operation, delivery.contribution, thiefSource.encryptionSecret()),
      ).toMatchObject({ ok: false, error: { code: 'steal-opening-mismatch' } });
    } finally {
      thiefSource.dispose();
    }
    gate.held = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      network.clock.advanceBy(1_000);
      // oxlint-disable-next-line no-await-in-loop -- Each tick can certify the next steal stage.
      await settle(live, network.clock, 16);
      if (
        entries().some(
          ({ entry }) =>
            entry.payload.kind === 'cheat-proof' &&
            entry.payload.claim.evidence.kind === 'bad-steal-delivery',
        )
      )
        break;
    }
    for (let tick = 0; tick < 3; tick++) {
      network.clock.advanceBy(1_000);
      // oxlint-disable-next-line no-await-in-loop -- Check that later consensus pulses do not complete the steal.
      await settle(live, network.clock, 8);
    }
    const committed = entries();
    const fixed = committed.filter(
      ({ entry }) => entry.payload.kind === 'crypto' && entry.payload.action === 'steal-fixed',
    );
    const disputes = committed.filter(
      ({ entry }) => entry.payload.kind === 'crypto' && entry.payload.action === 'steal-dispute',
    );
    const findings = committed.filter(
      ({ entry }) =>
        entry.payload.kind === 'cheat-proof' &&
        entry.payload.claim.evidence.kind === 'bad-steal-delivery',
    );
    expect(fixed).toHaveLength(1);
    expect(disputes).toHaveLength(1);
    expect(findings).toHaveLength(1);
    const fixedPayload = required(fixed[0]).entry.payload;
    if (fixedPayload.kind !== 'crypto' || fixedPayload.action !== 'steal-fixed')
      throw new Error('Expected certified fixed contribution');
    expect(toHex(hashValue(fixedPayload.evidence))).toBe(toHex(hashValue(delivery.contribution)));
    const finding = required(findings[0]).entry.payload;
    if (finding.kind !== 'cheat-proof') throw new Error('Expected certified victim finding');
    expect(finding.claim.seat).toBe(victim);
    expect(finding.claim.evidence.kind).toBe('bad-steal-delivery');
    expect(committed.some(({ entry }) => entry.payload.kind === 'control')).toBe(false);
    const replayed = value(
      replayCertifiedPrefix(fixture.entry, committed, fixture.simulation.engine, fixture.policy),
    ).context;
    const disputed = required(replayed.log.crypto?.steal);
    expect(disputed.dispute).not.toBeNull();
    const receiptBody = stealReceiptBinding(required(disputed.fixed));
    const thiefKey = required(fixture.simulation.identities.get(operation.thief.seat)).secretKey;
    const receipt = { body: receiptBody, sig: signObject('steal-receipt', receiptBody, thiefKey) };
    expect(verifyStealReceipt(receipt, required(disputed.fixed)).ok).toBe(true);
    const resultInput = {
      kind: 'system' as const,
      type: 'STEAL_RESULT' as const,
      thief: operation.thief.seat,
      victim: operation.victim.seat,
      resource: 'hidden' as const,
    };
    const resultEvidence = { kind: 'proof' as const, protocol: 'hidden-steal-v1', data: receipt };
    expect(verifyStealResult(disputed, resultInput, resultEvidence)).toMatchObject({
      ok: false,
      error: { code: 'steal-result-state' },
    });
    const next = proposerFor(replayed.log.head.seq + 1, 1, replayed.membership);
    const resultEntry = signEntry(
      {
        seq: replayed.log.head.seq + 1,
        term: 1,
        prevHash: entryHash(replayed.log.head),
        payload: { kind: 'system', input: resultInput, evidence: resultEvidence },
        stateHash: replayed.log.head.stateHash,
        sequencer: next.publicKey,
      },
      required(fixture.simulation.identities.get(next.seat)).secretKey,
    );
    expect(
      validateNextEntry(resultEntry, replayed.log, {
        ...replayed.policy,
        term: 1,
        sequencer: next.publicKey,
      }),
    ).toMatchObject({ ok: false, error: { code: 'steal-result-state' } });
    expect(
      committed.some(
        ({ entry }) =>
          entry.payload.kind === 'system' && entry.payload.input.type === 'STEAL_RESULT',
      ),
    ).toBe(false);
    expect(required(live[0]).getState()).toEqual(publicBefore);
    for (const seat of fixture.genesis.config.seats)
      expect(required(live[ownerIndex(seat)]).getPrivate(seat)).toEqual(
        required(privateBefore.find((item) => item.seat === seat)),
      );
    for (const session of live) expect(session.exportSave().entries).toEqual(committed);
  } finally {
    for (const session of live) session.dispose();
  }
}, 60_000);
