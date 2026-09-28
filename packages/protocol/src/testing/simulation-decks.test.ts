import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { GameState, Seat } from '@cp2p/engine';
import type { LogContext } from '../log.js';
import { SimulationDriver } from './simulation-driver.js';
import { createSimulationGenesis } from './simulation-genesis.js';
import {
  FOG_CARDS,
  LOOT_CARDS,
  registerSyntheticDecks,
  revealedFog,
  syntheticConfig,
} from './synthetic-decks.js';

let dispose = (): void => undefined;
beforeAll(() => {
  dispose = registerSyntheticDecks();
});
afterAll(() => {
  dispose();
});

const SEATS: readonly Seat[] = [0, 1, 2, 3];

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing seat');
  return value;
}

function withFrame(state: GameState, frame: GameState['turn']['phase'][number]): GameState {
  return { ...state, turn: { ...state.turn, phase: [...state.turn.phase, frame] } };
}

describe('SimulationDriver with module decks', () => {
  test('answers public fog draws and private loot draws from the declared catalogue', () => {
    const sim = createSimulationGenesis({ seed: 23, config: syntheticConfig([0, 1, 2, 3]) });
    const driver = new SimulationDriver(sim.engine, sim.genesis);
    const context = (state: GameState): LogContext => ({
      genesis: sim.genesis,
      engine: sim.engine,
      head: sim.entry,
      state,
      crypto: null,
      lastNonces: new Map(),
    });
    let state = sim.engine.createGame(sim.genesis.config, new Uint8Array(32).fill(3));
    const cards: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const seat = need(SEATS[index % SEATS.length]);
      const drawing = withFrame(state, {
        id: 'drawFog',
        module: 'synthetic-decks',
        data: { seat, slotId: `fog:${index}` },
      });
      const answer = driver.next(context(drawing));
      if (!answer) throw new Error('Expected a public draw answer');
      expect(answer.input).toMatchObject({
        type: 'FOG_REVEALED',
        deck: 'fog',
        seat,
        edge: 'north',
      });
      const applied = sim.engine.apply(drawing, answer.input);
      if (!applied.ok) throw new Error(applied.error.message);
      expect(driver.committed(context(drawing), answer.input, applied.value.state).ok).toBe(true);
      state = applied.value.state;
      cards.push(String(Reflect.get(answer.input, 'card')));
    }
    expect([...cards].toSorted()).toEqual(Object.keys(FOG_CARDS));
    expect(revealedFog(state)).toEqual(cards);

    const looting = withFrame(state, {
      id: 'drawDev',
      module: 'base',
      data: { seat: 2, slotId: 'loot:0', deck: 'loot' },
    });
    const dealt = driver.next(context(looting));
    if (!dealt) throw new Error('Expected a private draw answer');
    expect(dealt.input).toEqual({
      kind: 'system',
      type: 'CARD_DEALT',
      deck: 'loot',
      seat: 2,
      slotId: 'loot:0',
    });
    const applied = sim.engine.apply(looting, dealt.input);
    if (!applied.ok) throw new Error(applied.error.message);
    expect(driver.committed(context(looting), dealt.input, applied.value.state).ok).toBe(true);
    const held = driver.privateState(2)?.slots['loot:0'];
    expect(Object.hasOwn(LOOT_CARDS, String(held))).toBe(true);
    expect(driver.privateState(1)?.slots).toEqual({});
  });
});
