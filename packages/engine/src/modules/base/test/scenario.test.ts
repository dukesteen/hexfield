import { describe, expect, test } from 'vitest';
import { createBaseEngine } from '../../../index.js';
import type { Engine } from '../../../core/pipeline/engine.js';
import type { LocalGame, LocalRandomSource } from '../../../core/pipeline/localGame.js';
import type { GameConfig, GameState } from '../../../core/state/types.js';
import type { Resource, ResourceCounts, Result, Seat } from '../../../core/types/index.js';
import { failure } from '../../../core/types/index.js';
import { harborRate, verticesForHex } from '../board/index.js';
import { legalCityVertices, legalRoadEdges, legalSettlementVertices } from '../placement/index.js';
import { scenario } from './scenario.js';

const SEED = new Uint8Array(32).fill(42);
const RESOURCES = ['brick', 'lumber', 'wool', 'grain', 'ore'] as const;
const TERRAIN_RESOURCE: Readonly<Record<string, Resource | undefined>> = {
  hills: 'brick',
  forest: 'lumber',
  pasture: 'wool',
  fields: 'grain',
  mountains: 'ore',
};
const PIPS: Readonly<Record<number, number>> = {
  2: 1,
  3: 2,
  4: 3,
  5: 4,
  6: 5,
  8: 5,
  9: 4,
  10: 3,
  11: 2,
  12: 1,
};
const COSTS: Readonly<Record<'road' | 'settlement' | 'city', ResourceCounts>> = {
  road: { brick: 1, lumber: 1, wool: 0, grain: 0, ore: 0 },
  settlement: { brick: 1, lumber: 1, wool: 1, grain: 1, ore: 0 },
  city: { brick: 0, lumber: 0, wool: 0, grain: 2, ore: 3 },
};

function zeroes(): Record<Resource, number> {
  return { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
}

function createFourPlayerGame(): { engine: Engine; config: GameConfig } {
  return {
    engine: createBaseEngine(),
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2, 3],
      options: { base: { strictBalance: true } },
    },
  };
}

function handFor(game: LocalGame, seat: Seat): ResourceCounts | undefined {
  const hand = game.privateState(seat)?.hand;
  if (!hand || !RESOURCES.every((resource) => Number.isSafeInteger(hand[resource])))
    return undefined;
  return {
    brick: hand.brick ?? 0,
    lumber: hand.lumber ?? 0,
    wool: hand.wool ?? 0,
    grain: hand.grain ?? 0,
    ore: hand.ore ?? 0,
  };
}

function setupChooser(
  state: Readonly<GameState>,
  seat: Seat,
  index: number,
  legalVertices: readonly string[],
): string {
  const alreadyProduces = new Set<Resource>();
  for (const building of state.board.buildings) {
    if (building.seat !== seat) continue;
    for (const hex of state.board.hexes) {
      if (!verticesForHex(state, hex.id).includes(building.vertex)) continue;
      const resource = TERRAIN_RESOURCE[hex.terrain];
      if (resource) alreadyProduces.add(resource);
    }
  }
  const score = (vertex: string): number => {
    const adjacent = state.board.hexes.filter((hex) =>
      verticesForHex(state, hex.id).includes(vertex),
    );
    const newResources = new Set<Resource>();
    for (const hex of adjacent) {
      const resource = TERRAIN_RESOURCE[hex.terrain];
      if (resource && !alreadyProduces.has(resource)) newResources.add(resource);
    }
    const pips = adjacent.reduce((sum, hex) => sum + (PIPS[hex.token ?? 0] ?? 0), 0);
    return newResources.size * 100 + pips * 2 + (index >= 4 ? adjacent.length * 3 : 0);
  };
  return (
    legalVertices.toSorted(
      (left, right) => score(right) - score(left) || (left < right ? -1 : left > right ? 1 : 0),
    )[0] ?? ''
  );
}

function targetCost(state: Readonly<GameState>, seat: Seat): ResourceCounts {
  const inventory = state.seats.find((item) => item.seat === seat);
  if (!inventory) return COSTS.road;
  if ((inventory.piecesLeft.settlement ?? 0) > 0 && legalSettlementVertices(state, seat).length > 0)
    return COSTS.settlement;
  if ((inventory.piecesLeft.city ?? 0) > 0 && legalCityVertices(state, seat).length > 0)
    return COSTS.city;
  if ((inventory.piecesLeft.road ?? 0) > 0 && legalRoadEdges(state, seat).length > 0)
    return COSTS.road;
  return COSTS.settlement;
}

function chooseDice(state: Readonly<GameState>, hand: ResourceCounts): readonly [number, number] {
  const seat = state.turn.activeSeat;
  const cost = targetCost(state, seat);
  let bestTotal = 6;
  let bestScore = -1;
  for (let total = 2; total <= 12; total += 1) {
    if (total === 7) continue;
    let score = 0;
    for (const hex of state.board.hexes) {
      if (hex.token !== total || hex.id === state.board.robberHex) continue;
      const resource = TERRAIN_RESOURCE[hex.terrain];
      if (!resource) continue;
      const adjacent = verticesForHex(state, hex.id);
      const amount = state.board.buildings
        .filter((building) => building.seat === seat && adjacent.includes(building.vertex))
        .reduce((sum, building) => sum + (building.kind === 'city' ? 2 : 1), 0);
      const deficit = Math.max(0, cost[resource] - hand[resource]);
      score += amount * (deficit > 0 ? 10 : 1) * (PIPS[total] ?? 1);
    }
    if (score > bestScore) {
      bestTotal = total;
      bestScore = score;
    }
  }
  return bestTotal <= 6 ? [1, bestTotal - 1] : [bestTotal - 6, 6];
}

function randomSource(): LocalRandomSource {
  return {
    resolve: (pending, state, privates) => {
      if (pending.systemType === 'START_SEAT')
        return { input: { kind: 'system', type: 'START_SEAT', seat: 0 } };
      if (pending.systemType === 'DICE_RESULT') {
        const hand = privates.get(state.turn.activeSeat)?.hand;
        if (!hand) throw new Error(`Missing hand for seat ${state.turn.activeSeat}`);
        const counts = zeroes();
        for (const resource of RESOURCES) counts[resource] = hand[resource] ?? 0;
        return {
          input: { kind: 'system', type: 'DICE_RESULT', dice: chooseDice(state, counts) },
        };
      }
      throw new Error(`Unexpected random request ${pending.systemType}`);
    },
  };
}

function planFor(
  state: GameState,
  seat: Seat,
): {
  kind: 'road' | 'settlement' | 'city';
  location: string;
  cost: ResourceCounts;
} | null {
  const inventory = state.seats.find((item) => item.seat === seat);
  if (!inventory) return null;
  const settlement =
    (inventory.piecesLeft.settlement ?? 0) > 0
      ? legalSettlementVertices(state, seat)[0]
      : undefined;
  if (settlement) return { kind: 'settlement', location: settlement, cost: COSTS.settlement };
  const city = (inventory.piecesLeft.city ?? 0) > 0 ? legalCityVertices(state, seat)[0] : undefined;
  if (city) return { kind: 'city', location: city, cost: COSTS.city };
  const road = (inventory.piecesLeft.road ?? 0) > 0 ? legalRoadEdges(state, seat)[0] : undefined;
  return road ? { kind: 'road', location: road, cost: COSTS.road } : null;
}

function canPay(hand: ResourceCounts, cost: ResourceCounts): boolean {
  return RESOURCES.every((resource) => hand[resource] >= cost[resource]);
}

function maritimeStep(game: LocalGame, seat: Seat, cost: ResourceCounts): boolean {
  const hand = handFor(game, seat);
  if (!hand) return false;
  for (const target of RESOURCES) {
    const needed = cost[target] - hand[target];
    if (needed <= 0 || (game.state.bank[target] ?? 0) <= 0) continue;
    for (const source of RESOURCES) {
      if (source === target) continue;
      const current = handFor(game, seat);
      if (!current) return false;
      const rate = harborRate(game.snapshot(), seat, source);
      const surplus = Math.max(0, current[source] - cost[source]);
      const amount = Math.min(needed, Math.floor(surplus / rate), game.state.bank[target] ?? 0);
      if (amount === 0) continue;
      const give = zeroes();
      const get = zeroes();
      give[source] = amount * rate;
      get[target] = amount;
      if (
        game.submit({
          kind: 'command',
          seat,
          command: { type: 'MARITIME_TRADE', give, get },
        }).ok
      )
        return true;
    }
  }
  return false;
}

function playFullGame(game: LocalGame, engine: Engine): Result<unknown> {
  for (let turn = 0; turn < 500 && !game.state.result; turn += 1) {
    const seat = game.state.turn.activeSeat;
    if (game.state.turn.phase.at(-1)?.id !== 'preRoll')
      return failure('scenario-phase', `Expected preRoll for seat ${seat}`);
    const roll = game.submit({ kind: 'command', seat, command: { type: 'ROLL_DICE' } });
    if (!roll.ok) return roll;

    for (let action = 0; action < 8 && !game.state.result; action += 1) {
      if (game.state.turn.phase.at(-1)?.id !== 'main') break;
      const plan = planFor(game.snapshot(), seat);
      if (!plan) break;
      const hand = handFor(game, seat);
      if (!hand) return failure('scenario-hand', `No private hand for seat ${seat}`);
      if (!canPay(hand, plan.cost)) {
        if (maritimeStep(game, seat, plan.cost)) continue;
        break;
      }
      const type = `BUILD_${plan.kind.toUpperCase()}`;
      const locationKey = plan.kind === 'road' ? 'edge' : 'vertex';
      const built = game.submit({
        kind: 'command',
        seat,
        command: { type, [locationKey]: plan.location },
      });
      if (!built.ok) return built;
    }
    if (game.state.result) break;
    if (game.state.turn.phase.at(-1)?.id === 'main') {
      const ended = game.submit({ kind: 'command', seat, command: { type: 'END_TURN' } });
      if (!ended.ok) return ended;
    }
    if (!game.state.result && engine.getPending(game.snapshot()).length === 0)
      return failure('scenario-pending', 'Live game has no pending input');
  }
  return game.state.result
    ? { ok: true, value: game.state.result }
    : failure('scenario-limit', 'No seat reached 10 points in 500 turns');
}

describe('base scenario harness', () => {
  test('accepts every declared option mode and rejects invalid option values', () => {
    const { engine } = createFourPlayerGame();
    const variants: readonly Record<string, unknown>[] = [
      { mapLayout: 'random' },
      { mapLayout: 'balanced-random', strictBalance: true },
      { diceMode: 'random' },
      { diceMode: 'balanced' },
      { friendlyRobber: true, playerTrades: false, hideBankCounts: true },
      { discardLimit: 0, vpTarget: 3 },
      { discardLimit: 9, vpTarget: 20 },
      { turnTimer: { preRollSec: 30, mainSec: 60, discardSec: 20, robberSec: 15 } },
    ];
    for (const base of variants) {
      expect(() =>
        engine.createGame(
          {
            modules: [{ id: 'base', version: '1.0.0' }],
            seats: [0, 1, 2, 3],
            options: { base },
          },
          SEED,
        ),
      ).not.toThrow();
    }
    for (const base of [
      { vpTarget: 2 },
      { vpTarget: 21 },
      { mapLayout: 'unknown' },
      { turnTimer: { preRollSec: 0, mainSec: 1, discardSec: 1, robberSec: 1 } },
    ]) {
      expect(() =>
        engine.createGame(
          {
            modules: [{ id: 'base', version: '1.0.0' }],
            seats: [0, 1, 2, 3],
            options: { base },
          },
          SEED,
        ),
      ).toThrow(/invalid|unsupported|between|vpTarget|option|timer/i);
    }
  });

  test('completes a four-player game through LocalGame at the default target', () => {
    const { engine, config } = createFourPlayerGame();
    const result = scenario(engine, config, randomSource())
      .seed(SEED)
      .setup(setupChooser)
      .script(playFullGame)
      .run();

    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    const game = result.value;
    expect(game.state.config.options.base).toMatchObject({ vpTarget: 10 });
    expect(game.state.config.seats).toEqual([0, 1, 2, 3]);
    expect(game.state.result).toMatchObject({ winner: expect.any(Number) });
    const winner = game.state.result?.winner;
    if (winner === undefined) throw new Error('Completed game did not record a winner');
    const winnerState = game.state.seats.find((seat) => seat.seat === winner);
    const winnerPrivate = game.privateState(winner);
    const hiddenVictoryPoints = Object.values(winnerPrivate?.slots ?? {}).filter(
      (card) => card === 'victoryPoint',
    ).length;
    expect((winnerState?.publicVp ?? 0) + hiddenVictoryPoints).toBeGreaterThanOrEqual(10);
    const commands = game.log.flatMap((input) =>
      input.kind === 'command' ? [input.command.type] : [],
    );
    expect(commands.some((type) => type.startsWith('BUILD_'))).toBe(true);
    expect(commands).toContain('MARITIME_TRADE');
    expect(game.state.turn.number).toBeGreaterThan(1);
    expect(game.getPending()).toEqual([]);
    expect(engine.checkInvariants(game.snapshot())).toEqual([]);
    const privates = new Map(
      config.seats.flatMap((seat) => {
        const value = game.privateState(seat);
        return value ? [[seat, value] as const] : [];
      }),
    );
    expect(engine.checkPrivateInvariants(game.snapshot(), privates)).toEqual([]);
    let replay = engine.createGame(config, SEED);
    for (const input of game.log) {
      const applied = engine.apply(replay, input);
      if (!applied.ok) throw new Error(`Replay failed: ${applied.error.code}`);
      replay = applied.value.state;
      expect(engine.checkInvariants(replay)).toEqual([]);
      if (!replay.result && engine.getPending(replay).length === 0)
        throw new Error(`Replay has no pending input at sequence ${replay.counters.inputSeq}`);
    }
    expect(replay).toEqual(game.snapshot());
  }, 60_000);
});
