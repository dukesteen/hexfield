import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import { boardGraph } from '../base/board/index.js';
import { goldOptions } from './gold.js';
import { seafaringEngine } from './testing.js';
import { inPhase, newGame, rejection, submit, withBuildings } from './support.js';

const engine = seafaringEngine();
const GOLD = 'h:4,-3';

function goldVertices(state: GameState, count: number): string[] {
  const graph = boardGraph(state);
  return [...(graph.hexVertices[graph.hexIndex[GOLD] ?? -1] ?? [])].slice(0, count);
}

/** Set the bank to the given stock (other kinds empty). */
function withBank(state: GameState, bank: Record<string, number>): GameState {
  return { ...state, bank: { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0, ...bank } };
}

function roll(state: GameState, total = 6): GameState {
  const result = engine.apply(state, {
    kind: 'system',
    type: 'DICE_RESULT',
    dice: [Math.min(6, total - 1), total - Math.min(6, total - 1)],
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.state;
}

function diceState(active: 0 | 1 | 2 = 0, robber?: string): GameState {
  let state = newGame(engine);
  const [a, b, c] = goldVertices(state, 3);
  state = withBuildings(state, [
    { vertex: a ?? '', seat: 0 },
    { vertex: b ?? '', seat: 1, kind: 'city' },
    { vertex: c ?? '', seat: 2 },
  ]);
  state = inPhase(state, 'dice');
  return {
    ...state,
    board: { ...state.board, robberHex: robber ?? state.board.robberHex },
    turn: { number: 5, activeSeat: active, phase: state.turn.phase },
  };
}

const top = (state: GameState) => state.turn.phase.at(-1);

describe('gold fields', () => {
  test('a roll of the gold number opens one choice per seat, starting with the active seat', () => {
    const state = roll(diceState(1));
    expect(top(state)).toMatchObject({
      id: 'goldChoice',
      module: 'seafaring',
      data: {
        queue: [
          { seat: 1, claim: 2 },
          { seat: 2, claim: 1 },
          { seat: 0, claim: 1 },
        ],
      },
    });
    expect(state.turn.phase.map((frame) => frame.id)).toEqual(['main', 'goldChoice']);
    const [pending] = engine.getPending(state);
    expect(pending).toMatchObject({ kind: 'player', seat: 1 });
    expect(pending?.kind === 'player' && pending.allowed).toContain('CHOOSE_GOLD');
  });
  test('a settlement takes one card and a city two, of the seat’s choice, one seat at a time', () => {
    let state = roll(diceState(0));
    expect(rejection(engine, state, 1, { type: 'CHOOSE_GOLD', resources: { ore: 2 } })).toBe(
      'not-pending',
    );
    expect(rejection(engine, state, 0, { type: 'CHOOSE_GOLD', resources: { ore: 2 } })).toBe(
      'invalid-gold-choice',
    );
    expect(rejection(engine, state, 0, { type: 'CHOOSE_GOLD', resources: {} })).toBe(
      'invalid-gold-choice',
    );
    // Gold is not a card, so it is never a legal choice.
    expect(rejection(engine, state, 0, { type: 'CHOOSE_GOLD', resources: { gold: 1 } })).toBe(
      'invalid-gold-choice',
    );
    const options = engine
      .getLegalCommands(state, 0)
      .commands.filter((c) => c.type === 'CHOOSE_GOLD');
    expect(options).toHaveLength(5);
    expect(engine.getLegalCommands(state, 1).commands.some((c) => c.type === 'CHOOSE_GOLD')).toBe(
      false,
    );
    state = submit(engine, state, 0, { type: 'CHOOSE_GOLD', resources: { brick: 1 } });
    expect(state.seats[0]?.resources.total).toBe(1);
    expect(state.bank.brick).toBe(18);
    expect(top(state)?.data).toMatchObject({
      queue: [
        { seat: 1, claim: 2 },
        { seat: 2, claim: 1 },
      ],
    });
    // The city takes two cards, of one kind or two.
    expect(
      engine.getLegalCommands(state, 1).commands.filter((c) => c.type === 'CHOOSE_GOLD'),
    ).toHaveLength(15);
    state = submit(engine, state, 1, { type: 'CHOOSE_GOLD', resources: { ore: 1, wool: 1 } });
    state = submit(engine, state, 2, { type: 'CHOOSE_GOLD', resources: { grain: 1 } });
    expect(state.turn.phase.map((frame) => frame.id)).toEqual(['main']);
    expect(state.seats.map((seat) => seat.resources.total)).toEqual([1, 2, 1]);
    expect(engine.checkInvariants(state)).toEqual([]);
  });
  test('the robber blocks the gold hex, and other rolls and sevens give nothing', () => {
    expect(top(roll(diceState(0, GOLD)))?.id).toBe('main');
    expect(top(roll(diceState(0), 5))?.id).not.toBe('goldChoice');
    expect(top(roll(diceState(0), 7))?.id).not.toBe('goldChoice');
  });
  test('two gold hexes with the same number, at one vertex, make a single larger claim', () => {
    let state = newGame(engine);
    state = {
      ...state,
      board: {
        ...state.board,
        hexes: state.board.hexes.map((hex) =>
          hex.id === 'h:4,-2' ? { ...hex, terrain: 'gold', token: 6 } : hex,
        ),
      },
    };
    const graph = boardGraph(state);
    const shared = graph.vertexIds.find((vertex) => {
      const around: readonly string[] = graph.vertexHexes[graph.vertexIndex[vertex] ?? -1] ?? [];
      return around.includes(GOLD) && around.includes('h:4,-2');
    });
    state = inPhase(withBuildings(state, [{ vertex: shared ?? '', seat: 0 }]), 'dice');
    state = { ...state, turn: { number: 5, activeSeat: 0, phase: state.turn.phase } };
    expect(top(roll(state))?.data).toMatchObject({ queue: [{ seat: 0, claim: 2 }] });
  });
  test('an empty bank pays nothing and opens no choice', () => {
    const state = roll(withBank(diceState(0), {}));
    expect(state.turn.phase.map((frame) => frame.id)).toEqual(['main']);
  });
  test('the claim is capped at the bank’s stock, and the choice is limited to what it holds', () => {
    let state = roll(withBank(diceState(1), { brick: 1, ore: 1 }));
    // Seat 1's city claims two cards and the bank holds two, so it takes them.
    expect(rejection(engine, state, 1, { type: 'CHOOSE_GOLD', resources: { wool: 2 } })).toBe(
      'invalid-gold-choice',
    );
    expect(rejection(engine, state, 1, { type: 'CHOOSE_GOLD', resources: { brick: 2 } })).toBe(
      'invalid-gold-choice',
    );
    expect(
      engine.getLegalCommands(state, 1).commands.filter((c) => c.type === 'CHOOSE_GOLD'),
    ).toEqual([
      { type: 'CHOOSE_GOLD', resources: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 1 } },
    ]);
    state = submit(engine, state, 1, { type: 'CHOOSE_GOLD', resources: { brick: 1, ore: 1 } });
    // The bank is now empty: the other claims are dropped and no pending opens.
    expect(state.turn.phase.map((frame) => frame.id)).toEqual(['main']);
    expect(state.seats[2]?.resources.total).toBe(0);
    expect(engine.checkInvariants(state)).toEqual([]);
  });
  test('a seat takes fewer cards than it claims when the bank runs short', () => {
    let state = roll(withBank(diceState(1), { ore: 1 }));
    const need = engine.getLegalCommands(state, 1).commands.filter((c) => c.type === 'CHOOSE_GOLD');
    expect(need).toEqual([
      { type: 'CHOOSE_GOLD', resources: { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 1 } },
    ]);
    state = submit(engine, state, 1, { type: 'CHOOSE_GOLD', resources: { ore: 1 } });
    expect(state.turn.phase.map((frame) => frame.id)).toEqual(['main']);
  });
  test('a timeout takes the first cards the bank holds, in canonical order', () => {
    let state = roll(withBank(diceState(0), { lumber: 1, grain: 5 }));
    expect(
      engine.validate(state, { kind: 'system', type: 'TIMEOUT', seat: 0, phase: 'goldChoice' }).ok,
    ).toBe(true);
    const timed = engine.apply(state, {
      kind: 'system',
      type: 'TIMEOUT',
      seat: 0,
      phase: 'goldChoice',
    });
    expect(timed.ok).toBe(true);
    if (!timed.ok) return;
    state = timed.value.state;
    // Seat 0's claim is 1 card: the first kind in order that the bank has is lumber.
    expect(state.seats[0]?.resources.min.lumber).toBe(1);
    expect(
      engine.validate(state, { kind: 'system', type: 'TIMEOUT', seat: 0, phase: 'goldChoice' }).ok,
    ).toBe(false);
    expect(
      engine.validate(state, { kind: 'system', type: 'TIMEOUT', seat: 1, phase: 'goldChoice' }).ok,
    ).toBe(true);
  });
  test('the owner’s private hand receives the chosen cards', () => {
    const state = roll(diceState(0));
    const priv = engine.createPrivateState(0);
    const input = {
      kind: 'command' as const,
      seat: 0 as const,
      command: { type: 'CHOOSE_GOLD', resources: { grain: 1 } },
    };
    const updated = engine.applyPrivate(priv, state, input);
    expect(updated.ok && updated.value.hand.grain).toBe(1);
    const other = engine.applyPrivate(engine.createPrivateState(1), state, input);
    expect(other.ok && other.value.hand.grain).toBe(0);
  });
  test('large claims list every choice or a fixed sample', () => {
    const bank = { brick: 19, lumber: 19, wool: 19, grain: 19, ore: 19 };
    expect(goldOptions(bank, 2)).toHaveLength(15);
    const many = goldOptions(bank, 8);
    expect(many.length).toBeGreaterThan(0);
    expect(many.length).toBeLessThanOrEqual(61);
    expect(many.every((choice) => Object.values(choice).reduce((a, b) => a + b, 0) === 8)).toBe(
      true,
    );
    const short = goldOptions({ ...bank, brick: 1, lumber: 0, wool: 0, grain: 0, ore: 1 }, 3);
    expect(short).toEqual([]);
  });
});
