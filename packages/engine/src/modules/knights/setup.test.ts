import { describe, expect, test } from 'vitest';
import { LocalGame } from '../../core/pipeline/index.js';
import type { LocalRandomSource } from '../../core/pipeline/index.js';
import { createRng } from '../../core/rng/index.js';
import { kindsOfCounts } from '../../core/resources/index.js';
import { decksFor } from '../catalogue.js';
import { COMMODITIES, EVENT_DIE } from './config.js';
import { knightsConfig, knightsEngine } from './testing.js';
import { knightsExt } from './types.js';
import { handOf, newGame, rejection, verticesOfHex } from './support.js';

const engine = knightsEngine();
const fiveSix = knightsEngine(true);

/** A seeded source with no dev deck: dice, the start seat, and steals by first card. */
function source(seed: number): LocalRandomSource {
  const rng = createRng(new Uint8Array(32).fill(seed));
  return {
    resolve(pending) {
      switch (pending.systemType) {
        case 'START_SEAT':
          return { input: { kind: 'system', type: 'START_SEAT', seat: 0 } };
        case 'DICE_RESULT':
          return {
            input: {
              kind: 'system',
              type: 'DICE_RESULT',
              dice: [rng.int(6) + 1, rng.int(6) + 1],
              extra: { event: EVENT_DIE.faces[rng.int(6)] ?? 'ship' },
            },
          };
        default:
          throw new Error(`Unexpected ${pending.systemType}`);
      }
    },
  };
}

function playSetup(rules: typeof engine, fiveSixGame: boolean): LocalGame {
  const created = LocalGame.create(
    rules,
    knightsConfig({ fiveSix: fiveSixGame }),
    new Uint8Array(32),
    source(3),
  );
  if (!created.ok) throw new Error(created.error.message);
  const game = created.value;
  while (game.state.turn.phase.at(-1)?.id === 'setup') {
    const pending = game.getPending().find((item) => item.kind === 'player');
    if (pending?.kind !== 'player') throw new Error('Setup has no player');
    const command = rules.getLegalCommands(game.snapshot(), pending.seat).commands[0];
    if (!command) throw new Error('No setup command');
    const placed = game.submit({ kind: 'command', seat: pending.seat, command });
    if (!placed.ok) throw new Error(placed.error.message);
  }
  return game;
}

describe('knights genesis', () => {
  test('the bank holds 12 of each commodity, 18 with five-six, and the usual resources', () => {
    const state = newGame(engine);
    for (const kind of COMMODITIES) expect(state.bank[kind]).toBe(12);
    expect(state.bank.brick).toBe(19);
    const big = newGame(fiveSix, { fiveSix: true });
    for (const kind of COMMODITIES) expect(big.bank[kind]).toBe(18);
    expect(big.bank.brick).toBe(24);
  });

  test('every hand tracks the eight card kinds and starts empty', () => {
    const state = newGame(engine);
    for (const seat of state.seats) {
      expect(kindsOfCounts(seat.resources.min)).toEqual([
        'brick',
        'lumber',
        'wool',
        'grain',
        'ore',
        'cloth',
        'coin',
        'paper',
      ]);
      expect(seat.resources.total).toBe(0);
    }
    expect(Object.keys(engine.createPrivateState(0, state.config).hand)).toHaveLength(8);
    expect(engine.checkInvariants(state)).toEqual([]);
  });

  test('the ext state starts locked, at the barbarian start, with empty tracks', () => {
    const ext = knightsExt(newGame(engine, { seats: 4 }));
    expect(ext.robberLocked).toBe(true);
    expect(ext.barbarians.step).toBe(0);
    expect(ext.improvements).toHaveLength(4);
    expect(ext.improvements[0]).toEqual({ trade: 0, politics: 0, science: 0 });
    expect(ext.metropolises).toEqual({ trade: null, politics: null, science: null });
    expect(ext.eventDie).toBeNull();
  });

  test('the target is 13 points', () => {
    const state = newGame(engine);
    expect(engine.hooks.vpTarget(state.config, 10)).toBe(13);
    expect(engine.hooks.vpTarget(state.config, 15)).toBe(15);
  });

  test('there is no development deck: it is empty and buying or playing is illegal', () => {
    const state = newGame(engine);
    expect(decksFor(state.config).dev?.cards).toEqual({});
    expect(state.decks.dev).toEqual({ remaining: 0, drawn: [] });
    const main = {
      ...state,
      turn: { ...state.turn, phase: [{ id: 'main', module: 'base', data: null }] },
    };
    expect(rejection(engine, main, 0, { type: 'BUY_DEV_CARD' })).toBe('empty-dev-deck');
    expect(
      rejection(engine, main, 0, { type: 'PLAY_DEV_CARD', slotId: 'dev:0', card: 'knight' }),
    ).not.toBeNull();
    expect(engine.getLegalCommands(main, 0).commands.map((c) => c.type)).not.toContain(
      'BUY_DEV_CARD',
    );
  });

  test('the robber starts on the desert', () => {
    const state = newGame(engine);
    const desert = state.board.hexes.find((hex) => hex.terrain === 'desert');
    expect(state.board.robberHex).toBe(desert?.id);
  });
});

describe('knights setup', () => {
  test('round two places a city, and its yield is one resource per hex, never a commodity', () => {
    const game = playSetup(engine, false);
    const state = game.state;
    for (const seat of state.config.seats) {
      const own = state.board.buildings.filter((piece) => piece.seat === seat);
      expect(own.map((piece) => piece.kind).toSorted()).toEqual(['city', 'settlement']);
      const pieces = state.seats.find((item) => item.seat === seat)?.piecesLeft;
      expect(pieces).toMatchObject({ settlement: 4, city: 3, road: 13 });
      const hand = handOf(state, seat);
      for (const kind of COMMODITIES) expect(hand[kind]).toBe(0);
      const city = own.find((piece) => piece.kind === 'city');
      const hexes = state.board.hexes.filter(
        (hex) =>
          hex.terrain !== 'desert' && verticesOfHex(state, hex.id).includes(city?.vertex ?? ''),
      );
      expect(state.seats.find((item) => item.seat === seat)?.resources.total).toBe(hexes.length);
    }
    expect(engine.checkInvariants(state)).toEqual([]);
    expect(top(state)).toBe('preRoll');
  });

  test('the city is set in round two whatever the seat count, with five-six too', () => {
    const state = playSetup(fiveSix, true).state;
    expect(state.config.seats).toHaveLength(5);
    const cities = state.board.buildings.filter((piece) => piece.kind === 'city');
    expect(cities).toHaveLength(5);
    expect(fiveSix.checkInvariants(state)).toEqual([]);
  });
});

function top(state: { turn: { phase: { id: string }[] } }): string | undefined {
  return state.turn.phase.at(-1)?.id;
}
