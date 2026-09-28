import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  FIVE_SIX_DEV_CARDS,
  DEV_CARD_COUNTS,
  deckCatalogueFor,
  decksFor,
  devCardCatalogueFor,
  engineForConfig,
  failure,
  isPublicDraw,
  moduleSelection,
  publicDrawInput,
  registerAdHocModule,
  success,
} from '../index.js';
import type { GameConfig, GameModule, GameState, Pending } from '../index.js';

const ID = 'deck-test';
const TILES = Object.freeze({ a: 1, b: 1, c: 2 });
const LOOT = Object.freeze({ coin: 2, gem: 1 });

/** One public and one private module deck, drawn from frames the tests push directly. */
function deckTestModule(): GameModule {
  return {
    id: ID,
    version: '1.0.0',
    dependsOn: ['base'],
    conflictsWith: [],
    optionsSchema: [],
    hooks: {
      decks: (_config, acc) => ({
        ...acc,
        tiles: { cards: TILES, reveal: 'public' },
        loot: { cards: LOOT, reveal: 'private' },
      }),
    },
    commands: {},
    systemInputs: {
      TILE_SHOWN: {
        validate: (state, input) =>
          input.deck === 'tiles' &&
          input.seat === 1 &&
          input.slotId === 'tile:0' &&
          input.remaining === state.decks.tiles?.remaining &&
          input.note === 'echoed' &&
          typeof input.card === 'string' &&
          Object.hasOwn(TILES, input.card)
            ? success(undefined)
            : failure('tile-mismatch', 'Reveal does not match the request'),
        apply: (state, input) => {
          const tiles = state.decks.tiles;
          if (!tiles) throw new Error('missing deck');
          return {
            state: {
              ...state,
              decks: {
                ...state.decks,
                tiles: {
                  remaining: tiles.remaining - 1,
                  drawn: [...tiles.drawn, { slotId: 'tile:0', seat: 1 }],
                },
              },
              ext: { ...state.ext, [ID]: { shown: input.card } },
              turn: { ...state.turn, phase: state.turn.phase.slice(0, -1) },
            },
            events: [],
            effects: [],
          };
        },
      },
    },
    phases: {
      showTile: {
        pending: (state) => [
          {
            kind: 'random',
            request: {
              type: 'draw',
              deck: 'tiles',
              public: true,
              seat: 1,
              slotId: 'tile:0',
              remaining: state.decks.tiles?.remaining ?? 0,
              note: 'echoed',
            },
            systemType: 'TILE_SHOWN',
          },
        ],
      },
    },
  };
}

const config: GameConfig = {
  modules: [
    { id: 'base', version: '1.0.0' },
    { id: ID, version: '1.0.0' },
  ],
  seats: [0, 1, 2],
  options: { base: { mapLayout: 'random' } },
};
const seed = new Uint8Array(32).fill(5);
let dispose = (): void => undefined;
beforeAll(() => {
  dispose = registerAdHocModule(ID, '1.0.0', deckTestModule);
});
afterAll(() => {
  dispose();
});

function withFrame(state: GameState, frame: GameState['turn']['phase'][number]): GameState {
  return { ...state, turn: { ...state.turn, phase: [...state.turn.phase, frame] } };
}

function randomPending(state: GameState): Extract<Pending, { kind: 'random' }> {
  const found = engineForConfig(config)
    .getPending(state)
    .find((item) => item.kind === 'random');
  if (found?.kind !== 'random') throw new Error('Expected a random pending');
  return found;
}

describe('module-declared decks', () => {
  test('base games declare only the private dev deck, five-six only changes its counts', () => {
    const base: GameConfig = {
      modules: moduleSelection(['base']),
      seats: [0, 1, 2, 3],
      options: { base: { mapLayout: 'random' } },
    };
    expect(decksFor(base)).toEqual({ dev: { cards: DEV_CARD_COUNTS, reveal: 'private' } });
    const six: GameConfig = {
      modules: moduleSelection(['base', 'five-six']),
      seats: [0, 1, 2, 3, 4, 5],
      options: { base: { mapLayout: 'random' }, 'five-six': {} },
    };
    expect(decksFor(six)).toEqual({ dev: { cards: FIVE_SIX_DEV_CARDS, reveal: 'private' } });
    expect(devCardCatalogueFor(base)).toEqual(deckCatalogueFor(base, 'dev'));
    expect(deckCatalogueFor(base, 'fog')).toEqual([]);
  });

  test('a module adds decks in ascending id order and genesis initializes their counts', () => {
    expect(Object.keys(decksFor(config))).toEqual(['dev', 'loot', 'tiles']);
    expect(deckCatalogueFor(config, 'tiles').map((card) => card.identity)).toEqual([
      'a#1',
      'b#1',
      'c#1',
      'c#2',
    ]);
    const state = engineForConfig(config).createGame(config, seed);
    expect(state.decks.dev).toEqual({ remaining: 25, drawn: [] });
    expect(state.decks.tiles).toEqual({ remaining: 4, drawn: [] });
    expect(state.decks.loot).toEqual({ remaining: 3, drawn: [] });
    expect(engineForConfig(config).checkInvariants(state)).toEqual([]);
  });

  test('a public draw is answered by the echoed request plus the shown card', () => {
    const engine = engineForConfig(config);
    const state = withFrame(engine.createGame(config, seed), {
      id: 'showTile',
      module: ID,
      data: null,
    });
    const pending = randomPending(state);
    expect(isPublicDraw(pending)).toBe(true);
    const input = publicDrawInput(pending, 'c');
    expect(input).toEqual({
      kind: 'system',
      type: 'TILE_SHOWN',
      deck: 'tiles',
      seat: 1,
      slotId: 'tile:0',
      remaining: 4,
      note: 'echoed',
      card: 'c',
    });
    const applied = engine.apply(state, input);
    if (!applied.ok) throw new Error(applied.error.message);
    expect(applied.value.state.decks.tiles).toEqual({
      remaining: 3,
      drawn: [{ slotId: 'tile:0', seat: 1 }],
    });
    expect(engine.apply(state, publicDrawInput(pending, 'z')).ok).toBe(false);
    expect(engine.apply(state, { ...input, note: 'other' }).ok).toBe(false);
    expect(engine.apply(state, { ...input, seat: 2 }).ok).toBe(false);
  });

  test('a private draw of a module deck reuses CARD_DEALT and reaches only the owner', () => {
    const engine = engineForConfig(config);
    const state = withFrame(engine.createGame(config, seed), {
      id: 'drawDev',
      module: 'base',
      data: { seat: 2, slotId: 'loot:0', deck: 'loot' },
    });
    const pending = randomPending(state);
    expect(isPublicDraw(pending)).toBe(false);
    expect(pending.request).toMatchObject({ type: 'draw', deck: 'loot', remaining: 3 });
    expect(pending.systemType).toBe('CARD_DEALT');
    const dealt = {
      kind: 'system' as const,
      type: 'CARD_DEALT',
      deck: 'loot',
      seat: 2,
      slotId: 'loot:0',
    };
    expect(engine.apply(state, { ...dealt, deck: 'dev' }).ok).toBe(false);
    expect(engine.apply(state, { ...dealt, card: 'knight' }).ok).toBe(false);
    const applied = engine.apply(state, dealt);
    if (!applied.ok) throw new Error(applied.error.message);
    expect(applied.value.state.decks.loot).toEqual({
      remaining: 2,
      drawn: [{ slotId: 'loot:0', seat: 2 }],
    });
    expect(applied.value.state.decks.dev).toEqual({ remaining: 25, drawn: [] });
    expect(applied.value.state.seats.find((seat) => seat.seat === 2)?.cardSlots).toMatchObject([
      { slotId: 'loot:0', deck: 'loot' },
    ]);
    const owner = engine.applyPrivate(engine.createPrivateState(2, config), state, dealt, {
      card: 'gem',
    });
    if (!owner.ok) throw new Error(owner.error.message);
    expect(owner.value.slots).toEqual({ 'loot:0': 'gem' });
    const other = engine.applyPrivate(engine.createPrivateState(1, config), state, dealt, {
      card: 'gem',
    });
    if (!other.ok) throw new Error(other.error.message);
    expect(other.value.slots).toEqual({});
    expect(
      engine.applyPrivate(engine.createPrivateState(2, config), state, dealt, { card: 'knight' })
        .ok,
    ).toBe(false);
  });
});
