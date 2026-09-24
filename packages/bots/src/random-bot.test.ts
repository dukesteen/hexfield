import { describe, expect, test } from 'vitest';
import { createBaseEngine, exactResourceBounds } from '@cp2p/engine';
import type { GameState, Pending, PrivateState } from '@cp2p/engine';
import { RandomBot, createBotRng } from './random-bot.js';

const engine = createBaseEngine();

function start(): { state: GameState; priv: PrivateState; pending: Pending } {
  const state = engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2],
      options: { base: { mapLayout: 'random' } },
    },
    new Uint8Array(32),
  );
  const started = engine.apply(state, { kind: 'system', type: 'START_SEAT', seat: 0 });
  if (!started.ok) throw new Error(started.error.message);
  const pending = engine
    .getPending(started.value.state)
    .find((item) => item.kind === 'player' && item.seat === 0);
  if (!pending) throw new Error('Missing setup pending');
  return { state: started.value.state, priv: engine.createPrivateState(0), pending };
}

describe('RandomBot', () => {
  test('uses an independent reproducible seed', () => {
    const seed = new Uint8Array(32).fill(6);
    const first = createBotRng(seed);
    const second = createBotRng(seed);
    expect(Array.from({ length: 20 }, () => first.int(1000))).toEqual(
      Array.from({ length: 20 }, () => second.int(1000)),
    );
  });

  test('chooses only validated commands for its own pending', () => {
    const { state, priv, pending } = start();
    const bot = new RandomBot(engine);
    const rng = createBotRng(new Uint8Array(32).fill(3));
    const view = { state, priv, seat: 0 as const };
    for (let n = 0; n < 50; n++) {
      const command = bot.decide(view, pending, rng);
      expect(command.type).toBe('PLACE_SETTLEMENT');
      expect(engine.validate(state, { kind: 'command', seat: 0, command }).ok).toBe(true);
    }
    expect(() => bot.decide({ ...view, seat: 1 }, pending, rng)).toThrow(/own player pending/);
  });

  test('accepts about three in ten trade responses and stops repeating offers', () => {
    const bot = new RandomBot(engine);
    const { state, priv } = start();
    const view = { state, priv, seat: 0 as const };
    const offer = {
      id: 0,
      proposer: 1 as const,
      give: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 },
      want: { brick: 0, lumber: 1, wool: 0, grain: 0, ore: 0 },
      to: [0 as const],
      acceptedBy: [],
      declinedBy: [],
      valid: true,
    };
    expect(bot.respondToTrade(view, offer, { int: () => 2 })).toBe(true);
    expect(bot.respondToTrade(view, offer, { int: () => 3 })).toBe(false);
    const bounds = exactResourceBounds({ brick: 2, lumber: 0, wool: 0, grain: 0, ore: 0 });
    if (!bounds.ok) throw new Error(bounds.error.message);
    const main: GameState = {
      ...state,
      turn: {
        ...state.turn,
        number: 3,
        activeSeat: 0,
        phase: [{ module: 'base', id: 'main', data: null }],
      },
      seats: state.seats.map((holder) =>
        holder.seat === 0 ? { ...holder, resources: bounds.value } : holder,
      ),
    };
    const pending = engine
      .getPending(main)
      .find((item) => item.kind === 'player' && item.seat === 0);
    if (!pending) throw new Error('Missing main pending');
    const active = {
      state: main,
      priv: { ...priv, hand: { brick: 2, lumber: 0, wool: 0, grain: 0, ore: 0 } },
      seat: 0 as const,
    };
    const last = { int: (max: number) => max - 1 };
    expect(bot.decide(active, pending, last).type).toBe('OFFER_TRADE');
    expect(bot.decide(active, pending, last).type).not.toBe('OFFER_TRADE');
  });

  test('saves toward a city when no settlement site is connected', () => {
    const { state, priv } = start();
    const placement = engine
      .getLegalCommands(state, 0, priv)
      .commands.find((command) => command.type === 'PLACE_SETTLEMENT');
    if (!placement || typeof placement.vertex !== 'string')
      throw new Error('Missing setup placement');
    const bounds = exactResourceBounds({ brick: 4, lumber: 0, wool: 0, grain: 0, ore: 0 });
    if (!bounds.ok) throw new Error(bounds.error.message);
    const main: GameState = {
      ...state,
      turn: {
        ...state.turn,
        number: 3,
        activeSeat: 0,
        phase: [{ module: 'base', id: 'main', data: null }],
      },
      board: {
        ...state.board,
        buildings: [{ vertex: placement.vertex, seat: 0, kind: 'settlement' }],
      },
      seats: state.seats.map((holder) =>
        holder.seat === 0 ? { ...holder, resources: bounds.value } : holder,
      ),
    };
    const pending = engine
      .getPending(main)
      .find((item) => item.kind === 'player' && item.seat === 0);
    if (!pending) throw new Error('Missing main pending');
    const selected = new RandomBot(engine).decide(
      {
        state: main,
        seat: 0,
        priv: { ...priv, hand: { brick: 4, lumber: 0, wool: 0, grain: 0, ore: 0 } },
      },
      pending,
      { int: (max) => max - 1 },
    );
    expect(['MARITIME_TRADE', 'OFFER_TRADE']).toContain(selected.type);
    expect(selected.type === 'MARITIME_TRADE' ? selected.get : selected.want).toEqual({ ore: 1 });

    const nearCity = { brick: 0, lumber: 0, wool: 1, grain: 1, ore: 3 };
    const nearBounds = exactResourceBounds(nearCity);
    if (!nearBounds.ok) throw new Error(nearBounds.error.message);
    const saving: GameState = {
      ...main,
      seats: main.seats.map((holder) =>
        holder.seat === 0 ? { ...holder, resources: nearBounds.value } : holder,
      ),
    };
    const noPurchase = new RandomBot(engine).decide(
      { state: saving, seat: 0, priv: { ...priv, hand: nearCity } },
      pending,
      { int: (max) => max - 1 },
    );
    expect(noPurchase.type).not.toBe('BUY_DEV_CARD');
    expect(noPurchase.type === 'OFFER_TRADE' ? noPurchase.want : undefined).toEqual({ grain: 1 });
    expect(
      engine
        .getLegalCommands(saving, 0, { ...priv, hand: nearCity })
        .commands.some((command) => command.type === 'BUY_DEV_CARD'),
    ).toBe(true);
    for (let index = 0; index < 100; index++) {
      const choice = new RandomBot(engine).decide(
        { state: saving, seat: 0, priv: { ...priv, hand: nearCity } },
        pending,
        { int: (max) => index % max },
      );
      expect(choice.type).not.toBe('BUY_DEV_CARD');
    }

    const roadHand = { brick: 1, lumber: 1, wool: 0, grain: 0, ore: 0 };
    const roadBounds = exactResourceBounds(roadHand);
    if (!roadBounds.ok) throw new Error(roadBounds.error.message);
    const roadState = {
      ...main,
      seats: main.seats.map((holder) =>
        holder.seat === 0 ? { ...holder, resources: roadBounds.value } : holder,
      ),
    };
    expect(
      Array.from({ length: 100 }, (_, index) =>
        new RandomBot(engine).decide(
          { state: roadState, seat: 0, priv: { ...priv, hand: roadHand } },
          pending,
          { int: (max) => index % max },
        ),
      ).some((command) => command.type === 'BUILD_ROAD'),
    ).toBe(true);
  });

  test('discards surplus before saved city grain and ore', () => {
    const { state, priv } = start();
    const placement = engine
      .getLegalCommands(state, 0, priv)
      .commands.find((command) => command.type === 'PLACE_SETTLEMENT');
    if (!placement || typeof placement.vertex !== 'string')
      throw new Error('Missing setup placement');
    const saved = { brick: 7, lumber: 0, wool: 0, grain: 2, ore: 3 };
    const bounds = exactResourceBounds(saved);
    if (!bounds.ok) throw new Error(bounds.error.message);
    const discard: GameState = {
      ...state,
      board: {
        ...state.board,
        buildings: [{ vertex: placement.vertex, seat: 0, kind: 'settlement' }],
      },
      seats: state.seats.map((holder) =>
        holder.seat === 0 ? { ...holder, resources: bounds.value } : holder,
      ),
      turn: {
        ...state.turn,
        number: 4,
        activeSeat: 0,
        phase: [{ module: 'base', id: 'discard', data: { remaining: [0] } }],
      },
    };
    const pending = engine
      .getPending(discard)
      .find((item) => item.kind === 'player' && item.seat === 0);
    if (!pending) throw new Error('Missing discard pending');
    const selected = new RandomBot(engine).decide(
      { state: discard, seat: 0, priv: { ...priv, hand: saved } },
      pending,
      { int: (max) => max - 1 },
    );
    expect(selected.type).toBe('DISCARD');
    expect(selected.cards).toEqual({ brick: 6, lumber: 0, wool: 0, grain: 0, ore: 0 });
  });
});
