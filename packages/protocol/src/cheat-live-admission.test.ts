import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { decodeScalar, proveRange, scalarToBytes, verifyRange } from '@cp2p/crypto';
import { RESOURCES } from '@cp2p/engine';
import type { CommandShape, Resource, Result, Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { composeCommandProofs } from './command-proofs.js';
import { validateCommandForEntry, validateCommandStatement } from './command-validation.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { validateDeckCeremony } from './deck-genesis.js';
import type { ReplayPolicy } from './replay.js';
import { entryHash, genesisDigest } from './genesis.js';
import { createHandSecretSource } from './hand-source.js';
import { handProofContext, proveHandObligation } from './hand-transition.js';
import { MemoryProtocolJournal } from './journal.js';
import { signCommand } from './log.js';
import { encodeProtocolMessage } from './messages.js';
import { P2PSession } from './p2p-session.js';
import { proposerFor } from './proposal.js';
import { replayCertifiedPrefix } from './replay.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import { createMemnet } from './testing/memnet.js';
import { createVerifiedDeckSession } from './testing/verified-deck-session.js';
import type { VirtualClock } from './testing/virtual-clock.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing live admission fixture value');
  return item;
}
async function settle(sessions: readonly P2PSession[], clock: VirtualClock, passes = 32) {
  for (let pass = 0; pass < passes; pass++) {
    clock.advanceBy(100);
    // oxlint-disable-next-line no-await-in-loop -- Deliver the prior consensus phase before advancing again.
    await Promise.all(sessions.map((session) => session.flush()));
  }
}
const costs: Readonly<Record<string, Partial<Record<Resource, number>>>> = {
  BUILD_ROAD: { brick: 1, lumber: 1 },
  BUILD_SETTLEMENT: { brick: 1, lumber: 1, wool: 1, grain: 1 },
  BUILD_CITY: { grain: 2, ore: 3 },
  BUY_DEV_CARD: { wool: 1, grain: 1, ore: 1 },
};

test('a live engine-legal overspend at a certified hidden-steal parent yields an owner finding without applying the spend', async () => {
  const fixture = createVerifiedDeckSession(317, 2, 128);
  const policy: ReplayPolicy = {
    ...fixture.policy,
    genesis: {
      verifyCommitments: (candidate) => validateDeckCeremony(candidate, fixture.deck.transcripts),
    },
  };
  const peers = fixture.humans.map((human) => human.publicKey);
  const network = createMemnet({ peers });
  const drivers = new Map<Seat, VerifiedSessionDriver>();
  const ownerIndex = (seat: Seat) => {
    const owner = required(fixture.genesis.seats.find((item) => item.seat === seat));
    const peer = owner.kind === 'bot' ? owner.botHost : owner.publicKey;
    const index = peers.indexOf(peer);
    if (index < 0) throw new Error('Missing private owner');
    return index;
  };
  const live = (
    await Promise.all(
      fixture.humans.map((human) => {
        const deckSource = fixture.createDeckSourceFor(human.seat);
        return P2PSession.create({
          genesisEntry: fixture.entry,
          engine: fixture.simulation.engine,
          policy,
          seat: human.seat,
          secretKey: required(fixture.simulation.identities.get(human.seat)).secretKey,
          botKeys: fixture.botKeysFor(human.seat),
          transport: network.transport(human.publicKey),
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
          createDriver(engine, genesis, _clock, owned) {
            const driver = new VerifiedSessionDriver(
              engine,
              genesis,
              owned,
              deckSource,
              (seat) =>
                createHandSecretSource(
                  scalarToBytes(BigInt(71 + seat)),
                  genesisDigest(fixture.genesis),
                  seat,
                ),
              fixture.createStealSourceFor(human.seat),
            );
            for (const seat of owned) drivers.set(seat, driver);
            return driver;
          },
        });
      }),
    )
  ).map(value);
  try {
    await settle(live, network.clock);
    let attack: { seat: Seat; command: CommandShape } | null = null;
    for (let step = 0; step < 100 && !attack; step++) {
      const session = required(live[0]);
      const state = session.getState();
      const pending = required(session.getPending().find((item) => item.kind === 'player'));
      if (pending.kind !== 'player') throw new Error('Expected bounded player choice');
      const host = required(live[ownerIndex(pending.seat)]);
      const hand = required(host.getPrivate(pending.seat)).hand;
      const hasSteal = session
        .exportSave()
        .entries.some(
          ({ entry }) =>
            entry.payload.kind === 'system' && entry.payload.input.type === 'STEAL_RESULT',
        );
      if (hasSteal) {
        const publicLegal = fixture.simulation.engine.getLegalCommands(
          state,
          pending.seat,
        ).commands;
        const impossible = publicLegal.find((command) => {
          const cost = costs[command.type];
          return (
            cost && RESOURCES.some((resource) => (hand[resource] ?? 0) < (cost[resource] ?? 0))
          );
        });
        if (impossible && pending.seat >= 2) {
          attack = { seat: pending.seat, command: impossible };
          break;
        }
      }
      const legal = host.getLegalCommands(pending.seat);
      let command: CommandShape | undefined;
      if (legal.templates.some((item) => item.type === 'DISCARD')) {
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
      command ??= legal.commands.find((item) => {
        if (item.type !== 'MOVE_ROBBER') return false;
        const moved = fixture.simulation.engine.apply(state, {
          kind: 'command',
          seat: pending.seat,
          command: item,
        });
        return (
          moved.ok &&
          fixture.simulation.engine
            .getPending(moved.value.state)
            .some((next) => next.kind === 'player' && next.allowed.includes('STEAL'))
        );
      });
      command ??=
        legal.commands.find((item) => item.type === 'ROLL_DICE') ??
        legal.commands.find((item) => item.type === 'END_TURN') ??
        legal.commands[0];
      const completion: { current: Result<void> | null } = { current: null };
      void host.submit(pending.seat, required(command)).then((result) => {
        completion.current = result;
        return undefined;
      });
      // oxlint-disable-next-line no-await-in-loop -- Every choice extends genuinely certified ancestry.
      await settle(live, network.clock);
      if (!completion.current) {
        network.clock.advanceBy(2000);
        // oxlint-disable-next-line no-await-in-loop -- Await the same command certificate.
        await settle(live, network.clock);
      }
      value(required(completion.current));
    }
    if (!attack)
      throw new Error('No real hidden-balance overspend parent within 100 legal choices');
    const saved = required(live[0]).exportSave();
    const context = value(
      replayCertifiedPrefix(fixture.entry, saved.entries, fixture.simulation.engine, policy),
    ).context;
    expect(
      fixture.simulation.engine.validate(context.log.state, {
        kind: 'command',
        seat: attack.seat,
        command: attack.command,
      }).ok,
    ).toBe(true);
    expect(fixture.simulation.engine.checkInvariants(context.log.state)).toEqual([]);
    const actor = required(fixture.simulation.identities.get(attack.seat));
    const driver = required(drivers.get(attack.seat));
    expect(driver['owned'].has(attack.seat)).toBe(true);
    const counts = required(required(live[ownerIndex(attack.seat)]).getPrivate(attack.seat)).hand;
    const blindings = required(driver['blindings'].get(attack.seat));
    const bare = {
      gameId: fixture.genesis.gameId,
      genesisDigest: context.membership.genesisDigest,
      seat: attack.seat,
      nonce: (context.log.lastNonces.get(attack.seat) ?? 0) + 1,
      headSeq: context.log.head.seq,
      headHash: entryHash(context.log.head),
      command: attack.command,
    };
    const statement = value(
      validateCommandStatement(signCommand(bare, actor.secretKey), context.log),
    );
    const plan = required(statement.plan);
    const binding = {
      genesisDigest: bare.genesisDigest,
      epoch: required(context.log.crypto).epoch,
      anchor: { seq: bare.headSeq, hash: bare.headHash },
      command: bare,
    };
    let falseProofs = 0;
    const seed = new Uint8Array(32).fill(44);
    const proofs = plan.obligations.map((obligation, index) => {
      expect(obligation.seat).toBe(attack.seat);
      const count = counts[obligation.resource] ?? 0;
      if (count >= obligation.count)
        return value(proveHandObligation(plan, index, counts, blindings, seed, binding));
      expect(obligation.kind).toBe('range');
      expect(proveHandObligation(plan, index, counts, blindings, seed, binding)).toMatchObject({
        ok: false,
        error: { code: 'hand-proof-witness' },
      });
      falseProofs++;
      const unshifted = { commitment: obligation.commitment, bits: 6 };
      const proofContext = handProofContext(plan, index, binding);
      const proof = proveRange(
        unshifted,
        BigInt(count),
        decodeScalar(blindings[obligation.resource] ?? ''),
        seed,
        proofContext,
      );
      expect(verifyRange(unshifted, proof, proofContext)).toBe(true);
      return {
        kind: 'range' as const,
        seat: attack.seat,
        resource: obligation.resource,
        count: obligation.count,
        proof,
      };
    });
    seed.fill(0);
    expect(falseProofs).toBeGreaterThan(0);
    const evidence = required(composeCommandProofs([], proofs));
    const signed = signCommand({ ...bare, evidence }, actor.secretKey);
    expect(validateCommandForEntry(signed, context.log, context.policy)).toMatchObject({
      ok: false,
      error: { code: 'hand-proof-invalid' },
    });
    const beforeHands = fixture.genesis.config.seats.map((seat) =>
      canonicalEncode(required(required(live[ownerIndex(seat)]).getPrivate(seat))),
    );
    network
      .transport(required(peers[ownerIndex(attack.seat)]))
      .broadcast(value(encodeProtocolMessage({ t: 'SUBMIT', cmd: signed })));
    await settle(live, network.clock);
    for (const session of live) {
      const after = session.exportSave();
      const appended = after.entries.slice(saved.entries.length);
      expect(appended).toHaveLength(1);
      expect(required(appended[0]).certificate).toHaveLength(fixture.humans.length);
      expect(required(appended[0]).entry.payload).toMatchObject({
        kind: 'cheat-proof',
        claim: {
          seat: attack.seat,
          evidence: {
            kind: 'command-proof',
            artifact: signed,
            at: { seq: bare.headSeq, hash: bare.headHash },
          },
        },
      });
      const replayed = value(
        replayCertifiedPrefix(fixture.entry, after.entries, fixture.simulation.engine, policy),
      ).context;
      expect(replayed.log.state).toEqual(context.log.state);
      expect(replayed.excludedProposers).toEqual(context.excludedProposers);
      expect(toHex(hashValue(replayed.log.crypto?.hands))).toBe(
        toHex(hashValue(context.log.crypto?.hands)),
      );
    }
    expect(live[0]?.getCommittedHead()).toEqual(live[1]?.getCommittedHead());
    for (const [index, seat] of fixture.genesis.config.seats.entries())
      expect(canonicalEncode(required(required(live[ownerIndex(seat)]).getPrivate(seat)))).toEqual(
        beforeHands[index],
      );
    // A SUBMIT names its command owner; no invalid outer proposal is supplied.
    expect(proposerFor(bare.headSeq + 1, 1, context.membership).seat).not.toBe(attack.seat);
  } finally {
    for (const session of live) session.dispose();
    network.dispose();
  }
}, 60_000);
