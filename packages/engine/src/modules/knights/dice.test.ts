import { describe, expect, test } from 'vitest';
import { boardGraph } from '../base/board/index.js';
import { createBaseEngine } from '../base/index.js';
import { EVENT_DIE } from './config.js';
import { knightsEngine } from './testing.js';
import { knightsExt, updateKnights } from './types.js';
import {
  handOf,
  hexOf,
  inDice,
  inMain,
  newGame,
  rejection,
  roll,
  submit,
  top,
  unlockRobber,
  verticesOfHex,
  withBuildings,
  withHand,
  withLevels,
} from './support.js';

const engine = knightsEngine();

describe('the event die', () => {
  test('the dice request names the event die and its six faces', () => {
    const [pending] = engine.getPending(inDice(newGame(engine)));
    expect(pending).toMatchObject({ kind: 'random', systemType: 'DICE_RESULT' });
    const request = pending?.kind === 'random' ? pending.request : null;
    expect(request?.extra).toEqual([{ id: 'event', faces: [...EVENT_DIE.faces] }]);
    expect(EVENT_DIE.faces.filter((face) => face === 'ship')).toHaveLength(3);
    expect(new Set(EVENT_DIE.faces).size).toBe(4);
  });

  test('a roll needs a valid event face and records it', () => {
    const state = inDice(newGame(engine));
    const input = { kind: 'system' as const, type: 'DICE_RESULT', dice: [3, 4] };
    expect(engine.validate(state, input).ok).toBe(false);
    expect(engine.validate(state, { ...input, extra: { event: 'comet' } }).ok).toBe(false);
    expect(engine.validate(state, { ...input, extra: { event: 'ship', other: 'ship' } }).ok).toBe(
      false,
    );
    const rolled = engine.apply(state, { ...input, extra: { event: 'politics' } });
    if (!rolled.ok) throw new Error(rolled.error.message);
    expect(knightsExt(rolled.value.state).eventDie).toBe('politics');
    expect(rolled.value.events).toContainEqual({
      type: 'diceRolled',
      dice: [3, 4],
      roll: 7,
      extra: { event: 'politics' },
    });
  });

  test('a base game has no extra dice and refuses them', () => {
    const base = createBaseEngine();
    const state = base.createGame(
      { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1, 2], options: {} },
      new Uint8Array(32),
    );
    const dice = {
      ...state,
      turn: { ...state.turn, phase: [{ id: 'dice', module: 'base', data: null }] },
    };
    expect(
      base.validate(dice, {
        kind: 'system',
        type: 'DICE_RESULT',
        dice: [1, 2],
        extra: { event: 'ship' },
      }).ok,
    ).toBe(false);
    expect(base.validate(dice, { kind: 'system', type: 'DICE_RESULT', dice: [1, 2] }).ok).toBe(
      true,
    );
    const [pending] = base.getPending(dice);
    expect(pending?.kind === 'random' && Object.hasOwn(pending.request, 'extra')).toBe(false);
  });
});

describe('a 7 before the first attack', () => {
  test('nobody discards with a small hand, and no robber step follows', () => {
    const after = roll(engine, inDice(newGame(engine)), [3, 4], 'ship');
    expect(top(after)?.id).toBe('main');
    expect(after.board.robberHex).toBe(hexOf(after, 'desert'));
  });

  test('seats over 7 cards discard half, commodities included, then the turn goes on', () => {
    let state = withHand(newGame(engine), 1, { paper: 4, cloth: 2, coin: 2 });
    state = inDice(withHand(state, 0, { brick: 1 }));
    const after = roll(engine, state, [3, 4]);
    expect(top(after)?.id).toBe('discard');
    expect(rejection(engine, after, 1, { type: 'DISCARD', cards: { paper: 3 } })).toBe(
      'wrong-discard-count',
    );
    expect(rejection(engine, after, 1, { type: 'DISCARD', cards: { paper: 5 } })).toBe(
      'wrong-discard-count',
    );
    const done = submit(engine, after, 1, { type: 'DISCARD', cards: { paper: 2, coin: 2 } });
    expect(top(done)?.id).toBe('main');
    expect(handOf(done, 1)).toMatchObject({ paper: 2, cloth: 2, coin: 0 });
    expect(done.board.robberHex).toBe(hexOf(done, 'desert'));
    expect(engine.checkInvariants(done)).toEqual([]);
  });

  test('a city wall raises the limit by 2', () => {
    const base = withBuildings(newGame(engine), [
      {
        vertex: verticesOfHex(newGame(engine), hexOf(newGame(engine), 'hills'))[0] ?? '',
        seat: 1,
        kind: 'city',
      },
    ]);
    const city = base.board.buildings[0]?.vertex ?? '';
    const walled = updateKnights(base, (old) => ({ ...old, walls: [{ seat: 1, vertex: city }] }));
    const at9 = inDice(withHand(walled, 1, { paper: 9 }));
    expect(top(roll(engine, at9, [3, 4]))?.id).toBe('main');
    const at10 = inDice(withHand(walled, 1, { paper: 10 }));
    expect(top(roll(engine, at10, [3, 4]))?.id).toBe('discard');
    expect(engine.hooks.handLimit(walled, 1, 7)).toBe(9);
    expect(engine.hooks.handLimit(walled, 0, 7)).toBe(7);
  });
});

describe('after the first attack', () => {
  test('a 7 moves the robber and can steal a commodity', () => {
    const base = newGame(engine);
    const hex = hexOf(base, 'hills');
    const vertex = verticesOfHex(base, hex)[0] ?? '';
    let state = withBuildings(base, [{ vertex, seat: 1 }]);
    state = inDice(unlockRobber(withHand(state, 1, { paper: 1 })));
    const after = roll(engine, state, [3, 4]);
    expect(top(after)?.id).toBe('moveRobber');
    const moved = submit(engine, after, 0, { type: 'MOVE_ROBBER', hex });
    expect(top(moved)?.id).toBe('steal');
    const stealing = submit(engine, moved, 0, { type: 'STEAL', victim: 1 });
    const done = engine.apply(stealing, {
      kind: 'system',
      type: 'STEAL_RESULT',
      thief: 0,
      victim: 1,
      resource: 'paper',
    });
    if (!done.ok) throw new Error(done.error.message);
    expect(handOf(done.value.state, 0).paper).toBe(1);
    expect(handOf(done.value.state, 1).paper).toBe(0);
  });

  test('while locked the robber has no legal hex and nothing can be stolen', () => {
    const state = inMain(newGame(engine));
    expect(
      rejection(engine, state, 0, { type: 'MOVE_ROBBER', hex: hexOf(state, 'hills') }),
    ).not.toBeNull();
    expect(engine.hooks.stealTargets(state, 0, 'robber', hexOf(state, 'hills'), [1])).toEqual([]);
  });
});

function harborVertices(kind: string): string[] {
  const state = newGame(engine);
  const graph = boardGraph(state);
  const harbor = state.board.harbors.find((item) => item.kind === kind);
  if (!harbor) throw new Error(`No ${kind} harbor`);
  return [...(graph.edgeVertices[graph.edgeIndex[harbor.edge] ?? -1] ?? [])];
}
const trade = (
  state: ReturnType<typeof newGame>,
  give: Record<string, number>,
  get: Record<string, number>,
) => rejection(engine, state, 0, { type: 'MARITIME_TRADE', give, get });

describe('bank trades with commodities', () => {
  test('4:1 for any commodity or resource, in either direction', () => {
    const state = inMain(withHand(newGame(engine), 0, { cloth: 4, ore: 4 }));
    expect(trade(state, { cloth: 4 }, { ore: 1 })).toBeNull();
    expect(trade(state, { ore: 4 }, { paper: 1 })).toBeNull();
    expect(trade(state, { cloth: 3 }, { ore: 1 })).toBe('invalid-maritime-rate');
    const done = submit(engine, state, 0, {
      type: 'MARITIME_TRADE',
      give: { cloth: 4 },
      get: { coin: 1 },
    });
    expect(handOf(done, 0)).toMatchObject({ cloth: 0, coin: 1 });
    expect(done.bank.cloth).toBe(12);
  });

  test('a 3:1 harbor serves commodities, and a 2:1 harbor stays with its resource', () => {
    const generic = harborVertices('generic')[0] ?? '';
    const state = inMain(
      withHand(withBuildings(newGame(engine), [{ vertex: generic, seat: 0 }]), 0, { cloth: 3 }),
    );
    expect(trade(state, { cloth: 3 }, { ore: 1 })).toBeNull();
    const wool = harborVertices('wool')[0] ?? '';
    const special = inMain(
      withHand(withBuildings(newGame(engine), [{ vertex: wool, seat: 0 }]), 0, {
        cloth: 2,
        wool: 2,
      }),
    );
    expect(trade(special, { cloth: 2 }, { ore: 1 })).toBe('invalid-maritime-rate');
    expect(trade(special, { wool: 2 }, { paper: 1 })).toBeNull();
  });

  test('the Trading House (trade level 3) gives 2:1 for commodities only', () => {
    const plain = inMain(withHand(newGame(engine), 0, { cloth: 2, ore: 2 }));
    expect(trade(plain, { cloth: 2 }, { coin: 1 })).toBe('invalid-maritime-rate');
    const house = withLevels(plain, 0, { trade: 3 });
    expect(trade(house, { cloth: 2 }, { coin: 1 })).toBeNull();
    expect(trade(house, { cloth: 2 }, { ore: 1 })).toBeNull();
    expect(trade(house, { ore: 2 }, { coin: 1 })).toBe('invalid-maritime-rate');
    const other = withLevels(plain, 0, { trade: 2, science: 3, politics: 3 });
    expect(trade(other, { cloth: 2 }, { coin: 1 })).toBe('invalid-maritime-rate');
  });

  test('seats can offer commodities to each other', () => {
    const state = inMain(withHand(newGame(engine), 0, { paper: 1 }));
    expect(
      rejection(engine, state, 0, { type: 'OFFER_TRADE', give: { paper: 1 }, want: { ore: 1 } }),
    ).toBeNull();
  });
});
