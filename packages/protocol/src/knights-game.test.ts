import { scalarToBytes } from '@cp2p/crypto';
import { RESOURCES, engineForConfig, kindsOfCounts, knightsConfig, knightsExt } from '@cp2p/engine';
import type { CommandShape, Engine, GameConfig, GameState, PrivateState, Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { RandomBot, createBotRng } from '../../bots/src/index.js';
import type { P2PSession } from './p2p-session.js';
import { auditCertifiedGame } from './audit.js';
import { reconstructPrivateSeats } from './private-replay.js';
import { replayCertifiedPrefix } from './replay.js';
import { createTerminalAuditFixture } from './testing/audit-fixture.js';

const COMMODITIES = ['cloth', 'coin', 'paper'];
const yieldTask = () => new Promise<void>((resolve) => setImmediate(resolve));

type Fixture = Awaited<ReturnType<typeof createTerminalAuditFixture>>;

/** Counts the certified entries by command or system type, and commodity player offers. */
function summarize(fixture: Fixture) {
  const counts: Record<string, number> = {};
  let commodityOffers = 0;
  for (const { entry } of fixture.entries) {
    const command = entry.payload.kind === 'command' ? entry.payload.signed.body.command : null;
    const type = command
      ? command.type
      : entry.payload.kind === 'system'
        ? `system:${entry.payload.input.type}`
        : null;
    if (type) counts[type] = (counts[type] ?? 0) + 1;
    if (command?.type === 'OFFER_TRADE') {
      const terms = [command.give, command.want];
      if (
        terms.some(
          (side) =>
            typeof side === 'object' &&
            side !== null &&
            COMMODITIES.some((kind) => Number(Reflect.get(side, kind) ?? 0) > 0),
        )
      )
        commodityOffers += 1;
    }
  }
  return { counts, commodityOffers };
}

function total(hand: Readonly<Record<string, number>>): number {
  return kindsOfCounts(hand).reduce((sum, kind) => sum + (hand[kind] ?? 0), 0);
}

interface PolicyHost {
  getState(): GameState;
  getLegalCommands(seat: Seat): { commands: CommandShape[] };
  getPrivate(seat: Seat): PrivateState | null;
}

/**
 * Random bots, plus a scripted dealer: a seat holding a commodity offers it for a resource a
 * neighbour publicly holds, and every offer is accepted and confirmed. That drives commodity
 * trade proofs (owner-side range proofs over the traded kinds) through the real network.
 */
function policy(config: GameConfig, seed: number, maxTrades: number) {
  const engine = engineForConfig(config);
  const bot = new RandomBot();
  const rng = createBotRng(new Uint8Array(32).fill(seed));
  const offeredTurns = new Set<number>();
  let trades = maxTrades;
  return {
    choosePending<T extends { allowed: string[] }>(pendings: readonly T[]): T | undefined {
      return pendings.find((item) => item.allowed.includes('RESPOND_TRADE')) ?? pendings[0];
    },
    chooseCommand(
      host: PolicyHost,
      pending: Parameters<typeof bot.decide>[1] & { seat: Seat; allowed: string[] },
    ): CommandShape {
      const state = host.getState();
      const legal = host.getLegalCommands(pending.seat).commands;
      const confirm = legal.find((item) => item.type === 'CONFIRM_TRADE');
      if (confirm) return confirm;
      // A bounded number of trades are accepted so the certified log stays short enough to
      // replay in a few seconds of synchronous work; every other offer is declined.
      const accept = legal.find((item) => item.type === 'RESPOND_TRADE' && item.accept === true);
      const decline = legal.find((item) => item.type === 'RESPOND_TRADE' && item.accept === false);
      if (accept && trades > 0) {
        trades -= 1;
        return accept;
      }
      if (decline) return decline;
      const priv = host.getPrivate(pending.seat);
      if (!priv) throw new Error('Game policy lacks its private seat');
      if (
        pending.seat === state.turn.activeSeat &&
        pending.allowed.includes('OFFER_TRADE') &&
        trades > 0 &&
        !offeredTurns.has(state.turn.number)
      )
        for (const give of COMMODITIES) {
          if ((priv.hand[give] ?? 0) < 1) continue;
          for (const other of state.seats) {
            if (other.seat === pending.seat) continue;
            for (const want of RESOURCES) {
              if (other.resources.min[want] < 1) continue;
              const command: CommandShape = {
                type: 'OFFER_TRADE',
                give: { [give]: 1 },
                want: { [want]: 1 },
                to: [other.seat],
              };
              if (!engine.validate(state, { kind: 'command', seat: pending.seat, command }).ok)
                continue;
              offeredTurns.add(state.turn.number);
              return command;
            }
          }
        }
      return bot.decide({ state, priv, seat: pending.seat }, pending, rng);
    },
  };
}

/**
 * Knights K1 and K2 lock the robber until the first barbarian attack (K4), so their games have
 * no steals. Start the same game with the robber free so 7s move it and steal, including cards
 * a seat bought with commodities; K4 will reach this state by playing.
 */
function withFreeRobber(engine: Engine): Engine {
  return {
    ...engine,
    createGame(config, seed) {
      const state = engine.createGame(config, seed);
      return {
        ...state,
        ext: { ...state.ext, knights: { ...knightsExt(state), robberLocked: false } },
      };
    },
  };
}

async function play(
  config: GameConfig,
  seed: number,
  extra: {
    onStep?: (sessions: readonly P2PSession[], state: GameState, step: number) => void;
    stopAfterSteps?: number;
    wrapEngine?: (engine: Engine) => Engine;
    humanCount?: number;
  } = {},
) {
  const dealer = policy(config, seed, 6);
  const captured: { seats: Seat[]; states: Map<Seat, PrivateState | null> }[] = [];
  const fixture = await createTerminalAuditFixture({
    config,
    simulationSeed: seed,
    humanCount: extra.humanCount ?? 2,
    prioritizeDevBuy: false,
    maxElapsedMs: 1_500_000,
    maxSteps: 5_000,
    ...(extra.stopAfterSteps === undefined ? {} : { stopAfterSteps: extra.stopAfterSteps }),
    ...(extra.wrapEngine ? { wrapEngine: extra.wrapEngine } : {}),
    ...(extra.onStep ? { onStep: extra.onStep } : {}),
    yieldTask,
    choosePending: (pendings) => dealer.choosePending(pendings),
    chooseCommand: (host, pending) => dealer.chooseCommand(host, pending),
    onTerminal(sessions) {
      for (const session of sessions) {
        const seats = [...session.controllableSeats()];
        captured.push({
          seats,
          states: new Map(seats.map((seat) => [seat, session.getPrivate(seat)] as const)),
        });
      }
      return Promise.resolve();
    },
  });
  return { fixture, captured };
}

describe('knights over the verified P2P protocol', () => {
  test('a four-seat knights game is committed, proven and audited over eight card kinds', async () => {
    const config = knightsConfig({ seats: 4 });
    const { fixture } = await play(config, 61);
    expect(fixture.terminal).toBe(true);
    const { counts, commodityOffers } = summarize(fixture);
    // Every commodity flow ran through the hidden-hand proofs of a verified game.
    for (const type of [
      'BUILD_IMPROVEMENT',
      'MARITIME_TRADE',
      'DISCARD',
      'BUILD_CITY',
      'CHOOSE_AQUEDUCT',
      'PLACE_METROPOLIS',
      'CONFIRM_TRADE',
    ])
      expect({ type, count: counts[type] ?? 0 }).not.toEqual({ type, count: 0 });
    expect(commodityOffers).toBeGreaterThan(0);
    const replay = replayCertifiedPrefix(
      fixture.genesisEntry,
      fixture.entries,
      fixture.engine,
      fixture.policy,
    );
    if (!replay.ok) throw new Error(replay.error.message);
    const context = replay.value.context.log;
    expect(context.crypto?.hands.every((row) => Object.keys(row.commitments).length === 8)).toBe(
      true,
    );
    expect(kindsOfCounts(context.state.bank)).toEqual([
      'brick',
      'lumber',
      'wool',
      'grain',
      'ore',
      'cloth',
      'coin',
      'paper',
    ]);
    expect(auditCertifiedGame(fixture)).toMatchObject({
      ok: true,
      complete: true,
      missingSeats: [],
      violations: [],
      inputErrors: [],
      historyError: null,
      auditError: null,
    });
  }, 1_800_000);

  test('a five-seat knights-56 game replays to the same private hands as the live sessions', async () => {
    const config = knightsConfig({ seats: 5, fiveSix: true });
    const { fixture, captured } = await play(config, 62, { stopAfterSteps: 300 });
    expect(fixture.terminal).toBe(false);
    const { counts } = summarize(fixture);
    for (const type of ['BUILD_IMPROVEMENT', 'DISCARD', 'END_SBP'])
      expect({ type, count: counts[type] ?? 0 }).not.toEqual({ type, count: 0 });
    // Rebuild every seat from the certified log and its master; each entry's hand openings and
    // the eight-kind commitments must reproduce exactly what the live sessions hold.
    const rebuilt = reconstructPrivateSeats({
      genesisEntry: fixture.genesisEntry,
      entries: fixture.entries,
      engine: fixture.engine,
      policy: fixture.policy,
      secrets: fixture.masters.map(({ seat }) => ({
        seat,
        master: scalarToBytes(BigInt(17 + seat)),
      })),
    });
    if (!rebuilt.ok) throw new Error(`${rebuilt.error.code}: ${rebuilt.error.message}`);
    try {
      for (const session of captured)
        for (const seat of session.seats)
          expect(rebuilt.value.driver.privateState(seat)).toEqual(session.states.get(seat));
      expect(kindsOfCounts(rebuilt.value.context.log.state.bank)).toHaveLength(8);
    } finally {
      rebuilt.value.dispose();
    }
  }, 1_800_000);

  test('hidden steals move commodities under the sealed transfer proofs and audit clean', async () => {
    const config = knightsConfig({ seats: 2 });
    // Between two steps nothing but a settled system input can change a hand, so a one-card move
    // of the same kind between two seats is a hidden steal; the thief's hand reveals its kind.
    let previous = new Map<Seat, Readonly<Record<string, number>>>();
    const stolen: string[] = [];
    const { fixture } = await play(config, 63, {
      wrapEngine: withFreeRobber,
      onStep(sessions) {
        const hands = new Map<Seat, Readonly<Record<string, number>>>();
        for (const session of sessions)
          for (const seat of session.controllableSeats()) {
            const hand = session.getPrivate(seat)?.hand;
            if (hand) hands.set(seat, { ...hand });
          }
        for (const [thief, after] of hands)
          for (const [victim, victimAfter] of hands) {
            const before = previous.get(thief);
            const victimBefore = previous.get(victim);
            if (thief === victim || !before || !victimBefore) continue;
            const gained = kindsOfCounts(after).filter(
              (kind) => (after[kind] ?? 0) > (before[kind] ?? 0),
            );
            const lost = kindsOfCounts(victimAfter).filter(
              (kind) => (victimAfter[kind] ?? 0) < (victimBefore[kind] ?? 0),
            );
            if (
              gained.length === 1 &&
              lost.length === 1 &&
              gained[0] === lost[0] &&
              total(after) === total(before) + 1 &&
              total(victimAfter) === total(victimBefore) - 1
            )
              stolen.push(gained[0] ?? '');
          }
        previous = hands;
      },
    });
    expect(fixture.terminal).toBe(true);
    const { counts } = summarize(fixture);
    expect(counts['system:STEAL_RESULT'] ?? 0).toBeGreaterThan(0);
    expect(stolen.some((kind) => COMMODITIES.includes(kind))).toBe(true);
    expect(auditCertifiedGame(fixture)).toMatchObject({
      ok: true,
      complete: true,
      violations: [],
      inputErrors: [],
      historyError: null,
      auditError: null,
    });
  }, 1_800_000);
});
