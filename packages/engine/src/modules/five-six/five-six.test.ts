import { describe, expect, test } from 'vitest';
import { boardShapeProblems } from '../../core/board/index.js';
import { createRng } from '../../core/rng/index.js';
import { LocalGame } from '../../core/pipeline/index.js';
import type { Engine, Input, LocalRandomSource } from '../../core/pipeline/index.js';
import { exactResourceBounds } from '../../core/resources/index.js';
import type { GameConfig, GameState } from '../../core/state/index.js';
import type { ResourceCounts, Seat } from '../../core/types/index.js';
import { RESOURCES } from '../../core/types/index.js';
import { devCardCountsFor, engineForModules, moduleSelection } from '../catalogue.js';
import { FIVE_SIX_BOARD } from './board.js';
import { FIVE_SIX_DEV_CARDS, SBP_COMMANDS } from './index.js';

const engine = engineForModules(moduleSelection(['base', 'five-six']));
/** Keeps every special build phase open so tests can step through each seat. */
const manual: Engine = { ...engine, getAutomaticInput: () => null };
const zero: ResourceCounts = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };

function config(seats: number, fiveSix: Record<string, unknown> = {}): GameConfig {
  return {
    modules: moduleSelection(['base', 'five-six']),
    seats: ([0, 1, 2, 3, 4, 5] as const).slice(0, seats),
    options: { 'five-six': fiveSix },
  };
}

function seed(value: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = value & 0xff;
  bytes[1] = value >> 8;
  return bytes;
}

/** Seeded local source over the configured deck; only for rules tests. */
function randomSource(value: number, counts: Readonly<Record<string, number>>): LocalRandomSource {
  const rng = createRng(seed(value));
  const deck = rng.shuffle(
    Object.entries(counts).flatMap(([card, count]) => Array<string>(count).fill(card)),
  );
  return {
    resolve(pending, state, privates) {
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
              seat: pending.request.seat,
              slotId: pending.request.slotId,
              card: deck.pop(),
            },
          };
        case 'STEAL_RESULT': {
          const victim = pending.request.victim;
          const hand =
            (victim === 0 ||
            victim === 1 ||
            victim === 2 ||
            victim === 3 ||
            victim === 4 ||
            victim === 5
              ? privates.get(victim)?.hand
              : undefined) ?? {};
          const resource = RESOURCES.find((kind) => (hand[kind] ?? 0) > 0);
          return {
            input: {
              kind: 'system',
              type: 'STEAL_RESULT',
              thief: pending.request.thief,
              victim,
              resource,
            },
          };
        }
        case 'REVEAL_COUNT':
          return {
            input: {
              kind: 'system',
              type: 'REVEAL_COUNT',
              seat: pending.kind === 'reveal' ? pending.seat : 0,
              resource: pending.request.resource,
              count:
                privates.get(pending.kind === 'reveal' ? pending.seat : 0)?.hand[
                  String(pending.request.resource)
                ] ?? 0,
            },
          };
        default:
          throw new Error(`Unexpected ${pending.systemType} in ${state.turn.phase.at(-1)?.id}`);
      }
    },
  };
}

function start(
  seats: number,
  fiveSix: Record<string, unknown> = {},
  rules: Engine = manual,
): LocalGame {
  const cfg = config(seats, fiveSix);
  const created = LocalGame.create(
    rules,
    cfg,
    seed(seats),
    randomSource(seats, FIVE_SIX_DEV_CARDS),
  );
  if (!created.ok) throw new Error(created.error.message);
  const game = created.value;
  while (game.state.turn.phase.at(-1)?.id === 'setup') {
    const pending = game.getPending().find((item) => item.kind === 'player');
    if (pending?.kind !== 'player') throw new Error('Setup has no player');
    const command = engine.getLegalCommands(game.snapshot(), pending.seat).commands[0];
    if (!command) throw new Error('No setup command');
    const placed = game.submit({ kind: 'command', seat: pending.seat, command });
    if (!placed.ok) throw new Error(placed.error.message);
  }
  return game;
}

function submit(game: LocalGame, input: Input): void {
  const result = game.submit(input);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
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

function endMainTurn(game: LocalGame): void {
  submit(game, {
    kind: 'command',
    seat: game.state.turn.activeSeat,
    command: { type: 'ROLL_DICE' },
  });
  // Resolve discards and robber moves until the active seat can end the turn.
  for (let guard = 0; guard < 50 && game.state.turn.phase.at(-1)?.id !== 'main'; guard++) {
    const pending = game.getPending().find((item) => item.kind === 'player');
    if (pending?.kind !== 'player') break;
    const legal = engine.getLegalCommands(
      game.snapshot(),
      pending.seat,
      game.privateView(pending.seat) ?? undefined,
    );
    const command =
      legal.commands.find((item) => item.type !== 'CLAIM_VICTORY') ??
      (pending.allowed.includes('DISCARD')
        ? {
            type: 'DISCARD',
            cards: game.privateView(pending.seat)?.hand ?? {},
          }
        : undefined);
    if (!command) throw new Error(`No command in ${game.state.turn.phase.at(-1)?.id}`);
    if (command.type === 'DISCARD') {
      const hand = { ...game.privateView(pending.seat)?.hand };
      let count = Math.floor(
        (game.state.seats.find((seat) => seat.seat === pending.seat)?.resources.total ?? 0) / 2,
      );
      const cards: Record<string, number> = {};
      for (const kind of RESOURCES) {
        const take = Math.min(hand[kind] ?? 0, count);
        cards[kind] = take;
        count -= take;
      }
      submit(game, { kind: 'command', seat: pending.seat, command: { type: 'DISCARD', cards } });
    } else submit(game, { kind: 'command', seat: pending.seat, command });
  }
  submit(game, {
    kind: 'command',
    seat: game.state.turn.activeSeat,
    command: { type: 'END_TURN' },
  });
}

describe('five-six module', () => {
  test('genesis uses the 30-hex board, 24-card bank, 34-card deck and 5–6 seats', () => {
    expect(boardShapeProblems(FIVE_SIX_BOARD)).toEqual([]);
    for (const seats of [5, 6]) {
      const state = engine.createGame(config(seats), seed(seats));
      expect(state.board.hexes).toHaveLength(30);
      expect(state.board.hexes.filter((hex) => hex.terrain === 'desert')).toHaveLength(2);
      expect(state.board.hexes.filter((hex) => hex.token !== null)).toHaveLength(28);
      expect(state.board.harbors).toHaveLength(11);
      expect(state.board.harbors.filter((harbor) => harbor.kind === 'wool')).toHaveLength(2);
      expect(state.board.harbors.filter((harbor) => harbor.kind === 'generic')).toHaveLength(5);
      expect(state.bank).toEqual({ brick: 24, lumber: 24, wool: 24, grain: 24, ore: 24 });
      expect(state.decks.dev?.remaining).toBe(34);
      expect(state.seats.every((seat) => seat.piecesLeft.road === 15)).toBe(true);
      expect(state.board.fixtures).toBeUndefined();
      expect(engine.checkInvariants(state)).toEqual([]);
    }
    expect(devCardCountsFor(config(5))).toEqual(FIVE_SIX_DEV_CARDS);
    expect(() => engine.createGame(config(4), seed(4))).toThrow(/require 5 to 6 seats/);
    expect(() => engine.createGame(config(3), seed(3))).toThrow(/require 5 to 6 seats/);
  });

  test('balanced generation succeeds and never puts 6 and 8 together on many seeds', () => {
    for (const strictBalance of [false, true])
      for (let index = 0; index < 300; index++) {
        const state = engine.createGame(
          { ...config(6), options: { base: { strictBalance }, 'five-six': {} } },
          seed(1000 + index),
        );
        const byId = new Map(state.board.hexes.map((hex) => [hex.id, hex]));
        for (const hex of state.board.hexes) {
          if (hex.token !== 6 && hex.token !== 8) continue;
          for (const [dq, dr] of [
            [1, 0],
            [1, -1],
            [0, -1],
            [-1, 0],
            [-1, 1],
            [0, 1],
          ] as const) {
            const other = byId.get(`h:${hex.q + dq},${hex.r + dr}`);
            expect(other?.token === 6 || other?.token === 8).toBe(false);
          }
        }
      }
  });

  test('ending a turn opens a special build phase for every other seat in turn order', () => {
    const game = start(5);
    expect(game.state.turn.activeSeat).toBe(0);
    endMainTurn(game);
    const order: Seat[] = [];
    for (let index = 0; index < 4; index++) {
      const top = game.state.turn.phase.at(-1);
      expect(top).toMatchObject({ id: 'sbp', module: 'five-six' });
      const pending = game.getPending();
      expect(pending).toHaveLength(1);
      const only = pending[0];
      if (only?.kind !== 'player') throw new Error('SBP is not a player pending');
      expect(only.allowed).toEqual([...SBP_COMMANDS]);
      order.push(only.seat);
      expect(game.state.turn.activeSeat).toBe(0);
      submit(game, { kind: 'command', seat: only.seat, command: { type: 'END_SBP' } });
    }
    expect(order).toEqual([1, 2, 3, 4]);
    expect(game.state.turn.activeSeat).toBe(1);
    expect(game.state.turn.phase).toEqual([{ id: 'preRoll', module: 'base', data: null }]);
    expect(engine.checkInvariants(game.snapshot())).toEqual([]);
  });

  test('the special build phase rejects trades and card plays but allows builds and buys', () => {
    const game = start(5);
    endMainTurn(game);
    const rich = withHand(game.snapshot(), 1, {
      ...zero,
      brick: 3,
      lumber: 3,
      wool: 3,
      grain: 4,
      ore: 4,
    });
    const reject = (command: Record<string, unknown>, seat: Seat = 1) => {
      const result = engine.validate(rich, {
        kind: 'command',
        seat,
        command: { type: String(command.type), ...command },
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'not-pending' } });
    };
    reject({ type: 'MARITIME_TRADE', give: { brick: 4 }, get: { ore: 1 } });
    reject({ type: 'OFFER_TRADE', give: { brick: 1 }, want: { ore: 1 } });
    reject({ type: 'PROPOSE_TRADE', give: { brick: 1 }, want: { ore: 1 } });
    reject({ type: 'PLAY_DEV_CARD', slotId: 'dev:0', card: 'knight' });
    reject({ type: 'END_TURN' });
    reject({ type: 'ROLL_DICE' });
    reject({ type: 'BUILD_ROAD', edge: 'e:0,0,W' }, 2);
    reject({ type: 'PROPOSE_TRADE', give: { brick: 1 }, want: { ore: 1 } }, 0);

    const legal = engine.getLegalCommands(rich, 1).commands.map((command) => command.type);
    expect(new Set(legal)).toEqual(
      new Set(['END_SBP', 'BUILD_ROAD', 'BUY_DEV_CARD', 'BUILD_CITY']),
    );
    const road = engine
      .getLegalCommands(rich, 1)
      .commands.find((item) => item.type === 'BUILD_ROAD');
    if (!road) throw new Error('No road');
    const built = engine.apply(rich, { kind: 'command', seat: 1, command: road });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.state.turn.phase.at(-1)?.id).toBe('sbp');
    const city = engine
      .getLegalCommands(rich, 1)
      .commands.find((item) => item.type === 'BUILD_CITY');
    if (!city) throw new Error('No city');
    expect(engine.apply(rich, { kind: 'command', seat: 1, command: city }).ok).toBe(true);
    const bought = engine.apply(rich, {
      kind: 'command',
      seat: 1,
      command: { type: 'BUY_DEV_CARD' },
    });
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;
    expect(bought.value.state.turn.phase.at(-1)).toMatchObject({ id: 'drawDev', module: 'base' });
    const dealt = engine.apply(bought.value.state, {
      kind: 'system',
      type: 'CARD_DEALT',
      deck: 'dev',
      seat: 1,
      slotId: 'dev:0',
    });
    expect(dealt.ok).toBe(true);
    if (!dealt.ok) return;
    expect(dealt.value.state.turn.phase.at(-1)).toMatchObject({ id: 'sbp', data: { seat: 1 } });
  });

  test('a seat whose own hand can build nothing has its special build phase ended for it', () => {
    const game = start(5);
    endMainTurn(game);
    const state = game.snapshot();
    const own = game.privateView(1);
    if (!own) throw new Error('No private state');
    const hand = (counts: ResourceCounts) => new Map([[1 as Seat, { ...own, hand: counts }]]);
    expect(engine.getAutomaticInput(state, hand(zero))).toEqual({
      kind: 'command',
      seat: 1,
      command: { type: 'END_SBP' },
    });
    expect(engine.getAutomaticInput(state, hand({ ...zero, wool: 1, grain: 1, ore: 1 }))).toBe(
      null,
    );
    // Only the seat's own client knows its hand, so other seats never end it.
    const other = game.privateView(2);
    if (!other) throw new Error('No private state');
    expect(engine.getAutomaticInput(state, new Map([[2 as Seat, other]]))).toBe(null);

    const auto = start(6, {}, engine);
    const turns = 12;
    let open = 0;
    for (let turn = 0; turn < turns; turn++) {
      endMainTurn(auto);
      while (auto.state.turn.phase.at(-1)?.id === 'sbp') {
        const pending = auto.getPending()[0];
        if (pending?.kind !== 'player') throw new Error('SBP is not a player pending');
        const legal = engine.getLegalCommands(
          auto.snapshot(),
          pending.seat,
          auto.privateView(pending.seat) ?? undefined,
        );
        expect(legal.commands.some((command) => command.type !== 'END_SBP')).toBe(true);
        open++;
        submit(auto, { kind: 'command', seat: pending.seat, command: { type: 'END_SBP' } });
      }
    }
    expect(open).toBeLessThan(turns * 5);
    expect(engine.checkInvariants(auto.snapshot())).toEqual([]);
  });

  test('a timeout ends the special build phase for that seat only', () => {
    const game = start(6);
    endMainTurn(game);
    const state = game.snapshot();
    expect(
      engine.validate(state, { kind: 'system', type: 'TIMEOUT', seat: 2, phase: 'sbp' }).ok,
    ).toBe(false);
    const timed = engine.apply(state, { kind: 'system', type: 'TIMEOUT', seat: 1, phase: 'sbp' });
    expect(timed.ok).toBe(true);
    if (!timed.ok) return;
    expect(timed.value.state.turn.phase.at(-1)).toMatchObject({ id: 'sbp', data: { seat: 2 } });
    expect(
      engine.applyPrivate(engine.createPrivateState(1), state, {
        kind: 'system',
        type: 'TIMEOUT',
        seat: 1,
        phase: 'sbp',
      }).ok,
    ).toBe(true);
  });

  test('the option can disable the special build phase', () => {
    const game = start(5, { specialBuildPhase: false });
    endMainTurn(game);
    expect(game.state.turn.activeSeat).toBe(1);
    expect(game.state.turn.phase.at(-1)?.id).toBe('preRoll');
  });

  test('a seat reaching the target during a special build phase wins only on its own turn', () => {
    const game = start(5);
    endMainTurn(game);
    const state = game.snapshot();
    const target = {
      ...state,
      config: {
        ...state.config,
        options: {
          ...state.config.options,
          base: { ...Object(state.config.options.base), vpTarget: 3 },
        },
      },
    };
    const rich = withHand(target, 1, { ...zero, grain: 2, ore: 3 });
    const city = engine
      .getLegalCommands(rich, 1)
      .commands.find((item) => item.type === 'BUILD_CITY');
    if (!city) throw new Error('No city');
    const built = engine.apply(rich, { kind: 'command', seat: 1, command: city });
    if (!built.ok) throw new Error(built.error.message);
    expect(built.value.state.seats[1]?.publicVp).toBe(3);
    expect(built.value.state.result).toBeNull();
    let next = built.value.state;
    for (const seat of [1, 2, 3, 4] as const) {
      const ended = engine.apply(next, { kind: 'command', seat, command: { type: 'END_SBP' } });
      if (!ended.ok) throw new Error(ended.error.message);
      next = ended.value.state;
      expect(next.result === null).toBe(seat < 4);
    }
    expect(next.result).toMatchObject({ winner: 1, reason: 'public-vp' });
  });

  test('random five- and six-seat games finish with public and private invariants intact', () => {
    for (const seats of [5, 6])
      for (let index = 0; index < 3; index++) {
        const game = playRandom(engine, seats, 40 + index);
        expect(game.state.result).not.toBeNull();
      }
  });
});

/** A small random driver over the legal enumerator, used for smoke coverage only. */
function playRandom(rules: Engine, seats: number, value: number): LocalGame {
  const cfg = config(seats);
  const created = LocalGame.create(
    rules,
    cfg,
    seed(value),
    randomSource(value, FIVE_SIX_DEV_CARDS),
    {
      verifyInvariants: true,
    },
  );
  if (!created.ok) throw new Error(created.error.message);
  const game = created.value;
  const rng = createRng(seed(value + 7));
  for (let step = 0; step < 20_000 && !game.state.result; step++) {
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
    const legal = rules.getLegalCommands(game.snapshot(), chosen.seat, priv);
    let commands = legal.commands.filter(
      (command) => command.type !== 'CLAIM_VICTORY' && chosen.allowed.includes(command.type),
    );
    const builds = commands.filter(
      (command) =>
        command.type.startsWith('BUILD') ||
        command.type === 'PLACE_SETTLEMENT' ||
        command.type === 'PLACE_ROAD',
    );
    if (builds.length && rng.int(4) > 0) commands = builds;
    if (!commands.length && chosen.allowed.includes('DISCARD')) {
      const hand = { ...priv?.hand };
      let count = Math.floor(
        (game.state.seats.find((seat) => seat.seat === chosen.seat)?.resources.total ?? 0) / 2,
      );
      const cards: Record<string, number> = {};
      for (const kind of RESOURCES) {
        const take = Math.min(hand[kind] ?? 0, count);
        cards[kind] = take;
        count -= take;
      }
      commands = [{ type: 'DISCARD', cards }];
    }
    const command = commands[rng.int(commands.length)];
    if (!command)
      throw new Error(`No command for ${chosen.seat} in ${game.state.turn.phase.at(-1)?.id}`);
    const result = game.submit({ kind: 'command', seat: chosen.seat, command });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return game;
}
