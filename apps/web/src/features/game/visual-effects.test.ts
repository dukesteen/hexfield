import { expect, test } from 'vitest';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { standardFixedBoard } from '@cp2p/maps';
import { LocalSession } from '../../session/local-session';
import { deriveVisualEffects } from './visual-effects';

test('public production gains create exact flights from a producing tile', () => {
  const made = LocalSession.create({
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1],
      options: { base: { mapLayout: 'standard-fixed' } },
      board: standardFixedBoard(),
    },
    humanSeats: [0, 1],
    botSeats: [],
    genesisSeed: new Uint8Array(32).fill(4),
  });
  if (!made.ok) throw new Error(made.error.message);
  try {
    const before = made.value.getState();
    const source = before.board.hexes.find((hex) => hex.terrain === 'fields' && hex.token !== null);
    if (!source?.token) throw new Error('Fixed board needs producing fields');
    const graph = buildBoardGraph(before.board.hexes);
    const index = graph.hexIndex[source.id];
    if (index === undefined) throw new Error('Producing hex missing from graph');
    const vertex = graph.hexVertices[index]?.[0];
    if (!vertex) throw new Error('Producing hex needs a vertex');
    const state = {
      ...before,
      board: {
        ...before.board,
        buildings: [{ vertex, seat: 0 as const, kind: 'city' as const }],
      },
    };
    const first = Math.max(1, source.token - 6);
    const effects = deriveVisualEffects(
      state,
      state,
      [
        { type: 'diceRolled', roll: source.token, dice: [first, source.token - first] },
        { type: 'resourcesProduced', bySeat: { '0': { grain: 2, ore: 0 } } },
        { type: 'resourceStolen', thief: 0, victim: 1, resource: 'ore' },
      ],
      20,
    );
    expect(effects.board.map((effect) => effect.kind)).toEqual(['dice-roll']);
    expect(effects.flights).toEqual([
      { id: '20:1:0:grain:0', seat: 0, resource: 'grain', count: 2, fromHex: source.id },
    ]);
    expect(effects.productionGains).toEqual([{ id: '20:1:0', seat: 0, resources: { grain: 2 } }]);
    expect(
      deriveVisualEffects(
        state,
        state,
        [
          { type: 'diceRolled', roll: source.token, dice: [first, source.token - first] },
          { type: 'resourcesProduced', bySeat: { '0': { grain: 0 } } },
        ],
        21,
      ).flights,
    ).toEqual([]);
    expect(
      deriveVisualEffects(
        state,
        state,
        [{ type: 'resourcesProduced', bySeat: { '0': { wool: 1 }, '1': { ore: 0 } } }],
        24,
      ).productionGains,
    ).toEqual([{ id: '24:0:0', seat: 0, resources: { wool: 1 } }]);
    const distant = before.board.hexes.find((hex) => {
      if (hex.id === source.id) return false;
      const otherIndex = graph.hexIndex[hex.id];
      return (
        otherIndex !== undefined &&
        !(graph.hexVertices[index] ?? []).some((candidate) =>
          (graph.hexVertices[otherIndex] ?? []).includes(candidate),
        )
      );
    });
    const otherIndex = distant ? graph.hexIndex[distant.id] : undefined;
    const otherVertex = otherIndex === undefined ? undefined : graph.hexVertices[otherIndex]?.[0];
    if (!distant || !otherVertex) throw new Error('Fixed board needs a distant source');
    const twoSources = {
      ...state,
      board: {
        ...state.board,
        hexes: state.board.hexes.map((hex) =>
          hex.id === distant.id ? { ...hex, terrain: 'fields', token: source.token } : hex,
        ),
        buildings: [
          ...state.board.buildings,
          { vertex: otherVertex, seat: 0 as const, kind: 'settlement' as const },
        ],
      },
    };
    const two = deriveVisualEffects(
      twoSources,
      twoSources,
      [
        { type: 'diceRolled', roll: source.token, dice: [first, source.token - first] },
        { type: 'resourcesProduced', bySeat: { '0': { grain: 3 } } },
      ],
      22,
    ).flights;
    expect(two.map((flight) => flight.count).toSorted((a, b) => a - b)).toEqual([1, 2]);
    expect(new Set(two.map((flight) => flight.fromHex))).toEqual(new Set([source.id, distant.id]));
    const shortage = deriveVisualEffects(
      twoSources,
      twoSources,
      [
        { type: 'diceRolled', roll: source.token, dice: [first, source.token - first] },
        { type: 'resourcesProduced', bySeat: { '0': { grain: 1 } } },
      ],
      23,
    ).flights;
    expect(shortage.reduce((sum, flight) => sum + flight.count, 0)).toBe(1);
  } finally {
    made.value.dispose();
  }
});

test('only confirmed trades create grouped public card flights to the chosen recipient', () => {
  const made = LocalSession.create({
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2],
      options: { base: { mapLayout: 'standard-fixed' } },
      board: standardFixedBoard(),
    },
    humanSeats: [0, 1, 2],
    botSeats: [],
    genesisSeed: new Uint8Array(32).fill(5),
  });
  if (!made.ok) throw new Error(made.error.message);
  try {
    const state = made.value.getState();
    const before = {
      ...state,
      ext: {
        ...state.ext,
        base: {
          offers: [
            {
              id: 17,
              proposer: 0,
              give: { brick: 2, lumber: 0, wool: 0, grain: 1, ore: 0 },
              want: { brick: 0, lumber: 1, wool: 0, grain: 0, ore: 0 },
              to: [1, 2],
              acceptedBy: [1, 2],
              declinedBy: [],
              valid: true,
            },
          ],
        },
      },
    };
    const after = deriveVisualEffects(
      before,
      state,
      [{ type: 'tradeConfirmed', offerId: 17, withSeat: 2 }],
      31,
    ).tradeFlights;
    expect(after).toEqual([
      { id: '31:0:trade:17:give:brick', from: 0, to: 2, resource: 'brick', count: 2 },
      { id: '31:0:trade:17:give:grain', from: 0, to: 2, resource: 'grain', count: 1 },
      { id: '31:0:trade:17:want:lumber', from: 2, to: 0, resource: 'lumber', count: 1 },
    ]);
    expect(
      deriveVisualEffects(before, state, [{ type: 'tradeOffered', offerId: 17, withSeat: 2 }], 32)
        .tradeFlights,
    ).toEqual([]);
    expect(
      deriveVisualEffects(before, state, [{ type: 'tradeConfirmed', offerId: 17, withSeat: 9 }], 33)
        .tradeFlights,
    ).toEqual([]);
    const counterOffer = {
      ...before,
      ext: {
        ...before.ext,
        base: {
          offers: [
            {
              id: 18,
              proposer: 1,
              give: { brick: 0, lumber: 0, wool: 1, grain: 0, ore: 0 },
              want: { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 2 },
              to: [0],
              acceptedBy: [],
              declinedBy: [],
              valid: true,
            },
          ],
        },
      },
    };
    expect(
      deriveVisualEffects(
        counterOffer,
        state,
        [{ type: 'tradeConfirmed', offerId: 18, withSeat: 0 }],
        34,
      ).tradeFlights,
    ).toEqual([
      { id: '34:0:trade:18:give:wool', from: 1, to: 0, resource: 'wool', count: 1 },
      { id: '34:0:trade:18:want:ore', from: 0, to: 1, resource: 'ore', count: 2 },
    ]);
  } finally {
    made.value.dispose();
  }
});
