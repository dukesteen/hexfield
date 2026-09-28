import { describe, expect, test } from 'vitest';
import { createBaseEngine, DEV_CARD_COUNTS, engineForConfig, isPublicDraw } from '@cp2p/engine';
import type { GameState, Input, Pending, PrivateState, Seat } from '@cp2p/engine';
import { FOGBOUND_FOG, SCENARIOS, scenarioConfig } from '@cp2p/maps';
import { createBrowserRandomSource, randomIndex, remainingDevPool } from './random.js';
import type { Entropy } from './random.js';

const engine = createBaseEngine();
function genesis(): GameState {
  return engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2],
      options: { base: { mapLayout: 'random' } },
    },
    new Uint8Array(32).fill(8),
  );
}
function privates(): Map<Seat, PrivateState> {
  const seats: Seat[] = [0, 1, 2];
  return new Map(seats.map((seat) => [seat, engine.createPrivateState(seat)]));
}

describe('browser random source', () => {
  test('uniform index rejects biased tail bytes', () => {
    let calls = 0;
    const entropy: Entropy = {
      randomBytes(target) {
        target.fill(0);
        new DataView(target.buffer).setUint32(0, calls++ === 0 ? 0xffff_ffff : 7, true);
      },
    };
    expect(randomIndex(entropy, 3)).toBe(1);
    expect(calls).toBe(2);
  });

  test('forced random dice are one-shot and balanced dice reject the force', () => {
    const entropy: Entropy = {
      randomBytes(target) {
        target.fill(0);
      },
    };
    const source = createBrowserRandomSource(entropy);
    const pending: Pending = {
      kind: 'random',
      systemType: 'DICE_RESULT',
      request: { type: 'dice', mode: 'random' },
    };
    if (pending.kind !== 'random') throw new Error('Missing dice request');
    source.forceNextDice([5, 6]);
    expect(source.resolve(pending, genesis(), privates()).input).toEqual({
      kind: 'system',
      type: 'DICE_RESULT',
      dice: [5, 6],
    });
    expect(source.resolve(pending, genesis(), privates()).input).toEqual({
      kind: 'system',
      type: 'DICE_RESULT',
      dice: [1, 1],
    });
    source.forceNextDice([2, 3]);
    expect(() =>
      source.resolve(
        { ...pending, request: { type: 'dice', mode: 'balanced' } },
        genesis(),
        privates(),
      ),
    ).toThrow('balanced');
  });

  test('remaining stock is derived from exact slot identities and rejects an impossible save', () => {
    const state = genesis();
    const secrets = privates();
    const starting = Object.values(DEV_CARD_COUNTS).reduce((sum, count) => sum + count, 0);
    expect(remainingDevPool(state, secrets)).toHaveLength(starting);
    const drawn = {
      ...state,
      decks: {
        ...state.decks,
        dev: { remaining: starting - 1, drawn: [{ seat: 0 as Seat, slotId: 'dev-1' }] },
      },
      seats: state.seats.map((seat) =>
        seat.seat === 0
          ? { ...seat, cardSlots: [{ slotId: 'dev-1', deck: 'dev', acquiredTurn: 1 }] }
          : seat,
      ),
    };
    const owner = secrets.get(0);
    if (!owner) throw new Error('Missing private owner');
    secrets.set(0, { ...owner, slots: { 'dev-1': 'victoryPoint' } });
    expect(remainingDevPool(drawn, secrets)).toHaveLength(starting - 1);
    secrets.set(0, { ...owner, slots: { 'dev-1': 'not-a-card' } });
    expect(() => remainingDevPool(drawn, secrets)).toThrow('stock');
  });

  describe('public decks after a resume', () => {
    const scenario = SCENARIOS.find((item) => item.id === 'fogbound');
    if (!scenario) throw new Error('Missing fogbound scenario');
    const config = scenarioConfig(scenario, 3);
    const fogEngine = engineForConfig(config);
    const terrains: Record<string, number> = FOGBOUND_FOG.terrains;
    const total = Object.values(terrains).reduce((sum, count) => sum + count, 0);

    /** A game state whose terrain deck has shown the given cards, and the log that shows them. */
    function afterDraws(cards: readonly string[]): { state: GameState; log: Input[] } {
      const state = fogEngine.createGame(config, new Uint8Array(32).fill(3));
      return {
        state: {
          ...state,
          decks: {
            ...state.decks,
            'fog-terrain': {
              remaining: total - cards.length,
              drawn: cards.map((_, index) => ({ slotId: `fog-terrain:${index}`, seat: 0 as Seat })),
            },
          },
        },
        log: cards.map((card, index) => ({
          kind: 'system',
          type: 'FOG_REVEALED',
          deck: 'fog-terrain',
          seat: 0,
          slotId: `fog-terrain:${index}`,
          remaining: total - index,
          hex: 'h:0,0',
          card,
        })),
      };
    }

    function drawRest(source: ReturnType<typeof createBrowserRandomSource>, state: GameState) {
      const cards: string[] = [];
      for (let index = state.decks['fog-terrain']?.drawn.length ?? 0; index < total; index++) {
        const pending: Pending = {
          kind: 'random',
          systemType: 'FOG_REVEALED',
          request: {
            type: 'draw',
            deck: 'fog-terrain',
            public: true,
            seat: 0,
            slotId: `fog-terrain:${index}`,
            remaining: total - index,
            hex: 'h:0,0',
          },
        };
        if (!isPublicDraw(pending)) throw new Error('not a public draw');
        cards.push(String(source.resolve(pending, state, new Map()).input.card));
      }
      return cards;
    }

    test('a resumed source deals only what the replayed log has not shown', () => {
      const shownFirst = ['sea', 'sea', 'sea', 'gold', 'gold', 'forest'];
      const { state, log } = afterDraws(shownFirst);
      const source = createBrowserRandomSource({
        randomBytes(target) {
          target.fill(0);
        },
      });
      source.resume(log, state);
      const rest = drawRest(source, state);
      // Every card of the deck appears exactly once across the log and the resumed draws.
      const counts: Record<string, number> = {};
      for (const card of [...shownFirst, ...rest]) counts[card] = (counts[card] ?? 0) + 1;
      expect(counts).toEqual(terrains);
      expect(rest).toHaveLength(total - shownFirst.length);
    });

    test('resuming rejects a log that shows too much or disagrees with the state', () => {
      const source = createBrowserRandomSource();
      const tooMany = afterDraws(['sea', 'sea', 'sea', 'sea']);
      expect(() => source.resume(tooMany.log, tooMany.state)).toThrow('more often');
      const { state, log } = afterDraws(['sea', 'gold']);
      expect(() => source.resume(log.slice(1), state)).toThrow('draw count');
      expect(() => source.resume(log, afterDraws(['sea']).state)).toThrow('draw count');
      expect(() => source.resume(log, state)).not.toThrow();
    });
  });
});
