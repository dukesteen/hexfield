import { describe, expect, test } from 'vitest';
import {
  FIVE_SIX_BOARD,
  LocalGame,
  RESOURCES,
  STANDARD_BOARD,
  baseModule,
  boardShapeProblems,
  createEngine,
  failure,
  fiveSixModule,
  moduleSelection,
  success,
} from '../src/index.js';
import type {
  CommandShape,
  Engine,
  GameConfig,
  GameModule,
  GameState,
  HookName,
  LocalRandomSource,
  ModuleHooks,
  Seat,
} from '../src/index.js';
import { createRng } from '../src/rng.js';
import { finishTurnFlowFrame } from '../src/modules/base/phases/turn.js';

/** Every catalogue hook. A missing or extra name is a type error. */
const CATALOGUE: Record<HookName, true> = {
  seatRange: true,
  boardSpec: true,
  boardFixtures: true,
  cardKinds: true,
  bankInit: true,
  pieceLimits: true,
  devDeck: true,
  decks: true,
  costs: true,
  costOf: true,
  diceSpec: true,
  onDiceResult: true,
  production: true,
  afterProduction: true,
  freePieces: true,
  onNoProduction: true,
  placement: true,
  connectivity: true,
  routeGraph: true,
  robberLike: true,
  stealTargets: true,
  handLimit: true,
  bankRate: true,
  afterBuild: true,
  afterInput: true,
  onTurnStart: true,
  onTurnEnd: true,
  turnFlow: true,
  pending: true,
  victoryPoints: true,
  vpTarget: true,
  legalCommands: true,
  timeoutAction: true,
  renderHints: true,
};
const PLACEMENTS = ['settlement', 'road', 'city'] as const;

/** Identity hooks that log `${module}:${hook}` for every call. */
function recordingHooks(id: string, calls: string[]): ModuleHooks {
  const log = (name: string): void => {
    calls.push(`${id}:${name}`);
  };
  /** Log a hook call and return its accumulator unchanged. */
  function keep<T>(name: string, acc: T): T {
    log(name);
    return acc;
  }
  return {
    seatRange: (_config, acc) => keep('seatRange', acc),
    boardSpec: (_config, acc) => keep('boardSpec', acc),
    boardFixtures: (_config, _board, acc) => keep('boardFixtures', acc),
    cardKinds: (acc) => keep('cardKinds', acc),
    bankInit: (_config, acc) => keep('bankInit', { ...acc }),
    pieceLimits: (_config, acc) => keep('pieceLimits', { ...acc }),
    devDeck: (_config, acc) => keep('devDeck', { ...acc }),
    decks: (_config, acc) => keep('decks', { ...acc }),
    costs: (_config, acc) => keep('costs', { ...acc }),
    costOf: (_state, _type, cost) => keep('costOf', cost),
    diceSpec: (_state, acc) => keep('diceSpec', acc),
    onDiceResult: (state) => keep('onDiceResult', state),
    production: (_state, _roll, acc) => keep('production', acc),
    afterProduction: (state) => keep('afterProduction', state),
    freePieces: (_state, _seat, acc) => keep('freePieces', acc),
    onNoProduction: (state) => keep('onNoProduction', state),
    placement: {
      settlement: (_state, _seat, _loc, verdict) => keep('placement.settlement', verdict),
      road: (_state, _seat, _loc, verdict) => keep('placement.road', verdict),
      city: (_state, _seat, _loc, verdict) => keep('placement.city', verdict),
    },
    connectivity: (_state, _seat, acc) => keep('connectivity', acc),
    routeGraph: (_state, _seat, acc) => keep('routeGraph', acc),
    robberLike: (_state, acc) => keep('robberLike', acc),
    stealTargets: (_state, _seat, _blocker, _hex, acc) => keep('stealTargets', acc),
    handLimit: (_state, _seat, acc) => keep('handLimit', acc),
    bankRate: (_state, _seat, _kind, acc) => keep('bankRate', acc),
    afterBuild: (state) => keep('afterBuild', state),
    afterInput: (state) => keep('afterInput', state),
    onTurnStart: (state) => keep('onTurnStart', state),
    onTurnEnd: (state) => keep('onTurnEnd', state),
    turnFlow: (_state, acc) => keep('turnFlow', acc),
    pending: (_state, acc) => keep('pending', acc),
    victoryPoints: (_state, _seat, _priv, acc) => keep('victoryPoints', acc),
    vpTarget: (_config, acc) => keep('vpTarget', acc),
    legalCommands: (_state, _seat, _priv, acc) => keep('legalCommands', acc),
    timeoutAction: (_state, _request, acc) => keep('timeoutAction', acc),
    renderHints: (_state, acc) => keep('renderHints', acc),
  };
}

function isSeat(value: unknown): value is Seat {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

function interludeOpen(state: GameState): boolean {
  const top = state.turn.phase.at(-1);
  return top?.module === 'ks-b' && top.id === 'interlude';
}

/** A leaf module that also inserts one turn-flow frame, owns a command and declares a fixture. */
function kitchenSink(id: string, dependsOn: string[], calls: string[], full: boolean): GameModule {
  const hooks = recordingHooks(id, calls);
  const extras: ModuleHooks = full
    ? {
        boardFixtures: (config, board, acc) => {
          calls.push(`${id}:boardFixtures`);
          return [...acc, { id: 'test-track', module: id, size: 2, art: 'test-track' }];
        },
        turnFlow: (state, acc) => {
          calls.push(`${id}:turnFlow`);
          return [...acc, { id: 'interlude', module: id, data: { seat: state.turn.activeSeat } }];
        },
        timeoutAction: (state, request, acc) => {
          calls.push(`${id}:timeoutAction`);
          return acc ?? (request.phase === 'interlude' ? { type: 'KS_DONE' } : null);
        },
        renderHints: (state, acc) => {
          calls.push(`${id}:renderHints`);
          return [...acc, { module: id, kind: 'fixture-step', fixture: 'test-track', step: 0 }];
        },
      }
    : {};
  return {
    id,
    version: '1.0.0',
    dependsOn,
    conflictsWith: [],
    optionsSchema: [],
    hooks: { ...hooks, ...extras },
    commands: full
      ? {
          KS_DONE: {
            keys: { allowed: [] },
            validate: (state) =>
              interludeOpen(state)
                ? success(undefined)
                : failure('no-interlude', 'No interlude is open'),
            apply: (state, _input, ctx) => finishTurnFlowFrame(state, ctx),
          },
        }
      : {},
    systemInputs: {},
    phases: full
      ? {
          interlude: {
            pending: (state) => [
              { kind: 'player', seat: state.turn.activeSeat, allowed: ['KS_DONE'] },
            ],
            legalCommands: (state, _frame, seat) => ({
              commands: seat === state.turn.activeSeat ? [{ type: 'KS_DONE' }] : [],
              templates: [],
            }),
          },
        }
      : {},
  };
}

function seed(value: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = value;
  return bytes;
}

function source(value: number): LocalRandomSource {
  const rng = createRng(seed(value));
  const deck = rng.shuffle([
    ...Array<string>(14).fill('knight'),
    ...Array<string>(5).fill('victoryPoint'),
    ...Array<string>(2).fill('roadBuilding'),
    ...Array<string>(2).fill('yearOfPlenty'),
    ...Array<string>(2).fill('monopoly'),
  ]);
  return {
    resolve(pending, _state, privates) {
      const request = pending.request;
      switch (pending.systemType) {
        case 'START_SEAT':
          return { input: { kind: 'system', type: 'START_SEAT', seat: 0 } };
        case 'DICE_RESULT':
          return {
            input: { kind: 'system', type: 'DICE_RESULT', dice: [rng.int(6) + 1, rng.int(6) + 1] },
          };
        case 'CARD_DEALT':
          return {
            input: {
              kind: 'system',
              type: 'CARD_DEALT',
              deck: 'dev',
              seat: request.seat,
              slotId: request.slotId,
              card: deck.pop(),
            },
          };
        case 'STEAL_RESULT': {
          const hand =
            (isSeat(request.victim) ? privates.get(request.victim)?.hand : undefined) ?? {};
          return {
            input: {
              kind: 'system',
              type: 'STEAL_RESULT',
              thief: request.thief,
              victim: request.victim,
              resource: RESOURCES.find((kind) => (hand[kind] ?? 0) > 0),
            },
          };
        }
        default: {
          const seat = pending.kind === 'reveal' ? pending.seat : 0;
          return {
            input: {
              kind: 'system',
              type: 'REVEAL_COUNT',
              seat,
              resource: request.resource,
              count: privates.get(seat)?.hand[String(request.resource)] ?? 0,
            },
          };
        }
      }
    },
  };
}

const baseConfig: GameConfig = {
  modules: moduleSelection(['base']),
  seats: [0, 1, 2],
  options: {},
};

function discardFor(game: LocalGame, seat: Seat): CommandShape {
  const hand = { ...game.privateView(seat)?.hand };
  let count = Math.floor(
    (game.state.seats.find((holder) => holder.seat === seat)?.resources.total ?? 0) / 2,
  );
  const cards: Record<string, number> = {};
  for (const kind of RESOURCES) {
    const take = Math.min(hand[kind] ?? 0, count);
    cards[kind] = take;
    count -= take;
  }
  return { type: 'DISCARD', cards };
}

/** Drive a game with legal commands, preferring builds; answers interludes by command or timeout. */
function drive(
  engine: Engine,
  config: GameConfig,
  steps: number,
  value: number,
  onStep?: (game: LocalGame) => void,
): LocalGame {
  const created = LocalGame.create(engine, config, seed(value), source(value));
  if (!created.ok) throw new Error(created.error.message);
  const game = created.value;
  const rng = createRng(seed(value + 50));
  let interludes = 0;
  for (let step = 0; step < steps && !game.state.result; step++) {
    onStep?.(game);
    if (interludeOpen(game.state) && interludes++ % 2 === 1) {
      const timed = game.submit({
        kind: 'system',
        type: 'TIMEOUT',
        seat: game.state.turn.activeSeat,
        phase: 'interlude',
      });
      if (!timed.ok) throw new Error(timed.error.message);
      continue;
    }
    const pending = game
      .getPending()
      .filter(
        (item) => item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
      );
    const chosen =
      pending.find((item) => item.kind === 'player' && item.allowed.includes('DISCARD')) ??
      pending[0];
    if (chosen?.kind !== 'player') throw new Error('No player pending');
    const priv = game.privateView(chosen.seat) ?? undefined;
    let commands = engine
      .getLegalCommands(game.snapshot(), chosen.seat, priv)
      .commands.filter(
        (command) => command.type !== 'CLAIM_VICTORY' && chosen.allowed.includes(command.type),
      );
    const builds = commands.filter((command) => /^(BUILD|PLACE|PLAY)/.test(command.type));
    if (builds.length && rng.int(3) > 0) commands = builds;
    if (!commands.length && chosen.allowed.includes('DISCARD'))
      commands = [discardFor(game, chosen.seat)];
    const command = commands[rng.int(commands.length)];
    if (!command) throw new Error(`No command in ${game.state.turn.phase.at(-1)?.id}`);
    const result = game.submit({ kind: 'command', seat: chosen.seat, command });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return game;
}

function hookCalls(order: 'forward' | 'reverse'): string[] {
  const calls: string[] = [];
  const modules = [
    baseModule(),
    kitchenSink('ks-a', ['base'], calls, false),
    kitchenSink('ks-b', ['ks-a'], calls, true),
  ];
  const engine = createEngine(order === 'forward' ? modules : modules.toReversed());
  const config: GameConfig = {
    ...baseConfig,
    modules: [
      ...baseConfig.modules,
      { id: 'ks-a', version: '1.0.0' },
      { id: 'ks-b', version: '1.0.0' },
    ],
  };
  drive(engine, config, 400, 5);
  return calls;
}

function slotProblems(anchor: { q: number; r: number }, outer: { q: number; r: number }): string[] {
  return boardShapeProblems({ ...STANDARD_BOARD, fixtureSlots: [{ id: 'x', anchor, outer }] });
}

function fixtureModule(count: number): GameModule {
  return {
    id: 'fixture-only',
    version: '1.0.0',
    dependsOn: ['base'],
    conflictsWith: [],
    optionsSchema: [],
    hooks: {
      boardFixtures: (_config, _board, acc) => [
        ...acc,
        ...Array.from({ length: count }, (_, index) => ({
          id: `track-${index}`,
          module: 'fixture-only',
          size: 2 as const,
          art: 'track',
        })),
      ],
    },
    commands: {},
    systemInputs: {},
    phases: {},
  };
}

function fixtureConfig(seats: Seat[], modules: string[]): GameConfig {
  return {
    modules: [...moduleSelection(modules), { id: 'fixture-only', version: '1.0.0' }],
    seats,
    options: {},
  };
}

function strip(state: GameState) {
  const { fixtures: _fixtures, ...board } = state.board;
  return { ...state, board, config: { ...state.config, modules: [] } };
}

describe('kitchen-sink module', () => {
  test('every catalogue hook is called, composed in dependency then id order', () => {
    const calls: string[] = [];
    const engine = createEngine([
      kitchenSink('ks-b', ['ks-a'], calls, true),
      baseModule(),
      kitchenSink('ks-a', ['base'], calls, false),
    ]);
    const config: GameConfig = {
      ...baseConfig,
      modules: [
        ...baseConfig.modules,
        { id: 'ks-a', version: '1.0.0' },
        { id: 'ks-b', version: '1.0.0' },
      ],
    };
    const game = drive(engine, config, 3_000, 3);
    const state = game.snapshot();
    engine.hooks.renderHints(state, []);
    // Only settlement checks read the connectivity hook, and a random game rarely affords one.
    engine.hooks.connectivity(state, 0, []);
    // Only bank trades read the rate hook, and a random game rarely makes one.
    engine.hooks.bankRate(state, 0, 'brick', 4);
    engine.computeVictoryPoints(state, 0);
    expect(engine.checkInvariants(state)).toEqual([]);

    const called = new Set(calls.map((entry) => entry.slice(entry.indexOf(':') + 1)));
    const expected = Object.keys(CATALOGUE).flatMap((name) =>
      name === 'placement' ? PLACEMENTS.map((kind) => `placement.${kind}`) : [name],
    );
    expect(expected.filter((name) => !called.has(name))).toEqual([]);
    // Within one composed call, ks-a (a dependency) always runs immediately before ks-b.
    for (let index = 0; index < calls.length; index++) {
      const entry = calls[index] ?? '';
      if (!entry.startsWith('ks-b:')) continue;
      expect(calls[index - 1]).toBe(`ks-a:${entry.slice(5)}`);
    }
    // The declared fixture sits in the standard board's only slot.
    expect(state.board.fixtures).toEqual([
      {
        id: 'test-track',
        module: 'ks-b',
        slot: 'north',
        footprint: [
          { q: 0, r: -3 },
          { q: 0, r: -4 },
        ],
        orientation: 2,
        art: 'test-track',
      },
    ]);
  });

  test('module hook order does not depend on registration order', () => {
    expect(hookCalls('reverse')).toEqual(hookCalls('forward'));
  });
});

describe('board fixtures', () => {
  test('every board shape satisfies the fixture and harbor slot rules', () => {
    expect(boardShapeProblems(STANDARD_BOARD)).toEqual([]);
    expect(boardShapeProblems(FIVE_SIX_BOARD)).toEqual([]);
    expect(STANDARD_BOARD.fixtureSlots.length).toBeGreaterThanOrEqual(1);
    expect(FIVE_SIX_BOARD.fixtureSlots.length).toBeGreaterThanOrEqual(1);
  });

  test('a slot on a harbor frame, on land, or not pointing outward is rejected', () => {
    const [slot] = STANDARD_BOARD.fixtureSlots;
    if (!slot) throw new Error('No slot');
    expect(slotProblems({ q: 0, r: 0 }, { q: 1, r: 0 })[0]).toMatch(/not a sea-frame hex/);
    expect(slotProblems({ q: -1, r: -2 }, { q: -1, r: -3 })[0]).toMatch(/carries a harbor/);
    expect(slotProblems({ q: 0, r: -3 }, { q: 1, r: -4 })[0]).toMatch(
      /not beyond the frame|directly outward/,
    );
    expect(slotProblems({ q: 0, r: -3 }, { q: 0, r: -5 })[0]).toMatch(/not next to the anchor/);
  });

  test('placement is deterministic, part of the state, and fails without enough slots', () => {
    const engine = createEngine([baseModule(), fixtureModule(1)]);
    const first = engine.createGame(fixtureConfig([0, 1, 2], ['base']), seed(9));
    const second = engine.createGame(fixtureConfig([0, 1, 2], ['base']), seed(9));
    expect(first.board.fixtures).toEqual(second.board.fixtures);
    expect(first.board.fixtures?.[0]?.slot).toBe('north');
    const other = engine.createGame(fixtureConfig([0, 1, 2], ['base']), seed(10));
    expect(other.board.fixtures).toEqual(first.board.fixtures);

    const large = createEngine([baseModule(), fiveSixModule(), fixtureModule(1)]);
    const fiveSix = large.createGame(fixtureConfig([0, 1, 2, 3, 4], ['base', 'five-six']), seed(9));
    expect(fiveSix.board.fixtures?.[0]).toMatchObject({
      slot: 'north-west',
      footprint: [
        { q: 1, r: -4 },
        { q: 1, r: -5 },
      ],
    });

    const tooMany = createEngine([baseModule(), fixtureModule(2)]);
    expect(() => tooMany.createGame(fixtureConfig([0, 1, 2], ['base']), seed(9))).toThrow(
      expect.objectContaining({ code: 'NO_FIXTURE_SLOT' }),
    );
  });

  test('a fixture changes no rules result', () => {
    const plain = createEngine([baseModule()]);
    const withFixture = createEngine([baseModule(), fixtureModule(1)]);
    const config = fixtureConfig([0, 1, 2], ['base']);
    const plainConfig: GameConfig = { ...config, modules: moduleSelection(['base']) };
    const compared: GameState[] = [];
    drive(withFixture, config, 1_500, 11, (game) => compared.push(game.snapshot()));
    const reference = drive(plain, plainConfig, 1_500, 11);
    const replayed = compared.at(-1);
    if (!replayed) throw new Error('No states');
    expect(strip(replayed).board).toEqual(strip(reference.snapshot()).board);
    for (const state of compared.filter((_, index) => index % 25 === 0)) {
      const bare = { ...strip(state), config: { ...state.config, modules: plainConfig.modules } };
      for (const seat of state.config.seats)
        expect(withFixture.getLegalCommands(state, seat)).toEqual(
          plain.getLegalCommands(bare, seat),
        );
      expect(withFixture.getPending(state)).toEqual(plain.getPending(bare));
    }
  });
});
