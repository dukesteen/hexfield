import {
  createBaseEngine,
  createResourceBounds,
  exactResourceBounds,
  RESOURCES,
  zeroCounts,
} from '@cp2p/engine';
import type { EngineEffect, GameState, Input, ResourceBounds, Result, Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { verifyResourceAccounting } from './resource-accounting.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function fixture() {
  const engine = createBaseEngine();
  const state = engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2, 3],
      options: { base: { mapLayout: 'random' } },
    },
    new Uint8Array(32).fill(50),
  );
  return { engine, state };
}

function withHands(state: GameState, hands: ReadonlyMap<Seat, ResourceBounds>): GameState {
  return {
    ...state,
    seats: state.seats.map((seat) => ({
      ...seat,
      resources: hands.get(seat.seat) ?? seat.resources,
    })),
  };
}

const empty = zeroCounts(RESOURCES);

describe('engine resource accounting consistency', () => {
  test('matches legal setup, production, development purchase and deal without changing state', () => {
    const { engine, state: initial } = fixture();
    let state = initial;
    const omissions: Result<void>[] = [];
    const apply = (input: Input) => {
      const before = state;
      const beforeBytes = JSON.stringify(before);
      const transition = value(engine.apply(before, input));
      expect(verifyResourceAccounting(before, transition.state, transition.effects)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(JSON.stringify(before)).toBe(beforeBytes);
      if (transition.effects.length > 0)
        omissions.push(
          verifyResourceAccounting(before, transition.state, transition.effects.slice(0, -1)),
        );
      state = transition.state;
    };
    apply({ kind: 'system', type: 'START_SEAT', seat: 0 });
    for (const vertex of [
      'v:-1,-1,N',
      'v:-1,-1,S',
      'v:-1,0,S',
      'v:-1,1,S',
      'v:0,-1,S',
      'v:0,0,S',
      'v:0,2,N',
      'v:1,1,N',
    ]) {
      const pending = engine.getPending(state).find((item) => item.kind === 'player');
      if (pending?.kind !== 'player') throw new Error('Missing setup player');
      apply({ kind: 'command', seat: pending.seat, command: { type: 'PLACE_SETTLEMENT', vertex } });
      const road = engine
        .getLegalCommands(state, pending.seat)
        .commands.find((item) => item.type === 'PLACE_ROAD');
      if (!road) throw new Error('Missing legal setup road');
      apply({ kind: 'command', seat: pending.seat, command: road });
    }
    for (const seat of [0, 1] as const) {
      apply({ kind: 'command', seat, command: { type: 'ROLL_DICE' } });
      apply({ kind: 'system', type: 'DICE_RESULT', dice: [1, 1] });
      if (seat === 0) apply({ kind: 'command', seat, command: { type: 'END_TURN' } });
    }
    apply({ kind: 'command', seat: 1, command: { type: 'BUY_DEV_CARD' } });
    const pending = engine
      .getPending(state)
      .find((item) => item.kind === 'random' && item.systemType === 'CARD_DEALT');
    if (pending?.kind !== 'random') throw new Error('Missing development draw');
    apply({
      kind: 'system',
      type: 'CARD_DEALT',
      seat: 1,
      deck: 'dev',
      slotId: pending.request.slotId,
    });
    expect(omissions.length).toBeGreaterThanOrEqual(6);
    expect(omissions.every((result) => !result.ok)).toBe(true);
    expect(engine.checkInvariants(state)).toEqual([]);
  });

  test('rejects omitted or substituted gross movements and changes to another public account', () => {
    const initial = fixture().state;
    const before = withHands(
      initial,
      new Map([
        [0, value(exactResourceBounds({ ...empty, grain: 2 }))],
        [1, value(exactResourceBounds({ ...empty, ore: 2 }))],
      ]),
    );
    const after = withHands(
      before,
      new Map([
        [0, value(exactResourceBounds({ ...empty, grain: 1, ore: 1 }))],
        [1, value(exactResourceBounds({ ...empty, grain: 1, ore: 1 }))],
      ]),
    );
    const effects: EngineEffect[] = [
      {
        type: 'resource-transfer',
        from: { kind: 'seat', seat: 0 },
        to: { kind: 'seat', seat: 1 },
        resource: 'grain',
        count: 1,
      },
      {
        type: 'resource-transfer',
        from: { kind: 'seat', seat: 1 },
        to: { kind: 'seat', seat: 0 },
        resource: 'ore',
        count: 1,
      },
    ];
    expect(verifyResourceAccounting(before, after, effects).ok).toBe(true);
    expect(verifyResourceAccounting(before, after, []).ok).toBe(false);
    expect(verifyResourceAccounting(before, after, effects.slice(0, 1)).ok).toBe(false);
    expect(
      verifyResourceAccounting(before, { ...after, bank: { ...after.bank, brick: 18 } }, effects)
        .ok,
    ).toBe(false);
    expect(
      verifyResourceAccounting(before, { ...after, seats: after.seats.slice(1) }, effects).ok,
    ).toBe(false);
    expect(
      verifyResourceAccounting(before, before, [
        {
          type: 'resource-transfer',
          from: { kind: 'bank' },
          to: { kind: 'seat', seat: 0 },
          resource: 'ore',
          count: -1,
        },
      ]).ok,
    ).toBe(false);
  });

  test('requires count reveals before movements, including zero and duplicate reveals', () => {
    const initial = fixture().state;
    const before = withHands(
      initial,
      new Map([[0, value(createResourceBounds(2, empty, { ...empty, wool: 2, ore: 2 }))]]),
    );
    const exact = withHands(
      before,
      new Map([[0, value(exactResourceBounds({ ...empty, wool: 2 }))]]),
    );
    const zeroReveal: EngineEffect = {
      type: 'resource-count-revealed',
      seat: 0,
      resource: 'ore',
      count: 0,
    };
    expect(verifyResourceAccounting(before, exact, [zeroReveal]).ok).toBe(true);
    expect(verifyResourceAccounting(before, exact, []).ok).toBe(false);
    expect(verifyResourceAccounting(before, exact, [zeroReveal, zeroReveal]).ok).toBe(false);
    expect(
      verifyResourceAccounting(before, before, [
        {
          type: 'resource-transfer',
          from: { kind: 'seat', seat: 0 },
          to: { kind: 'seat', seat: 1 },
          resource: 'ore',
          count: 0,
        },
      ]).ok,
    ).toBe(false);
    const reveal: EngineEffect = {
      type: 'resource-count-revealed',
      seat: 0,
      resource: 'wool',
      count: 2,
    };
    const transfer: EngineEffect = {
      type: 'resource-transfer',
      from: { kind: 'seat', seat: 0 },
      to: { kind: 'seat', seat: 1 },
      resource: 'wool',
      count: 2,
    };
    const after = withHands(
      before,
      new Map([
        [0, value(exactResourceBounds(empty))],
        [1, value(exactResourceBounds({ ...empty, wool: 2 }))],
      ]),
    );
    expect(verifyResourceAccounting(before, after, [reveal, transfer]).ok).toBe(true);
    expect(verifyResourceAccounting(before, after, [transfer, reveal]).ok).toBe(false);
  });

  test('checks slot ownership, deck consumption and one-time public reveals', () => {
    const before = fixture().state;
    const slot = { slotId: 'accounting-card', deck: 'dev', acquiredTurn: before.turn.number };
    const deck = before.decks.dev;
    if (!deck) throw new Error('Missing base deck');
    const dealt: GameState = {
      ...before,
      seats: before.seats.map((seat) => (seat.seat === 0 ? { ...seat, cardSlots: [slot] } : seat)),
      decks: {
        ...before.decks,
        dev: { remaining: deck.remaining - 1, drawn: [{ slotId: slot.slotId, seat: 0 }] },
      },
    };
    const effect: EngineEffect = {
      type: 'card-slot-dealt',
      seat: 0,
      deck: 'dev',
      slotId: slot.slotId,
    };
    expect(verifyResourceAccounting(before, dealt, [effect]).ok).toBe(true);
    expect(verifyResourceAccounting(before, { ...dealt, decks: before.decks }, [effect]).ok).toBe(
      false,
    );
    expect(verifyResourceAccounting(before, dealt, [effect, effect]).ok).toBe(false);
    const revealed: GameState = {
      ...dealt,
      seats: dealt.seats.map((seat) =>
        seat.seat === 0 ? { ...seat, cardSlots: [{ ...slot, revealed: 'knight' }] } : seat,
      ),
    };
    const reveal: EngineEffect = {
      type: 'card-slot-revealed',
      seat: 0,
      deck: 'dev',
      slotId: slot.slotId,
      card: 'knight',
    };
    expect(verifyResourceAccounting(dealt, revealed, [reveal]).ok).toBe(true);
    expect(verifyResourceAccounting(dealt, revealed, [{ ...reveal, seat: 1 }]).ok).toBe(false);
    expect(verifyResourceAccounting(revealed, revealed, [reveal]).ok).toBe(false);
  });

  test('projects real steal and monopoly handlers from synthetic uncertain bounds', () => {
    const { engine, state } = fixture();
    const uncertain = withHands(
      state,
      new Map([[1, value(createResourceBounds(2, empty, { ...empty, wool: 2, ore: 2 }))]]),
    );
    const stealing: GameState = {
      ...uncertain,
      turn: {
        ...uncertain.turn,
        activeSeat: 0,
        phase: [
          {
            module: 'base',
            id: 'stealResult',
            data: { thief: 0, victim: 1, returnTo: 'main' },
          },
        ],
      },
    };
    for (const resource of ['hidden', 'ore']) {
      const result = value(
        engine.apply(stealing, {
          kind: 'system',
          type: 'STEAL_RESULT',
          thief: 0,
          victim: 1,
          resource,
        }),
      );
      expect(verifyResourceAccounting(stealing, result.state, result.effects).ok).toBe(true);
      expect(verifyResourceAccounting(stealing, result.state, []).ok).toBe(false);
    }
    const monopoly: GameState = {
      ...uncertain,
      turn: {
        ...uncertain.turn,
        activeSeat: 0,
        phase: [
          { module: 'base', id: 'main', data: null },
          { module: 'base', id: 'monopoly', data: { seat: 0, resource: 'ore', remaining: [1] } },
        ],
      },
    };
    for (const count of [0, 2]) {
      const result = value(
        engine.apply(monopoly, {
          kind: 'system',
          type: 'REVEAL_COUNT',
          seat: 1,
          resource: 'ore',
          count,
        }),
      );
      expect(verifyResourceAccounting(monopoly, result.state, result.effects).ok).toBe(true);
      expect(verifyResourceAccounting(monopoly, result.state, []).ok).toBe(false);
    }
  });
});
