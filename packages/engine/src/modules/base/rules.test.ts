import { describe, expect, test } from 'vitest';
import { createRegistry } from '../../core/modules/index.js';
import type { CommandInput, SystemInput } from '../../core/pipeline/index.js';
import { exactResourceBounds, gainHidden } from '../../core/resources/index.js';
import type { GameState, PrivateState } from '../../core/state/index.js';
import type { ResourceCounts, Seat } from '../../core/types/index.js';
import { baseModule, createBaseEngine } from './index.js';
import { frame } from './shared.js';
import { verticesForHex } from './board/index.js';
import { legalRoadEdges } from './placement/index.js';
import { productionPayments } from './production.js';
import { baseExt } from './types.js';

const engine = createBaseEngine();
const zero = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
const seed = new Uint8Array(32);

function genesis(options: Record<string, unknown> = {}): GameState {
  return engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2],
      options: { base: { mapLayout: 'random', ...options } },
    },
    seed,
  );
}

function main(state: GameState, turn = 3): GameState {
  return { ...state, turn: { ...state.turn, number: turn, activeSeat: 0, phase: [frame('main')] } };
}

function hand(state: GameState, seat: Seat, counts: ResourceCounts): GameState {
  const bounds = exactResourceBounds(counts);
  if (!bounds.ok) throw new Error(bounds.error.message);
  return {
    ...state,
    seats: state.seats.map((holder) =>
      holder.seat === seat ? { ...holder, resources: bounds.value } : holder,
    ),
  };
}

function command(state: GameState, seat: Seat, type: string, fields: Record<string, unknown> = {}) {
  const input: CommandInput = { kind: 'command', seat, command: { type, ...fields } };
  const result = engine.apply(state, input);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return { ...result.value, input };
}

function system(state: GameState, type: string, fields: Record<string, unknown> = {}) {
  const input: SystemInput = { kind: 'system', type, ...fields };
  const result = engine.apply(state, input);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return { ...result.value, input };
}

function maritimeValidation(current: GameState, give: unknown, get: unknown) {
  return engine.validate(current, {
    kind: 'command',
    seat: 0,
    command: { type: 'MARITIME_TRADE', give, get },
  });
}

describe('base rule handlers', () => {
  test('production pays a lone claimant the shortage and pays nobody on a shared shortage', () => {
    const initial = genesis();
    const producing = initial.board.hexes.find(
      (hex) => hex.token !== null && hex.terrain !== 'desert',
    );
    if (!producing?.token) throw new Error('No producing hex');
    const vertices = verticesForHex(initial, producing.id);
    const first = vertices[0];
    const second = vertices[1];
    if (!first || !second) throw new Error('Missing hex vertices');
    const context = { hooks: createRegistry([baseModule()]).hooks };
    const lone = {
      ...initial,
      bank: { ...initial.bank },
      board: { ...initial.board, buildings: [{ vertex: first, seat: 0 as const, kind: 'city' }] },
    };
    const kind =
      producing.terrain === 'hills'
        ? 'brick'
        : producing.terrain === 'forest'
          ? 'lumber'
          : producing.terrain === 'pasture'
            ? 'wool'
            : producing.terrain === 'fields'
              ? 'grain'
              : 'ore';
    lone.bank[kind] = 1;
    expect(productionPayments(lone, producing.token, context).get(0)?.[kind]).toBe(1);
    const shared = {
      ...lone,
      board: {
        ...lone.board,
        buildings: [
          ...lone.board.buildings,
          { vertex: second, seat: 1 as const, kind: 'settlement' },
        ],
      },
    };
    expect(productionPayments(shared, producing.token, context).get(0)?.[kind]).toBe(0);
    expect(productionPayments(shared, producing.token, context).get(1)?.[kind]).toBe(0);
    const blocked = { ...lone, board: { ...lone.board, robberHex: producing.id } };
    expect(productionPayments(blocked, producing.token, context).get(0)?.[kind]).toBe(0);
  });

  test('dice production event reports the actual bank-limited payment', () => {
    const initial = genesis();
    const hex = initial.board.hexes.find(
      (item) => item.token !== null && item.terrain !== 'desert',
    );
    if (!hex?.token) throw new Error('No producing hex');
    const [first, second] = verticesForHex(initial, hex.id);
    if (!first || !second) throw new Error('Missing producing vertices');
    const kind =
      hex.terrain === 'hills'
        ? 'brick'
        : hex.terrain === 'forest'
          ? 'lumber'
          : hex.terrain === 'pasture'
            ? 'wool'
            : hex.terrain === 'fields'
              ? 'grain'
              : 'ore';
    const dice: [number, number] = [Math.max(1, hex.token - 6), 0];
    dice[1] = hex.token - dice[0];
    const rolling = {
      ...initial,
      bank: { ...initial.bank, [kind]: 1 },
      turn: { ...initial.turn, phase: [frame('dice')] },
      board: { ...initial.board, buildings: [{ vertex: first, seat: 0 as const, kind: 'city' }] },
    };
    const lone = system(rolling, 'DICE_RESULT', { dice });
    expect(lone.events.find((event) => event.type === 'resourcesProduced')).toMatchObject({
      bySeat: { '0': { [kind]: 1 } },
    });
    const assertPayment = (before: GameState, result: typeof lone) => {
      const produced = result.events.find((event) => event.type === 'resourcesProduced');
      if (produced?.type !== 'resourcesProduced') throw new Error('Production event missing');
      const bySeat = Reflect.get(produced, 'bySeat');
      const payment = (seat: Seat): number => {
        if (typeof bySeat !== 'object' || bySeat === null) return 0;
        const counts = Reflect.get(bySeat, String(seat));
        if (typeof counts !== 'object' || counts === null) return 0;
        const value = Reflect.get(counts, kind);
        return typeof value === 'number' ? value : 0;
      };
      const paid = before.config.seats.reduce<number>((sum, seat) => sum + payment(seat), 0);
      expect(paid).toBe((before.bank[kind] ?? 0) - (result.state.bank[kind] ?? 0));
      for (const seat of before.config.seats) {
        const old = before.seats.find((item) => item.seat === seat);
        const next = result.state.seats.find((item) => item.seat === seat);
        if (!old || !next) throw new Error('Game seat missing');
        expect(payment(seat)).toBe(
          (next.resources.min[kind] ?? 0) - (old.resources.min[kind] ?? 0),
        );
      }
    };
    assertPayment(rolling, lone);
    const fullBank = { ...rolling, bank: { ...rolling.bank, [kind]: 19 } };
    const full = system(fullBank, 'DICE_RESULT', { dice });
    assertPayment(fullBank, full);
    expect(full.events.find((event) => event.type === 'resourcesProduced')).toMatchObject({
      bySeat: { '0': { [kind]: 2 } },
    });
    const sharedBank = {
      ...rolling,
      board: {
        ...rolling.board,
        buildings: [
          ...rolling.board.buildings,
          { vertex: second, seat: 1 as const, kind: 'settlement' },
        ],
      },
    };
    const shared = system(sharedBank, 'DICE_RESULT', { dice });
    assertPayment(sharedBank, shared);
    expect(shared.events.find((event) => event.type === 'resourcesProduced')).toEqual({
      type: 'resourcesProduced',
      bySeat: {},
    });
    const seven = system(rolling, 'DICE_RESULT', { dice: [3, 4] });
    expect(seven.events.some((event) => event.type === 'resourcesProduced')).toBe(false);
  });

  test('road and city builds pay costs and obey piece limits', () => {
    let state = main(genesis());
    const vertex = verticesForHex(state, state.board.hexes[0]?.id ?? '')[0];
    if (!vertex) throw new Error('No vertex');
    state = {
      ...state,
      board: { ...state.board, buildings: [{ vertex, seat: 0, kind: 'settlement' }] },
      seats: state.seats.map((holder) =>
        holder.seat === 0
          ? { ...holder, piecesLeft: { ...holder.piecesLeft, settlement: 4 } }
          : holder,
      ),
    };
    state = hand(state, 0, { brick: 1, lumber: 1, wool: 0, grain: 2, ore: 3 });
    const edge = legalRoadEdges(state, 0)[0];
    if (!edge) throw new Error('No road edge');
    const road = command(state, 0, 'BUILD_ROAD', { edge }).state;
    expect(road.board.roads).toContainEqual({ edge, seat: 0 });
    expect(road.seats[0]?.resources.total).toBe(5);
    const city = command(road, 0, 'BUILD_CITY', { vertex }).state;
    expect(city.board.buildings[0]?.kind).toBe('city');
    expect(city.seats[0]?.resources.total).toBe(0);
    expect(city.seats[0]?.piecesLeft.settlement).toBe(5);
    expect(
      engine.validate(city, { kind: 'command', seat: 0, command: { type: 'BUILD_CITY', vertex } }),
    ).toMatchObject({ ok: false, error: { code: 'illegal-city' } });
  });

  test('year of plenty takes only the requested resource the bank can supply', () => {
    let state = main(genesis());
    state = { ...state, bank: { ...state.bank, brick: 1 } };
    state = {
      ...state,
      seats: state.seats.map((seat) =>
        seat.seat === 0
          ? { ...seat, cardSlots: [{ slotId: 'dev:0', deck: 'dev', acquiredTurn: 2 }] }
          : seat,
      ),
    };
    const input: CommandInput = {
      kind: 'command',
      seat: 0,
      command: {
        type: 'PLAY_DEV_CARD',
        slotId: 'dev:0',
        card: 'yearOfPlenty',
        params: { resources: { brick: 2 } },
      },
    };
    const applied = engine.apply(state, input);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.state.seats[0]?.resources.min.brick).toBe(1);
    expect(applied.value.state.bank.brick).toBe(0);
    const priv: PrivateState = {
      ...engine.createPrivateState(0),
      slots: { 'dev:0': 'yearOfPlenty' },
    };
    expect(engine.applyPrivate(priv, state, input)).toMatchObject({
      ok: true,
      value: { hand: { brick: 1 } },
    });
  });

  test('development draw keeps its identity private and a knight interrupts the turn', () => {
    const state = hand(main(genesis()), 0, { ...zero, wool: 1, grain: 1, ore: 1 });
    const buy: CommandInput = { kind: 'command', seat: 0, command: { type: 'BUY_DEV_CARD' } };
    expect(engine.applyPrivate(engine.createPrivateState(0), state, buy)).toMatchObject({
      ok: false,
      error: { code: 'private-insufficient-resources' },
    });
    expect(
      engine.applyPrivate(
        { ...engine.createPrivateState(0), hand: { ...zero, wool: 1, grain: 1, ore: 1 } },
        state,
        buy,
      ),
    ).toMatchObject({ ok: true, value: { hand: zero } });
    expect(engine.applyPrivate(engine.createPrivateState(1), state, buy)).toMatchObject({
      ok: true,
    });
    expect(
      engine.validate(
        { ...state, decks: { ...state.decks, dev: { remaining: 0, drawn: [] } } },
        buy,
      ),
    ).toMatchObject({ ok: false, error: { code: 'empty-dev-deck' } });
    const bought = command(state, 0, 'BUY_DEV_CARD').state;
    expect(bought.turn.phase.at(-1)?.id).toBe('drawDev');
    expect(bought.seats[0]?.resources.total).toBe(0);
    const deal: SystemInput = {
      kind: 'system',
      type: 'CARD_DEALT',
      seat: 0,
      deck: 'dev',
      slotId: 'dev:0',
    };
    expect(engine.validate(bought, { ...deal, slotId: 'foreign' })).toMatchObject({
      ok: false,
      error: { code: 'deal-mismatch' },
    });
    expect(engine.validate(bought, { ...deal, card: 'dragon' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-dev-card' },
    });
    expect(
      engine.applyPrivate(
        engine.createPrivateState(0),
        bought,
        { ...deal, card: 'knight' },
        { card: 'monopoly' },
      ),
    ).toMatchObject({ ok: false, error: { code: 'card-identity-mismatch' } });
    expect(engine.applyPrivate(engine.createPrivateState(0), bought, deal)).toMatchObject({
      ok: false,
      error: { code: 'missing-private-card' },
    });
    const secret = engine.applyPrivate(engine.createPrivateState(0), bought, deal, {
      card: 'knight',
    });
    expect(secret).toMatchObject({ ok: true, value: { slots: { 'dev:0': 'knight' } } });
    const dealt = system(bought, 'CARD_DEALT', { seat: 0, deck: 'dev', slotId: 'dev:0' }).state;
    expect(dealt.seats[0]?.cardSlots[0]).toMatchObject({ slotId: 'dev:0', acquiredTurn: 3 });
    expect(dealt.seats[0]?.cardSlots[0]).not.toHaveProperty('revealed');
    expect(
      engine.validate(dealt, {
        kind: 'command',
        seat: 0,
        command: { type: 'PLAY_DEV_CARD', slotId: 'dev:0', card: 'knight' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'new-dev-card' } });
    const nextTurn = main(dealt, 4);
    const played = command(nextTurn, 0, 'PLAY_DEV_CARD', { slotId: 'dev:0', card: 'knight' }).state;
    expect(played.turn.phase.at(-1)?.id).toBe('moveRobber');
    expect(baseExt(played.ext.base).knightsPlayed[0]).toBe(1);
    expect(
      engine.validate(played, {
        kind: 'command',
        seat: 0,
        command: { type: 'PLAY_DEV_CARD', slotId: 'dev:0', card: 'knight' },
      }),
    ).toMatchObject({ ok: false });
  });

  test('road building places free roads and can stop without spending resources', () => {
    let state = main(genesis());
    const vertex = verticesForHex(state, state.board.hexes[0]?.id ?? '')[0];
    if (!vertex) throw new Error('No vertex');
    state = {
      ...state,
      board: { ...state.board, buildings: [{ vertex, seat: 0, kind: 'settlement' }] },
      seats: state.seats.map((holder) =>
        holder.seat === 0
          ? { ...holder, cardSlots: [{ slotId: 'dev:0', deck: 'dev', acquiredTurn: 2 }] }
          : holder,
      ),
    };
    const played = command(state, 0, 'PLAY_DEV_CARD', {
      slotId: 'dev:0',
      card: 'roadBuilding',
    }).state;
    expect(played.turn.phase.at(-1)?.id).toBe('roadBuilding');
    const choice = engine
      .getLegalCommands(played, 0)
      .commands.find((item) => item.type === 'PLACE_FREE_ROAD');
    if (!choice || typeof choice.edge !== 'string') throw new Error('No free road choice');
    const placed = command(played, 0, 'PLACE_FREE_ROAD', { edge: choice.edge }).state;
    expect(placed.board.roads).toContainEqual({ edge: choice.edge, seat: 0 });
    expect(placed.seats[0]?.resources.total).toBe(0);
    const skipped = command(placed, 0, 'SKIP').state;
    expect(skipped.turn.phase.at(-1)?.id).toBe('main');
  });

  test('development play rejects invalid cards, slots and parameters', () => {
    const initial = main(genesis());
    const state = {
      ...initial,
      seats: initial.seats.map((holder) =>
        holder.seat === 0
          ? { ...holder, cardSlots: [{ slotId: 'dev:0', deck: 'dev', acquiredTurn: 2 }] }
          : holder,
      ),
    };
    const check = (slotId: string, card: string, params?: unknown) =>
      engine.validate(state, {
        kind: 'command',
        seat: 0,
        command: {
          type: 'PLAY_DEV_CARD',
          slotId,
          card,
          ...(params === undefined ? {} : { params }),
        },
      });
    expect(check('dev:0', 'victoryPoint')).toMatchObject({
      ok: false,
      error: { code: 'invalid-dev-card' },
    });
    expect(check('dev:0', 'not-a-card')).toMatchObject({
      ok: false,
      error: { code: 'invalid-dev-card' },
    });
    expect(check('foreign', 'knight')).toMatchObject({
      ok: false,
      error: { code: 'invalid-dev-slot' },
    });
    expect(check('dev:0', 'yearOfPlenty', { resources: { brick: 1 } })).toMatchObject({
      ok: false,
      error: { code: 'invalid-plenty-count' },
    });
    expect(check('dev:0', 'monopoly', { resource: 'gold' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-dev-params' },
    });
    expect(check('dev:0', 'roadBuilding').ok).toBe(true);
  });

  test('monopoly reveal makes the victim resource count exactly zero', () => {
    let state = main(genesis());
    const empty = exactResourceBounds(zero);
    if (!empty.ok) throw new Error(empty.error.message);
    const unknown = gainHidden(empty.value, 2);
    if (!unknown.ok) throw new Error(unknown.error.message);
    state = {
      ...state,
      seats: state.seats.map((seat) =>
        seat.seat === 0
          ? { ...seat, cardSlots: [{ slotId: 'dev:0', deck: 'dev', acquiredTurn: 2 }] }
          : seat.seat === 1
            ? { ...seat, resources: unknown.value }
            : seat,
      ),
    };
    const played = command(state, 0, 'PLAY_DEV_CARD', {
      slotId: 'dev:0',
      card: 'monopoly',
      params: { resource: 'brick' },
    }).state;
    expect(played.turn.phase.at(-1)?.id).toBe('monopoly');
    expect(
      engine.validate(played, {
        kind: 'system',
        type: 'REVEAL_COUNT',
        seat: 1,
        resource: 'ore',
        count: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: 'reveal-mismatch' } });
    expect(
      engine.validate(played, {
        kind: 'system',
        type: 'REVEAL_COUNT',
        seat: 1,
        resource: 'brick',
        count: -1,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-reveal-count' } });
    expect(
      engine.validate(played, {
        kind: 'system',
        type: 'REVEAL_COUNT',
        seat: 1,
        resource: 'brick',
        count: 3,
      }),
    ).toMatchObject({ ok: false, error: { code: 'reveal-out-of-bounds' } });
    const reveal: SystemInput = {
      kind: 'system',
      type: 'REVEAL_COUNT',
      seat: 1,
      resource: 'brick',
      count: 2,
    };
    expect(
      engine.applyPrivate(
        { ...engine.createPrivateState(1), hand: { ...zero, brick: 1 } },
        played,
        reveal,
      ),
    ).toMatchObject({ ok: false, error: { code: 'private-reveal-mismatch' } });
    expect(
      engine.applyPrivate(
        { ...engine.createPrivateState(1), hand: { ...zero, brick: 2 } },
        played,
        reveal,
      ),
    ).toMatchObject({ ok: true, value: { hand: { brick: 0 } } });
    expect(engine.applyPrivate(engine.createPrivateState(0), played, reveal)).toMatchObject({
      ok: true,
      value: { hand: { brick: 2 } },
    });
    const revealed = system(played, 'REVEAL_COUNT', { seat: 1, resource: 'brick', count: 2 }).state;
    expect(revealed.seats[1]?.resources.max.brick).toBe(0);
    expect(revealed.seats[0]?.resources.min.brick).toBe(2);
  });

  test('hidden steal bounds reject proven overspending and private audit catches plausible overspending', () => {
    let before = genesis();
    const vertex = verticesForHex(before, before.board.hexes[0]?.id ?? '')[0];
    if (!vertex) throw new Error('No vertex');
    before = hand(before, 0, { ...zero, lumber: 1 });
    before = hand(before, 1, { ...zero, ore: 1 });
    before = {
      ...before,
      bank: { ...before.bank, lumber: 18, ore: 18 },
      board: { ...before.board, buildings: [{ vertex, seat: 0, kind: 'settlement' }] },
      seats: before.seats.map((holder) =>
        holder.seat === 0
          ? { ...holder, piecesLeft: { ...holder.piecesLeft, settlement: 4 } }
          : holder,
      ),
      turn: {
        ...before.turn,
        number: 3,
        activeSeat: 0,
        phase: [frame('stealResult', { thief: 0, victim: 1, returnTo: 'main' })],
      },
    };
    const reveal: SystemInput = {
      kind: 'system',
      type: 'STEAL_RESULT',
      thief: 0,
      victim: 1,
      resource: 'hidden',
    };
    const thiefBefore = { ...engine.createPrivateState(0), hand: { ...zero, lumber: 1 } };
    const victimBefore = { ...engine.createPrivateState(1), hand: { ...zero, ore: 1 } };
    const thiefAfter = engine.applyPrivate(thiefBefore, before, reveal, { resource: 'ore' });
    const victimAfter = engine.applyPrivate(victimBefore, before, reveal, { resource: 'ore' });
    if (!thiefAfter.ok || !victimAfter.ok) throw new Error('Private steal failed');
    const hidden = system(before, 'STEAL_RESULT', {
      thief: 0,
      victim: 1,
      resource: 'hidden',
    }).state;
    expect(hidden.seats[0]?.resources.total).toBe(2);
    expect(
      engine.validate(hidden, {
        kind: 'command',
        seat: 0,
        command: { type: 'OFFER_TRADE', give: { brick: 4 }, want: { ore: 1 }, to: [1] },
      }),
    ).toMatchObject({ ok: false, error: { code: 'insufficient-resources' } });
    const edge = legalRoadEdges(hidden, 0)[0];
    if (!edge) throw new Error('No road edge');
    const spend: CommandInput = { kind: 'command', seat: 0, command: { type: 'BUILD_ROAD', edge } };
    expect(engine.validate(hidden, spend).ok).toBe(true);
    expect(engine.applyPrivate(thiefAfter.value, hidden, spend)).toMatchObject({
      ok: false,
      error: { code: 'private-insufficient-resources' },
    });
    const publicSpend = engine.apply(hidden, spend);
    if (!publicSpend.ok) throw new Error(publicSpend.error.message);
    expect(
      engine.checkPrivateInvariants(
        publicSpend.value.state,
        new Map([
          [0, thiefAfter.value],
          [1, victimAfter.value],
          [2, engine.createPrivateState(2)],
        ]),
      ),
    ).toContain('brick bank and private hands total 20, expected 19');
  });

  test('player and maritime trades recheck hands and transfer exact resources', () => {
    let state = hand(main(genesis()), 0, { ...zero, brick: 4 });
    state = hand(state, 1, { ...zero, ore: 1 });
    const offered = command(state, 0, 'OFFER_TRADE', {
      give: { brick: 1 },
      want: { ore: 1 },
      to: [1],
    }).state;
    expect(
      engine.validate(offered, {
        kind: 'command',
        seat: 0,
        command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'unaccepted-offer' } });
    const accepted = command(offered, 1, 'RESPOND_TRADE', { offerId: 0, accept: true }).state;
    const confirmed = command(accepted, 0, 'CONFIRM_TRADE', { offerId: 0, withSeat: 1 }).state;
    expect(confirmed.seats[0]?.resources.min).toMatchObject({ brick: 3, ore: 1 });
    expect(confirmed.seats[1]?.resources.min).toMatchObject({ brick: 1, ore: 0 });
    const bankTrade = command(
      hand(main(genesis()), 0, { ...zero, brick: 4 }),
      0,
      'MARITIME_TRADE',
      { give: { brick: 4 }, get: { ore: 1 } },
    ).state;
    expect(bankTrade.seats[0]?.resources.min).toMatchObject({ brick: 0, ore: 1 });
  });

  test('private trade confirmation debits both parties and leaves bystanders unchanged', () => {
    let state = hand(main(genesis()), 0, { ...zero, brick: 1 });
    state = hand(state, 1, { ...zero, ore: 1 });
    const offered = command(state, 0, 'OFFER_TRADE', {
      give: { brick: 1 },
      want: { ore: 1 },
      to: [1],
    }).state;
    const accepted = command(offered, 1, 'RESPOND_TRADE', { offerId: 0, accept: true }).state;
    const confirm: CommandInput = {
      kind: 'command',
      seat: 0,
      command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
    };
    const proposer = { ...engine.createPrivateState(0), hand: { ...zero, brick: 1 } };
    const recipient = { ...engine.createPrivateState(1), hand: { ...zero, ore: 1 } };
    const bystander = engine.createPrivateState(2);
    expect(engine.applyPrivate(proposer, accepted, confirm)).toMatchObject({
      ok: true,
      value: { hand: { brick: 0, ore: 1 } },
    });
    expect(engine.applyPrivate(recipient, accepted, confirm)).toMatchObject({
      ok: true,
      value: { hand: { brick: 1, ore: 0 } },
    });
    expect(engine.applyPrivate(bystander, accepted, confirm)).toMatchObject({
      ok: true,
      value: bystander,
    });
    expect(engine.applyPrivate(engine.createPrivateState(0), accepted, confirm)).toMatchObject({
      ok: false,
      error: { code: 'private-insufficient-resources' },
    });

    const counter = command(state, 1, 'PROPOSE_TRADE', {
      give: { ore: 1 },
      want: { brick: 1 },
    }).state;
    const counterConfirm: CommandInput = {
      kind: 'command',
      seat: 0,
      command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
    };
    expect(engine.applyPrivate(proposer, counter, counterConfirm)).toMatchObject({
      ok: true,
      value: { hand: { brick: 0, ore: 1 } },
    });
    expect(engine.applyPrivate(recipient, counter, counterConfirm)).toMatchObject({
      ok: true,
      value: { hand: { brick: 1, ore: 0 } },
    });
  });

  test('counter-offer can be confirmed directly and invalid offers remain visible', () => {
    let state = hand(main(genesis()), 0, { ...zero, ore: 1 });
    state = hand(state, 1, { ...zero, brick: 1 });
    const proposed = command(state, 1, 'PROPOSE_TRADE', {
      give: { brick: 1 },
      want: { ore: 1 },
    }).state;
    expect(baseExt(proposed.ext.base).offers[0]).toMatchObject({
      proposer: 1,
      to: [0],
      valid: true,
    });
    const confirmed = command(proposed, 0, 'CONFIRM_TRADE', { offerId: 0, withSeat: 1 }).state;
    expect(confirmed.seats[0]?.resources.min).toMatchObject({ brick: 1, ore: 0 });
    expect(confirmed.seats[1]?.resources.min).toMatchObject({ brick: 0, ore: 1 });
    expect(baseExt(confirmed.ext.base).offers).toHaveLength(0);

    const offered = command(state, 0, 'OFFER_TRADE', {
      give: { ore: 1 },
      want: { brick: 1 },
      to: [1],
    }).state;
    const drained = hand(offered, 0, zero);
    const marked = command(drained, 1, 'RESPOND_TRADE', { offerId: 0, accept: true }).state;
    expect(baseExt(marked.ext.base).offers[0]).toMatchObject({ valid: false, acceptedBy: [1] });
    expect(
      engine.validate(marked, {
        kind: 'command',
        seat: 0,
        command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-offer' } });
  });

  test('a new offer replaces the proposer previous offer and resets consent', () => {
    let state = hand(main(genesis()), 0, { ...zero, brick: 2 });
    state = command(state, 0, 'OFFER_TRADE', {
      give: { brick: 1 },
      want: { ore: 1 },
      to: [1],
    }).state;
    state = command(state, 1, 'RESPOND_TRADE', { offerId: 0, accept: true }).state;
    expect(baseExt(state.ext.base).offers[0]?.acceptedBy).toEqual([1]);
    state = command(state, 0, 'OFFER_TRADE', {
      give: { brick: 2 },
      want: { wool: 1 },
      to: [1],
    }).state;
    expect(baseExt(state.ext.base).offers).toMatchObject([
      { id: 1, proposer: 0, acceptedBy: [], declinedBy: [] },
    ]);
    expect(
      engine.validate(state, {
        kind: 'command',
        seat: 0,
        command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
      }),
    ).toMatchObject({ ok: false });
    const counterState = hand(main(genesis()), 1, { ...zero, ore: 2 });
    const firstCounter = command(counterState, 1, 'PROPOSE_TRADE', {
      give: { ore: 1 },
      want: { brick: 1 },
    }).state;
    const secondCounter = command(firstCounter, 1, 'PROPOSE_TRADE', {
      give: { ore: 2 },
      want: { wool: 1 },
    }).state;
    expect(baseExt(secondCounter.ext.base).offers).toMatchObject([
      { id: 1, proposer: 1, acceptedBy: [] },
    ]);
  });

  test('non-active seat can cancel its proposal or withdraw consent, but not another offer', () => {
    let state = hand(main(genesis()), 0, { ...zero, brick: 1 });
    state = hand(state, 1, { ...zero, ore: 1 });
    const proposal = command(state, 1, 'PROPOSE_TRADE', {
      give: { ore: 1 },
      want: { brick: 1 },
    }).state;
    expect(
      engine.validate(proposal, {
        kind: 'command',
        seat: 2,
        command: { type: 'CANCEL_TRADE', offerId: 0 },
      }),
    ).toMatchObject({ ok: false });
    const cancelled = command(proposal, 1, 'CANCEL_TRADE', { offerId: 0 });
    expect(baseExt(cancelled.state.ext.base).offers).toEqual([]);
    expect(cancelled.events).toContainEqual({ type: 'tradeCancelled', offerId: 0, seat: 1 });

    const offered = command(state, 0, 'OFFER_TRADE', {
      give: { brick: 1 },
      want: { ore: 1 },
      to: [1],
    }).state;
    const accepted = command(offered, 1, 'RESPOND_TRADE', { offerId: 0, accept: true }).state;
    const withdrawal = command(accepted, 1, 'CANCEL_TRADE', { offerId: 0 });
    const withdrawn = withdrawal.state;
    expect(withdrawal.events).toContainEqual({
      type: 'tradeAcceptanceWithdrawn',
      offerId: 0,
      seat: 1,
    });
    expect(baseExt(withdrawn.ext.base).offers[0]).toMatchObject({
      acceptedBy: [],
      declinedBy: [1],
    });
    expect(
      engine.validate(withdrawn, {
        kind: 'command',
        seat: 0,
        command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
      }),
    ).toMatchObject({ ok: false });
  });

  test('trade validation rejects malformed sides, recipients and unaffordable offers', () => {
    const state = hand(main(genesis()), 0, { ...zero, brick: 1 });
    const offer = (give: unknown, want: unknown, to: unknown = [1]) =>
      engine.validate(state, {
        kind: 'command',
        seat: 0,
        command: { type: 'OFFER_TRADE', give, want, to },
      });
    expect(offer({}, { ore: 1 })).toMatchObject({ ok: false, error: { code: 'empty-trade-side' } });
    expect(offer({ brick: 1 }, { brick: 1 })).toMatchObject({
      ok: false,
      error: { code: 'overlapping-trade' },
    });
    expect(offer({ gold: 1 }, { ore: 1 })).toMatchObject({
      ok: false,
      error: { code: 'invalid-resource' },
    });
    expect(offer({ brick: 1 }, { ore: 1 }, [0])).toMatchObject({
      ok: false,
      error: { code: 'invalid-recipients' },
    });
    expect(offer({ brick: 2 }, { ore: 1 })).toMatchObject({
      ok: false,
      error: { code: 'insufficient-resources' },
    });
    expect(
      engine.validate(state, {
        kind: 'command',
        seat: 0,
        command: { type: 'PROPOSE_TRADE', give: { brick: 1 }, want: { ore: 1 } },
      }),
    ).toMatchObject({ ok: false, error: { code: 'not-pending' } });
  });

  test('maritime trades enforce harbor rate, output count and bank stock', () => {
    const state = hand(main(genesis()), 0, { ...zero, brick: 4 });
    expect(maritimeValidation(state, { brick: 3 }, { ore: 1 })).toMatchObject({
      ok: false,
      error: { code: 'invalid-maritime-rate' },
    });
    expect(maritimeValidation(state, { brick: 4 }, { ore: 2 })).toMatchObject({
      ok: false,
      error: { code: 'invalid-maritime-output' },
    });
    expect(maritimeValidation(state, { brick: 4 }, { brick: 1 })).toMatchObject({
      ok: false,
      error: { code: 'overlapping-trade' },
    });
    expect(
      maritimeValidation({ ...state, bank: { ...state.bank, ore: 0 } }, { brick: 4 }, { ore: 1 }),
    ).toMatchObject({ ok: false, error: { code: 'bank-shortage' } });
  });

  test('concrete legal actions pass validation and use the supplied private hand', () => {
    let state = main(genesis());
    const vertex = verticesForHex(state, state.board.hexes[0]?.id ?? '')[0];
    if (!vertex) throw new Error('No vertex');
    const empty = exactResourceBounds(zero);
    if (!empty.ok) throw new Error(empty.error.message);
    const uncertain = gainHidden(empty.value, 10);
    if (!uncertain.ok) throw new Error(uncertain.error.message);
    state = {
      ...state,
      board: { ...state.board, buildings: [{ vertex, seat: 0, kind: 'settlement' }] },
      seats: state.seats.map((holder) =>
        holder.seat === 0 ? { ...holder, resources: uncertain.value } : holder,
      ),
    };
    const publicChoices = engine.getLegalCommands(state, 0);
    expect(publicChoices.commands.some((choice) => choice.type === 'BUILD_ROAD')).toBe(true);
    const privateChoices = engine.getLegalCommands(state, 0, engine.createPrivateState(0));
    expect(privateChoices.commands.some((choice) => choice.type === 'BUILD_ROAD')).toBe(false);
    for (const choice of privateChoices.commands)
      expect(engine.validate(state, { kind: 'command', seat: 0, command: choice }).ok).toBe(true);

    const tradable = hand(state, 1, { ...zero, ore: 1 });
    const offered = command(tradable, 0, 'OFFER_TRADE', {
      give: { brick: 1 },
      want: { ore: 1 },
      to: [1],
    }).state;
    const accepted = command(offered, 1, 'RESPOND_TRADE', { offerId: 0, accept: true }).state;
    expect(engine.getLegalCommands(accepted, 0).commands).toContainEqual({
      type: 'CONFIRM_TRADE',
      offerId: 0,
      withSeat: 1,
    });
    expect(
      engine
        .getLegalCommands(accepted, 0, engine.createPrivateState(0))
        .commands.some((choice) => choice.type === 'CONFIRM_TRADE'),
    ).toBe(false);
    const recipientEmpty = {
      ...accepted,
      seats: accepted.seats.map((holder) =>
        holder.seat === 1 ? { ...holder, resources: empty.value } : holder,
      ),
    };
    expect(
      engine
        .getLegalCommands(recipientEmpty, 0)
        .commands.some((choice) => choice.type === 'CONFIRM_TRADE'),
    ).toBe(false);
  });

  test('hidden victory claim reveals only sufficient owned slots and ends the turn', () => {
    let state = main(genesis({ vpTarget: 3 }));
    const first = verticesForHex(state, state.board.hexes[0]?.id ?? '')[0];
    const second = verticesForHex(state, state.board.hexes.at(-1)?.id ?? '')[0];
    if (!first || !second) throw new Error('No vertices');
    state = {
      ...state,
      board: {
        ...state.board,
        buildings: [
          { vertex: first, seat: 0, kind: 'settlement' },
          { vertex: second, seat: 0, kind: 'settlement' },
        ],
      },
      seats: state.seats.map((seat) =>
        seat.seat === 0
          ? { ...seat, publicVp: 2, cardSlots: [{ slotId: 'dev:0', deck: 'dev', acquiredTurn: 2 }] }
          : seat,
      ),
    };
    const input: CommandInput = {
      kind: 'command',
      seat: 0,
      command: { type: 'CLAIM_VICTORY', slotIds: ['dev:0'] },
    };
    const priv: PrivateState = {
      ...engine.createPrivateState(0),
      slots: { 'dev:0': 'victoryPoint' },
    };
    expect(engine.applyPrivate(priv, state, input).ok).toBe(true);
    const claimed = engine.apply(state, input);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.value.state.result?.reason).toBe('claimed-vp');
    expect(claimed.value.events.filter((event) => event.type === 'gameEnded')).toHaveLength(1);
    expect(engine.apply(claimed.value.state, input)).toMatchObject({
      ok: false,
      error: { code: 'game-over' },
    });
  });

  test('victory claims reject foreign, duplicate and false private cards', () => {
    let state = main(genesis({ vpTarget: 3 }));
    state = {
      ...state,
      seats: state.seats.map((holder) =>
        holder.seat === 0
          ? {
              ...holder,
              publicVp: 2,
              cardSlots: [{ slotId: 'dev:0', deck: 'dev', acquiredTurn: 2 }],
            }
          : holder,
      ),
    };
    const claim: CommandInput = {
      kind: 'command',
      seat: 0,
      command: { type: 'CLAIM_VICTORY', slotIds: ['dev:0'] },
    };
    const priv: PrivateState = {
      ...engine.createPrivateState(0),
      slots: { 'dev:0': 'victoryPoint' },
    };
    expect(engine.computeVictoryPoints(state, 0, priv)).toEqual({ public: 2, total: 3 });
    expect(engine.getAutomaticInput(state, new Map([[0, priv]]))).toEqual(claim);
    expect(
      engine.validate(state, {
        ...claim,
        command: { type: 'CLAIM_VICTORY', slotIds: ['dev:0', 'dev:0'] },
      }),
    ).toMatchObject({ ok: false, error: { code: 'duplicate-victory-slot' } });
    expect(
      engine.validate(state, {
        ...claim,
        command: { type: 'CLAIM_VICTORY', slotIds: ['foreign'] },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-victory-slot' } });
    expect(
      engine.applyPrivate(
        { ...engine.createPrivateState(0), slots: { 'dev:0': 'knight' } },
        state,
        claim,
      ),
    ).toMatchObject({ ok: false, error: { code: 'private-victory-mismatch' } });
    const insufficient = {
      ...state,
      seats: state.seats.map((holder) => (holder.seat === 0 ? { ...holder, publicVp: 1 } : holder)),
    };
    expect(engine.validate(insufficient, claim)).toMatchObject({
      ok: false,
      error: { code: 'insufficient-victory-points' },
    });
  });

  test('balanced dice consume indexed combinations and reset at six remaining', () => {
    const initial = main(genesis({ diceMode: 'balanced' }));
    const waiting = { ...initial, turn: { ...initial.turn, phase: [frame('preRoll')] } };
    const rolled = command(waiting, 0, 'ROLL_DICE').state;
    const answer = system(rolled, 'DICE_RESULT', { dice: [1, 1], index: 0 }).state;
    expect(baseExt(answer.ext.base).diceDeck).toHaveLength(35);
    const reduced = {
      ...waiting,
      ext: { ...waiting.ext, base: { ...baseExt(waiting.ext.base), diceDeck: [0, 1, 2, 3, 4, 5] } },
    };
    expect(baseExt(command(reduced, 0, 'ROLL_DICE').state.ext.base).diceDeck).toHaveLength(36);
  });
});
