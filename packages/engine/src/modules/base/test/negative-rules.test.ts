import { describe, expect, test } from 'vitest';
import { exactResourceBounds } from '../../../core/resources/index.js';
import type { GameState } from '../../../core/state/types.js';
import { RESOURCES } from '../../../core/types/index.js';
import type { ResourceCounts, Seat } from '../../../core/types/index.js';
import { baseModule, createBaseEngine } from '../index.js';
import { edgesForVertex, hexesForVertex, verticesForHex } from '../board/index.js';
import { TERRAIN_RESOURCE } from '../constants.js';
import { legalSettlementVertices } from '../placement/index.js';
import { frame } from '../shared.js';

const engine = createBaseEngine();
const zero = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
const version = baseModule().version;
function genesis(seats: Seat[] = [0, 1, 2]): GameState {
  return engine.createGame(
    { modules: [{ id: 'base', version }], seats, options: { base: {} } },
    new Uint8Array(32),
  );
}
function main(state: GameState): GameState {
  return { ...state, turn: { ...state.turn, number: 1, activeSeat: 0, phase: [frame('main')] } };
}
function withHand(state: GameState, seat: Seat, counts: ResourceCounts): GameState {
  const bounds = exactResourceBounds(counts);
  if (!bounds.ok) throw new Error(bounds.error.message);
  return {
    ...state,
    seats: state.seats.map((holder) =>
      holder.seat === seat ? { ...holder, resources: bounds.value } : holder,
    ),
  };
}
function withBuilding(state: GameState, vertex: string): GameState {
  return {
    ...state,
    board: { ...state.board, buildings: [{ vertex, seat: 0, kind: 'settlement' }] },
    seats: state.seats.map((seat) =>
      seat.seat === 0 ? { ...seat, piecesLeft: { ...seat.piecesLeft, settlement: 4 } } : seat,
    ),
  };
}
function check(state: GameState, seat: Seat, type: string, fields: Record<string, unknown> = {}) {
  return engine.validate(state, { kind: 'command', seat, command: { type, ...fields } });
}
function apply(
  state: GameState,
  seat: Seat,
  type: string,
  fields: Record<string, unknown> = {},
): GameState {
  const result = engine.apply(state, { kind: 'command', seat, command: { type, ...fields } });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value.state;
}

describe('base setup and build rejection', () => {
  test('rejects commands from the wrong seat or phase and unknown start seat', () => {
    const initial = genesis();
    expect(engine.validate(initial, { kind: 'system', type: 'START_SEAT', seat: 5 })).toMatchObject(
      {
        ok: false,
        error: { code: 'invalid-start-seat' },
      },
    );
    const started = engine.apply(initial, { kind: 'system', type: 'START_SEAT', seat: 0 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(check(started.value.state, 1, 'PLACE_SETTLEMENT', { vertex: 'v:0,0,N' })).toMatchObject({
      ok: false,
      error: { code: 'not-pending' },
    });
    expect(check(started.value.state, 0, 'PLACE_ROAD', { edge: 'e:0,0,W' })).toMatchObject({
      ok: false,
      error: { code: 'not-pending' },
    });
    expect(
      check(
        {
          ...started.value.state,
          turn: { ...started.value.state.turn, phase: [frame('preRoll')] },
        },
        0,
        'BUILD_ROAD',
        { edge: 'e:0,0,W' },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'not-pending' },
    });
  });

  test('road build rejects bad location, no pieces, and an unaffordable legal edge', () => {
    const initial = main(genesis());
    const vertex = verticesForHex(initial, initial.board.hexes[0]?.id ?? '')[0];
    if (!vertex) throw new Error('No board vertex');
    const state = withBuilding(initial, vertex);
    const edge = edgesForVertex(state, vertex)[0];
    if (!edge) throw new Error('No adjacent edge');
    expect(check(state, 0, 'BUILD_ROAD', { edge: 'toString' })).toMatchObject({
      ok: false,
      error: { code: 'illegal-road' },
    });
    expect(check(state, 0, 'BUILD_ROAD', { edge })).toMatchObject({
      ok: false,
      error: { code: 'insufficient-resources' },
    });
    const supplied = withHand(state, 0, { ...zero, brick: 1, lumber: 1 });
    const emptySupply = {
      ...supplied,
      seats: supplied.seats.map((seat) =>
        seat.seat === 0 ? { ...seat, piecesLeft: { ...seat.piecesLeft, road: 0 } } : seat,
      ),
    };
    expect(check(emptySupply, 0, 'BUILD_ROAD', { edge })).toMatchObject({
      ok: false,
      error: { code: 'no-roads' },
    });
    expect(check(supplied, 0, 'BUILD_ROAD', { edge: 7 })).toMatchObject({
      ok: false,
      error: { code: 'invalid-edge' },
    });
  });

  test('settlement and city reject illegal locations, exhausted pieces, and missing costs', () => {
    const initial = main(genesis());
    const vertex = 'v:0,0,N';
    const edge = edgesForVertex(initial, vertex)[0];
    if (!edge) throw new Error('No edge');
    const withRoad = {
      ...initial,
      board: { ...initial.board, roads: [{ edge, seat: 0 as const }] },
      seats: initial.seats.map((seat) =>
        seat.seat === 0 ? { ...seat, piecesLeft: { ...seat.piecesLeft, road: 14 } } : seat,
      ),
    };
    const legal = legalSettlementVertices(withRoad, 0)[0];
    if (!legal) throw new Error('No legal settlement');
    expect(check(withRoad, 0, 'BUILD_SETTLEMENT', { vertex: 'constructor' })).toMatchObject({
      ok: false,
      error: { code: 'illegal-settlement' },
    });
    expect(check(withRoad, 0, 'BUILD_SETTLEMENT', { vertex: legal })).toMatchObject({
      ok: false,
      error: { code: 'insufficient-resources' },
    });
    const supplied = withHand(withRoad, 0, { brick: 1, lumber: 1, wool: 1, grain: 1, ore: 0 });
    const noSettlements = {
      ...supplied,
      seats: supplied.seats.map((seat) =>
        seat.seat === 0 ? { ...seat, piecesLeft: { ...seat.piecesLeft, settlement: 0 } } : seat,
      ),
    };
    expect(check(noSettlements, 0, 'BUILD_SETTLEMENT', { vertex: legal })).toMatchObject({
      ok: false,
      error: { code: 'no-settlements' },
    });
    expect(check(withRoad, 0, 'BUILD_CITY', { vertex: legal })).toMatchObject({
      ok: false,
      error: { code: 'illegal-city' },
    });
    const settlement = withBuilding(withRoad, legal);
    expect(check(settlement, 0, 'BUILD_CITY', { vertex: legal })).toMatchObject({
      ok: false,
      error: { code: 'insufficient-resources' },
    });
    const cityReady = withHand(settlement, 0, { ...zero, grain: 2, ore: 3 });
    const noCities = {
      ...cityReady,
      seats: cityReady.seats.map((seat) =>
        seat.seat === 0 ? { ...seat, piecesLeft: { ...seat.piecesLeft, city: 0 } } : seat,
      ),
    };
    expect(check(noCities, 0, 'BUILD_CITY', { vertex: legal })).toMatchObject({
      ok: false,
      error: { code: 'no-cities' },
    });
  });

  test('setup snakes from chosen start seat and grants second-settlement resources before its road', () => {
    let state = genesis();
    const started = engine.apply(state, { kind: 'system', type: 'START_SEAT', seat: 1 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    state = started.value.state;
    const expectedOrder: Seat[] = [1, 2, 0, 0, 2, 1];
    for (let index = 0; index < expectedOrder.length; index++) {
      const seat = expectedOrder[index];
      if (seat === undefined) throw new Error('Missing setup seat');
      expect(state.turn.activeSeat).toBe(seat);
      const choices = engine
        .getLegalCommands(state, seat)
        .commands.filter((item) => item.type === 'PLACE_SETTLEMENT');
      const chosen =
        choices.find(
          (choice) =>
            typeof choice.vertex === 'string' &&
            hexesForVertex(state, choice.vertex).some((id) =>
              state.board.hexes.some((hex) => hex.id === id && hex.terrain !== 'desert'),
            ),
        ) ?? choices[0];
      const vertex = chosen?.vertex;
      if (typeof vertex !== 'string') throw new Error('No setup settlement');
      const before = state.seats[seat]?.resources.total ?? 0;
      const adjacent = new Set(hexesForVertex(state, vertex));
      const expected = RESOURCES.map(
        (resource) =>
          [
            resource,
            index < 3
              ? 0
              : state.board.hexes.filter(
                  (hex) => adjacent.has(hex.id) && TERRAIN_RESOURCE[hex.terrain] === resource,
                ).length,
          ] as const,
      );
      const priorCounts = state.seats[seat]?.resources.min;
      const input = {
        kind: 'command' as const,
        seat,
        command: { type: 'PLACE_SETTLEMENT', vertex },
      };
      const privateResult = engine.applyPrivate(engine.createPrivateState(seat), state, input);
      expect(privateResult.ok).toBe(true);
      if (!privateResult.ok) throw new Error(privateResult.error.message);
      state = apply(state, seat, 'PLACE_SETTLEMENT', { vertex });
      const after = state.seats[seat]?.resources.total ?? 0;
      expect(after > before).toBe(index >= 3);
      for (const [resource, amount] of expected) {
        expect(
          (state.seats[seat]?.resources.min[resource] ?? 0) - (priorCounts?.[resource] ?? 0),
        ).toBe(amount);
        expect(privateResult.value.hand[resource]).toBe(amount);
      }
      const road = engine
        .getLegalCommands(state, seat)
        .commands.find((item) => item.type === 'PLACE_ROAD');
      const edge = road?.edge;
      if (typeof edge !== 'string') throw new Error('No setup road');
      state = apply(state, seat, 'PLACE_ROAD', { edge });
    }
    expect(state.turn.activeSeat).toBe(1);
    expect(state.turn.number).toBe(1);
    expect(state.turn.phase.at(-1)?.id).toBe('preRoll');
    expect(state.board.buildings).toHaveLength(6);
    expect(state.board.roads).toHaveLength(6);
  });
});
