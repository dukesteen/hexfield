import { describe, expect, test } from 'vitest';
import { createBaseEngine, enumerateCommands } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { createLocalRandomSource } from './random-source.js';
import { cardConservation, runGame, SimulationFailure } from './run-game.js';

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

describe('simulation runner', () => {
  test('detects local deck length, slot identity, and unknown-card mismatches', () => {
    const engine = createBaseEngine();
    const seed = new Uint8Array(32);
    const state = engine.createGame(
      { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1, 2], options: { base: {} } },
      seed,
    );
    const source = createLocalRandomSource(seed);
    const deck = source.remainingCards();
    const privates = new Map(
      state.config.seats.map((seat) => [seat, engine.createPrivateState(seat)]),
    );
    expect(cardConservation(state, privates, deck)).toEqual([]);
    expect(cardConservation(state, privates, deck.slice(1))).toContain(
      'Source deck has 24 cards, public deck has 25',
    );
    const unknownDeck = [...deck];
    unknownDeck[0] = 'mystery';
    expect(cardConservation(state, privates, unknownDeck)).toContain(
      'Unknown development card mystery',
    );
    const withSlot = {
      ...state,
      seats: state.seats.map((holder) =>
        holder.seat === 0
          ? { ...holder, cardSlots: [{ slotId: 'missing', deck: 'dev', acquiredTurn: 0 }] }
          : holder,
      ),
    };
    expect(cardConservation(withSlot, privates, deck)).toContain(
      'Seat 0 lacks private identity for slot missing',
    );
    const withExtraPrivate = new Map(privates);
    withExtraPrivate.set(0, { ...engine.createPrivateState(0), slots: { ghost: 'knight' } });
    expect(cardConservation(state, withExtraPrivate, deck)).toContain(
      'Seat 0 has private identity without unrevealed slot ghost',
    );
  });

  test('wraps scheduling failures with a replayable accepted prefix', () => {
    expect(() =>
      runGame({
        seed: 42,
        gameIndex: 0,
        players: 3,
        baseOptions: { vpTarget: 3 },
        onPlayerStep() {
          throw new Error('observer failure');
        },
      }),
    ).toThrow(SimulationFailure);
  });

  test('replays the same game seed and index deterministically', () => {
    const options = { seed: 42, gameIndex: 0, players: 3, baseOptions: { vpTarget: 3 } };
    const first = runGame(options);
    const second = runGame(options);
    expect(second.inputs).toEqual(first.inputs);
    expect(second.state).toEqual(first.state);
    expect(first.state.result?.winner).toBeDefined();
  });

  test('every enumerated action validates in at least 2,000 real player states', () => {
    let states = 0;
    let actions = 0;
    for (let gameIndex = 0; gameIndex < 8; gameIndex++) {
      if (states >= 2_000) break;
      runGame({
        seed: 42,
        gameIndex,
        onPlayerStep(engine, state, seat, priv) {
          states++;
          const commands = enumerateCommands(engine, state, seat, priv, { sampleIndex: () => 0 });
          for (const command of commands) {
            actions++;
            expect(engine.validate(state, { kind: 'command', seat, command }).ok).toBe(true);
          }
        },
      });
    }
    expect(states).toBeGreaterThanOrEqual(2_000);
    expect(actions).toBeGreaterThan(2_000);
    // Coverage instrumentation exceeds Vitest's default timeout on this exhaustive check.
  }, 15_000);

  test('discrete placement enumeration matches brute-force validation across live states', () => {
    let checked = 0;
    let visited = 0;
    const types = [
      'PLACE_SETTLEMENT',
      'PLACE_ROAD',
      'BUILD_SETTLEMENT',
      'BUILD_ROAD',
      'BUILD_CITY',
      'PLACE_FREE_ROAD',
    ];
    for (let gameIndex = 0; gameIndex < 8; gameIndex++) {
      if (checked >= 120) break;
      runGame({
        seed: 42,
        gameIndex,
        onPlayerStep(engine, state, seat, priv) {
          visited++;
          if (checked >= 120 || visited % 15 !== 0) return;
          checked++;
          const graph = buildBoardGraph(state.board.hexes);
          const enumerated = enumerateCommands(engine, state, seat, priv, { sampleIndex: () => 0 });
          for (const type of types) {
            const field = type.includes('ROAD') ? 'edge' : 'vertex';
            const candidates = field === 'edge' ? graph.edgeIds : graph.vertexIds;
            const expected = candidates.filter(
              (id) =>
                engine.validate(state, { kind: 'command', seat, command: { type, [field]: id } })
                  .ok,
            );
            const actual = enumerated
              .filter((command) => command.type === type)
              .map((command) => {
                const id = command[field];
                if (typeof id !== 'string') throw new Error(`Missing ${field} for ${type}`);
                return id;
              });
            expect(actual.toSorted(compareIds)).toEqual(expected.toSorted(compareIds));
          }
        },
      });
    }
    expect(checked).toBe(120);
  });
});
