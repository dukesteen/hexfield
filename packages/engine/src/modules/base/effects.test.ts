import { describe, expect, test } from 'vitest';
import { createEngine } from '../../core/pipeline/index.js';
import type { Engine, Input } from '../../core/pipeline/index.js';
import { exactResourceBounds } from '../../core/resources/index.js';
import type { GameState } from '../../core/state/index.js';
import { RESOURCES } from '../../core/types/index.js';
import type { ResourceCounts, Seat } from '../../core/types/index.js';
import { verticesForHex } from './board/index.js';
import { baseModule } from './index.js';
import { legalRoadEdges } from './placement/index.js';
import { frame } from './shared.js';

const zero: ResourceCounts = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };

function game(engine: Engine, options: Record<string, unknown> = {}): GameState {
  return engine.createGame(
    {
      modules: [{ id: 'base', version: baseModule().version }],
      seats: [0, 1, 2],
      options: { base: options },
    },
    new Uint8Array(32),
  );
}

function inPhase(state: GameState, phase: string, data: unknown = null): GameState {
  const parent = phase === 'monopoly' || phase === 'drawDev' ? [frame('main')] : [];
  return {
    ...state,
    turn: { ...state.turn, activeSeat: 0, number: 3, phase: [...parent, frame(phase, data)] },
  };
}

function withHand(state: GameState, seat: Seat, counts: ResourceCounts): GameState {
  const bounds = exactResourceBounds(counts);
  if (!bounds.ok) throw new Error(bounds.error.message);
  return {
    ...state,
    seats: state.seats.map((item) =>
      item.seat === seat ? { ...item, resources: bounds.value } : item,
    ),
  };
}

function applied(engine: Engine, state: GameState, input: Input) {
  const result = engine.apply(state, input);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

describe('base accounting effects', () => {
  test('player trade records both gross transfers in the order the hands change', () => {
    const engine = createEngine([baseModule()]);
    let state = withHand(inPhase(game(engine), 'main'), 0, { ...zero, brick: 1 });
    state = withHand(state, 1, { ...zero, ore: 1 });
    const offer: Input = {
      kind: 'command',
      seat: 0,
      command: { type: 'OFFER_TRADE', give: { brick: 1 }, want: { ore: 1 }, to: [1] },
    };
    const offered = applied(engine, state, offer);
    expect(offered.effects).toEqual([]);
    const accepted = applied(engine, offered.state, {
      kind: 'command',
      seat: 1,
      command: { type: 'RESPOND_TRADE', offerId: 0, accept: true },
    });
    expect(accepted.effects).toEqual([]);
    const confirm: Input = {
      kind: 'command',
      seat: 0,
      command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
    };
    const result = applied(engine, accepted.state, confirm);
    expect(result.effects).toEqual([
      {
        type: 'resource-transfer',
        from: { kind: 'seat', seat: 0 },
        to: { kind: 'seat', seat: 1 },
        resource: 'brick',
        count: 1,
      },
      {
        type: 'resource-transfer',
        from: { kind: 'seat', seat: 1 },
        to: { kind: 'seat', seat: 0 },
        resource: 'ore',
        count: 1,
      },
    ]);
    const a = engine.applyPrivate(
      { ...engine.createPrivateState(0), hand: { ...zero, brick: 1 } },
      accepted.state,
      confirm,
    );
    const b = engine.applyPrivate(
      { ...engine.createPrivateState(1), hand: { ...zero, ore: 1 } },
      accepted.state,
      confirm,
    );
    expect(a).toMatchObject({ ok: true, value: { hand: { brick: 0, ore: 1 } } });
    expect(b).toMatchObject({ ok: true, value: { hand: { brick: 1, ore: 0 } } });
    expect(result.state.seats[0]?.resources.min).toMatchObject({ brick: 0, ore: 1 });
    expect(result.state.seats[1]?.resources.min).toMatchObject({ brick: 1, ore: 0 });

    const bankState = withHand(inPhase(game(engine), 'main'), 0, { ...zero, brick: 4 });
    const bankInput: Input = {
      kind: 'command',
      seat: 0,
      command: { type: 'MARITIME_TRADE', give: { brick: 4 }, get: { ore: 1 } },
    };
    const bankTrade = applied(engine, bankState, bankInput);
    expect(bankTrade.effects).toEqual([
      {
        type: 'resource-transfer',
        from: { kind: 'seat', seat: 0 },
        to: { kind: 'bank' },
        resource: 'brick',
        count: 4,
      },
      {
        type: 'resource-transfer',
        from: { kind: 'bank' },
        to: { kind: 'seat', seat: 0 },
        resource: 'ore',
        count: 1,
      },
    ]);
    expect(
      engine.applyPrivate(
        { ...engine.createPrivateState(0), hand: { ...zero, brick: 4 } },
        bankState,
        bankInput,
      ),
    ).toMatchObject({ ok: true, value: { hand: { brick: 0, ore: 1 } } });
  });

  test('build cost and bank-limited production use the amounts chosen by hooks', () => {
    const base = baseModule();
    const engine = createEngine([
      {
        ...base,
        hooks: {
          costOf: (_state, buildType, cost) =>
            buildType === 'road' ? { ...cost, brick: 2 } : cost,
          computeProduction: (_state, _roll, production) => ({
            ...production,
            '0': { ...production['0'], brick: 3 },
          }),
        },
      },
    ]);
    const initial = game(engine);
    const vertex = verticesForHex(initial, initial.board.hexes[0]?.id ?? '')[0];
    if (!vertex) throw new Error('Missing setup vertex');
    let building = withHand(inPhase(initial, 'main'), 0, { ...zero, brick: 2, lumber: 1 });
    building = {
      ...building,
      board: { ...building.board, buildings: [{ vertex, seat: 0, kind: 'settlement' }] },
    };
    const edge = legalRoadEdges(building, 0)[0];
    if (!edge) throw new Error('Missing road edge');
    const spend = applied(engine, building, {
      kind: 'command',
      seat: 0,
      command: { type: 'BUILD_ROAD', edge },
    });
    expect(spend.effects).toEqual([
      {
        type: 'resource-transfer',
        from: { kind: 'seat', seat: 0 },
        to: { kind: 'bank' },
        resource: 'brick',
        count: 2,
      },
      {
        type: 'resource-transfer',
        from: { kind: 'seat', seat: 0 },
        to: { kind: 'bank' },
        resource: 'lumber',
        count: 1,
      },
    ]);
    expect(spend.state.seats[0]?.resources.total).toBe(0);

    const rolling = {
      ...initial,
      bank: { ...initial.bank, brick: 1 },
      turn: { ...initial.turn, phase: [frame('dice')] },
    };
    const produced = applied(engine, rolling, {
      kind: 'system',
      type: 'DICE_RESULT',
      dice: [1, 1],
    });
    expect(produced.effects).toEqual([
      {
        type: 'resource-transfer',
        from: { kind: 'bank' },
        to: { kind: 'seat', seat: 0 },
        resource: 'brick',
        count: 1,
      },
    ]);
    expect(produced.state.bank.brick).toBe(0);
    expect(produced.state.seats[0]?.resources.min.brick).toBe(1);
    expect(
      engine.applyPrivate(engine.createPrivateState(0), rolling, {
        kind: 'system',
        type: 'DICE_RESULT',
        dice: [1, 1],
      }),
    ).toMatchObject({ ok: true, value: { hand: { brick: 1 } } });
  });

  test('second settlement grants exactly the adjacent cards the bank can pay', () => {
    const engine = createEngine([baseModule()]);
    const initial = game(engine);
    const setup: GameState = {
      ...initial,
      turn: {
        ...initial.turn,
        activeSeat: 2,
        phase: [
          frame('setup', {
            startSeat: 0,
            order: [0, 1, 2, 2, 1, 0],
            index: 3,
            step: 'settlement',
            lastVertex: null,
          }),
        ],
      },
    };
    const vertex = engine
      .getLegalCommands(setup, 2)
      .commands.find((command) => command.type === 'PLACE_SETTLEMENT')?.vertex;
    if (typeof vertex !== 'string') throw new Error('No legal setup settlement');
    const input: Input = {
      kind: 'command',
      seat: 2,
      command: { type: 'PLACE_SETTLEMENT', vertex },
    };
    const placed = applied(engine, setup, input);
    const privateResult = engine.applyPrivate(engine.createPrivateState(2), setup, input);
    if (!privateResult.ok) throw new Error(privateResult.error.message);
    for (const resource of RESOURCES) {
      const before = setup.seats[2]?.resources.min[resource] ?? 0;
      const after = placed.state.seats[2]?.resources.min[resource] ?? 0;
      const gained = after - before;
      expect(privateResult.value.hand[resource]).toBe(gained);
      expect((setup.bank[resource] ?? 0) - (placed.state.bank[resource] ?? 0)).toBe(gained);
      expect(
        placed.effects.filter(
          (effect) => effect.type === 'resource-transfer' && effect.resource === resource,
        ),
      ).toEqual(
        gained === 0
          ? []
          : [
              {
                type: 'resource-transfer',
                from: { kind: 'bank' },
                to: { kind: 'seat', seat: 2 },
                resource,
                count: gained,
              },
            ],
      );
    }
  });

  test('monopoly emits an opening request for zero and moves a positive revealed count', () => {
    const engine = createEngine([baseModule()]);
    const waiting = inPhase(game(engine), 'monopoly', {
      seat: 0,
      resource: 'grain',
      remaining: [1],
    });
    const zeroInput: Input = {
      kind: 'system',
      type: 'REVEAL_COUNT',
      seat: 1,
      resource: 'grain',
      count: 0,
    };
    const empty = applied(engine, waiting, zeroInput);
    expect(empty.effects).toEqual([
      { type: 'resource-count-revealed', seat: 1, resource: 'grain', count: 0 },
    ]);
    const loaded = withHand(waiting, 1, { ...zero, grain: 2 });
    const input: Input = { ...zeroInput, count: 2 };
    const result = applied(engine, loaded, input);
    expect(result.effects).toEqual([
      { type: 'resource-count-revealed', seat: 1, resource: 'grain', count: 2 },
      {
        type: 'resource-transfer',
        from: { kind: 'seat', seat: 1 },
        to: { kind: 'seat', seat: 0 },
        resource: 'grain',
        count: 2,
      },
    ]);
    expect(
      engine.applyPrivate(
        { ...engine.createPrivateState(1), hand: { ...zero, grain: 2 } },
        loaded,
        input,
      ),
    ).toMatchObject({ ok: true, value: { hand: { grain: 0 } } });
    expect(engine.applyPrivate(engine.createPrivateState(0), loaded, input)).toMatchObject({
      ok: true,
      value: { hand: { grain: 2 } },
    });
  });

  test('deal creates a slot, play reveals it, and hidden steal stays opaque', () => {
    const engine = createEngine([baseModule()]);
    const drawn = inPhase(game(engine), 'drawDev', { seat: 0, slotId: 'dev:0' });
    const deal = applied(engine, drawn, {
      kind: 'system',
      type: 'CARD_DEALT',
      seat: 0,
      deck: 'dev',
      slotId: 'dev:0',
    });
    expect(deal.effects).toEqual([
      { type: 'card-slot-dealt', seat: 0, deck: 'dev', slotId: 'dev:0' },
    ]);
    const nextTurn = inPhase(deal.state, 'preRoll');
    const playable = { ...nextTurn, turn: { ...nextTurn.turn, number: 4 } };
    const played = applied(engine, playable, {
      kind: 'command',
      seat: 0,
      command: { type: 'PLAY_DEV_CARD', slotId: 'dev:0', card: 'knight' },
    });
    expect(played.effects).toEqual([
      { type: 'card-slot-revealed', seat: 0, deck: 'dev', slotId: 'dev:0', card: 'knight' },
    ]);

    const stealing = withHand(
      inPhase(game(engine), 'stealResult', { thief: 0, victim: 1, returnTo: 'main' }),
      1,
      { ...zero, ore: 1 },
    );
    const hidden = applied(engine, stealing, {
      kind: 'system',
      type: 'STEAL_RESULT',
      thief: 0,
      victim: 1,
      resource: 'hidden',
    });
    expect(hidden.effects).toEqual([
      { type: 'hidden-resource-transfer', from: 1, to: 0, count: 1 },
    ]);
    const named = applied(engine, stealing, {
      kind: 'system',
      type: 'STEAL_RESULT',
      thief: 0,
      victim: 1,
      resource: 'ore',
    });
    expect(named.effects).toEqual([
      {
        type: 'resource-transfer',
        from: { kind: 'seat', seat: 1 },
        to: { kind: 'seat', seat: 0 },
        resource: 'ore',
        count: 1,
      },
    ]);

    const victoryGame = inPhase(game(engine, { vpTarget: 3 }), 'main');
    const claimable = {
      ...victoryGame,
      seats: victoryGame.seats.map((seat) =>
        seat.seat === 0
          ? { ...seat, publicVp: 2, cardSlots: [{ slotId: 'dev:9', deck: 'dev', acquiredTurn: 2 }] }
          : seat,
      ),
    };
    const claimed = applied(engine, claimable, {
      kind: 'command',
      seat: 0,
      command: { type: 'CLAIM_VICTORY', slotIds: ['dev:9'] },
    });
    expect(claimed.effects).toEqual([
      { type: 'card-slot-revealed', seat: 0, deck: 'dev', slotId: 'dev:9', card: 'victoryPoint' },
    ]);
  });

  test('timeout discard carries the same gross bank transfers as the ordinary handler', () => {
    const engine = createEngine([baseModule()]);
    const waiting = withHand(inPhase(game(engine), 'discard', { remaining: [0] }), 0, {
      ...zero,
      brick: 4,
      lumber: 4,
    });
    const timed = applied(engine, waiting, {
      kind: 'system',
      type: 'TIMEOUT',
      seat: 0,
      phase: 'discard',
    });
    expect(timed.effects).toEqual([
      {
        type: 'resource-transfer',
        from: { kind: 'seat', seat: 0 },
        to: { kind: 'bank' },
        resource: 'brick',
        count: 4,
      },
    ]);
    expect(timed.state.seats[0]?.resources.total).toBe(4);
  });

  test('counter-offer transfers the nonactive proposer’s give before the active seat’s reply', () => {
    const engine = createEngine([baseModule()]);
    let state = withHand(inPhase(game(engine), 'main'), 0, { ...zero, brick: 1 });
    state = withHand(state, 1, { ...zero, ore: 1 });
    const proposed = applied(engine, state, {
      kind: 'command',
      seat: 1,
      command: { type: 'PROPOSE_TRADE', give: { ore: 1 }, want: { brick: 1 } },
    });
    const confirm: Input = {
      kind: 'command',
      seat: 0,
      command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
    };
    const result = applied(engine, proposed.state, confirm);
    expect(result.effects).toEqual([
      {
        type: 'resource-transfer',
        from: { kind: 'seat', seat: 1 },
        to: { kind: 'seat', seat: 0 },
        resource: 'ore',
        count: 1,
      },
      {
        type: 'resource-transfer',
        from: { kind: 'seat', seat: 0 },
        to: { kind: 'seat', seat: 1 },
        resource: 'brick',
        count: 1,
      },
    ]);
    expect(result.state.seats[0]?.resources.min).toMatchObject({ brick: 0, ore: 1 });
    expect(result.state.seats[1]?.resources.min).toMatchObject({ brick: 1, ore: 0 });
    expect(
      engine.applyPrivate(
        { ...engine.createPrivateState(0), hand: { ...zero, brick: 1 } },
        proposed.state,
        confirm,
      ),
    ).toMatchObject({ ok: true, value: { hand: { brick: 0, ore: 1 } } });
    expect(
      engine.applyPrivate(
        { ...engine.createPrivateState(1), hand: { ...zero, ore: 1 } },
        proposed.state,
        confirm,
      ),
    ).toMatchObject({ ok: true, value: { hand: { brick: 1, ore: 0 } } });
  });

  test('year of plenty reveals its slot then records only the bank-supplied card', () => {
    const engine = createEngine([baseModule()]);
    const initial = inPhase(game(engine), 'main');
    const state = {
      ...initial,
      bank: { ...initial.bank, brick: 1 },
      seats: initial.seats.map((seat) =>
        seat.seat === 0
          ? { ...seat, cardSlots: [{ slotId: 'dev:0', deck: 'dev' as const, acquiredTurn: 2 }] }
          : seat,
      ),
    };
    const input: Input = {
      kind: 'command',
      seat: 0,
      command: {
        type: 'PLAY_DEV_CARD',
        slotId: 'dev:0',
        card: 'yearOfPlenty',
        params: { resources: { brick: 2 } },
      },
    };
    const result = applied(engine, state, input);
    expect(result.effects).toEqual([
      { type: 'card-slot-revealed', seat: 0, deck: 'dev', slotId: 'dev:0', card: 'yearOfPlenty' },
      {
        type: 'resource-transfer',
        from: { kind: 'bank' },
        to: { kind: 'seat', seat: 0 },
        resource: 'brick',
        count: 1,
      },
    ]);
    expect(result.state.bank.brick).toBe(0);
    expect(result.state.seats[0]?.resources.min.brick).toBe(1);
    expect(
      engine.applyPrivate(
        { ...engine.createPrivateState(0), slots: { 'dev:0': 'yearOfPlenty' } },
        state,
        input,
      ),
    ).toMatchObject({ ok: true, value: { hand: { brick: 1 }, slots: {} } });
  });

  test('shared production shortage pays neither claimant and emits no resource effect', () => {
    const base = baseModule();
    const engine = createEngine([
      {
        ...base,
        hooks: {
          computeProduction: (_state, _roll, production) => ({
            ...production,
            '0': { ...production['0'], brick: 1 },
            '1': { ...production['1'], brick: 1 },
          }),
        },
      },
    ]);
    const initial = game(engine);
    const state = {
      ...initial,
      bank: { ...initial.bank, brick: 1 },
      turn: { ...initial.turn, phase: [frame('dice')] },
    };
    const input: Input = { kind: 'system', type: 'DICE_RESULT', dice: [1, 1] };
    const result = applied(engine, state, input);
    expect(result.effects).toEqual([]);
    expect(result.state.bank.brick).toBe(1);
    for (const seat of [0, 1] as const) {
      expect(result.state.seats[seat]?.resources.min.brick).toBe(0);
      expect(engine.applyPrivate(engine.createPrivateState(seat), state, input)).toMatchObject({
        ok: true,
        value: { hand: { brick: 0 } },
      });
    }
  });

  test('development-card purchase emits the hook-adjusted cost', () => {
    const base = baseModule();
    const engine = createEngine([
      {
        ...base,
        hooks: {
          costOf: (_state, buildType, cost) =>
            buildType === 'devCard' ? { ...cost, grain: 2, ore: 0 } : cost,
        },
      },
    ]);
    const state = withHand(inPhase(game(engine), 'main'), 0, { ...zero, wool: 1, grain: 2 });
    const input: Input = { kind: 'command', seat: 0, command: { type: 'BUY_DEV_CARD' } };
    const result = applied(engine, state, input);
    expect(result.effects).toEqual([
      {
        type: 'resource-transfer',
        from: { kind: 'seat', seat: 0 },
        to: { kind: 'bank' },
        resource: 'wool',
        count: 1,
      },
      {
        type: 'resource-transfer',
        from: { kind: 'seat', seat: 0 },
        to: { kind: 'bank' },
        resource: 'grain',
        count: 2,
      },
    ]);
    expect(result.state.seats[0]?.resources.total).toBe(0);
    expect(
      engine.applyPrivate(
        { ...engine.createPrivateState(0), hand: { ...zero, wool: 1, grain: 2 } },
        state,
        input,
      ),
    ).toMatchObject({ ok: true, value: { hand: zero } });
  });
});
