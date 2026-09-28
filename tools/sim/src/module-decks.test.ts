import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { engineForConfig, isPublicDraw, publicDrawInput, registerAdHocModule } from '@cp2p/engine';
import type { GameConfig, GameModule, GameState, Pending } from '@cp2p/engine';
import { createLocalRandomSource, deriveSeed } from './random-source.js';

const ID = 'sim-deck-test';
const FOG = { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 };
const LOOT = { coin: 2, gem: 1 };

function deckModule(): GameModule {
  return {
    id: ID,
    version: '1.0.0',
    dependsOn: ['base'],
    conflictsWith: [],
    optionsSchema: [],
    hooks: {
      decks: (_config, acc) => ({
        ...acc,
        fog: { cards: FOG, reveal: 'public' },
        loot: { cards: LOOT, reveal: 'private' },
      }),
    },
    commands: {},
    systemInputs: {},
    phases: {},
  };
}

const config: GameConfig = {
  modules: [
    { id: 'base', version: '1.0.0' },
    { id: ID, version: '1.0.0' },
  ],
  seats: [0, 1, 2],
  options: { base: {} },
};
let dispose = (): void => undefined;
beforeAll(() => {
  dispose = registerAdHocModule(ID, '1.0.0', deckModule);
});
afterAll(() => {
  dispose();
});

function stateFor(genesisSeed: number): GameState {
  return engineForConfig(config).createGame(config, deriveSeed(genesisSeed, 0, 'genesis'));
}

function fogPending(index: number): Extract<Pending, { kind: 'random' }> {
  return {
    kind: 'random',
    systemType: 'FOG_REVEALED',
    request: {
      type: 'draw',
      deck: 'fog',
      public: true,
      seat: 1,
      slotId: `fog:${index}`,
      remaining: 6 - index,
    },
  };
}

function fogOrder(sourceSeed: number, genesisSeed: number): string[] {
  const state = stateFor(genesisSeed);
  const source = createLocalRandomSource(deriveSeed(sourceSeed, 0, 'system'));
  return Array.from({ length: 6 }, (_, index) => {
    const pending = fogPending(index);
    if (!isPublicDraw(pending)) throw new Error('not a public draw');
    const answer = source.resolve(pending, state, new Map());
    expect(answer.input).toEqual(publicDrawInput(pending, String(answer.input.card)));
    const card = answer.input.card;
    if (typeof card !== 'string') throw new Error('missing revealed card');
    return card;
  });
}

describe('module decks in the local random source', () => {
  test('a public deck is dealt whole from its own hidden order, then runs out', () => {
    const order = fogOrder(3, 11);
    expect([...order].toSorted()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    const source = createLocalRandomSource(deriveSeed(3, 0, 'system'));
    const state = stateFor(11);
    for (let index = 0; index < 6; index++) source.resolve(fogPending(index), state, new Map());
    expect(() => source.resolve(fogPending(6), state, new Map())).toThrow('empty');
  });

  test('the order comes from the source seed, never from the board seed', () => {
    expect(fogOrder(3, 11)).toEqual(fogOrder(3, 11));
    expect(fogOrder(3, 11)).toEqual(fogOrder(3, 99));
    expect(fogOrder(3, 11)).not.toEqual(fogOrder(4, 11));
  });

  test('a private module deck is dealt through CARD_DEALT and cannot be drawn publicly', () => {
    const state = stateFor(11);
    const source = createLocalRandomSource(deriveSeed(3, 0, 'system'));
    const dealt = Array.from({ length: 3 }, (_, index) => {
      const answer = source.resolve(
        {
          kind: 'random',
          systemType: 'CARD_DEALT',
          request: { type: 'draw', deck: 'loot', seat: 2, slotId: `loot:${index}`, remaining: 3 },
        },
        state,
        new Map(),
      );
      expect(answer.input).toMatchObject({ type: 'CARD_DEALT', deck: 'loot', seat: 2 });
      return String(answer.input.card);
    });
    expect([...dealt].toSorted()).toEqual(['coin', 'coin', 'gem']);
    expect(() =>
      createLocalRandomSource(deriveSeed(3, 0, 'system')).resolve(
        {
          kind: 'random',
          systemType: 'LOOT_SHOWN',
          request: { type: 'draw', deck: 'loot', public: true, seat: 0, slotId: 'x' },
        },
        state,
        new Map(),
      ),
    ).toThrow('not a public deck');
  });
});
