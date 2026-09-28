import { describe, expect, test } from 'vitest';
import { createRegistry } from '../../../core/modules/index.js';
import type { BoardShapeSpec } from '../../../core/modules/types.js';
import { boardShapeProblems } from '../../../core/board/index.js';
import { buildBoardGraph, edgeId, hexId, vertexId } from '../../../core/geometry/index.js';
import { createRng } from '../../../core/rng/index.js';
import type { BoardHex, BoardState, GameState } from '../../../core/state/types.js';
import { boardIslands, edgeKindOf, isLandHex, vertexOnLand } from '../board/index.js';
import { baseModule, createBaseEngine } from '../index.js';
import {
  canPlaceRoad,
  canPlaceSettlement,
  legalRoadEdges,
  legalSettlementVertices,
} from '../placement/index.js';
import { productionPayments } from '../production.js';
import { legalRobberHexes } from '../robber.js';
import { BoardGenerationError, generateBoard, validateFixedBoard } from '../setup/board/index.js';

/** Land (forest 6, gold 6), two sea hexes, land (fields 9) and a fog hex, in one row. */
const TERRAINS: [string, number | null][] = [
  ['forest', 6],
  ['gold', 6],
  ['sea', null],
  ['sea', null],
  ['fields', 9],
  ['fog', null],
];
const hexes: BoardHex[] = TERRAINS.map(([terrain, token], q) => ({
  id: hexId({ q, r: 0 }),
  q,
  r: 0,
  terrain,
  token,
}));
const graph = buildBoardGraph(hexes);
const COASTAL = edgeId({ q: 2, r: 0 }, 'W');
const SPEC: BoardShapeSpec = {
  id: 'test-sea',
  hexes,
  terrains: TERRAINS.map(([terrain]) => terrain),
  tokens: [6, 6, 9],
  harbors: ['generic'],
  harborSlots: [],
  fixtureSlots: [],
  pipCaps: {},
  seafaring: true,
};
function board(overrides: Partial<BoardState> = {}): BoardState {
  return {
    hexes: hexes.map((hex) => ({ ...hex })),
    harbors: [{ edge: COASTAL, kind: 'generic' }],
    roads: [],
    buildings: [],
    robberHex: 'h:0,0',
    ...overrides,
  };
}
function state(overrides: Partial<BoardState> = {}): GameState {
  return {
    schema: 1,
    engineVersion: 'test',
    config: { modules: [], seats: [0, 1], options: { base: {} } },
    board: board(overrides),
    seats: [],
    bank: { brick: 19, lumber: 19, wool: 19, grain: 19, ore: 19 },
    decks: {},
    turn: { number: 0, activeSeat: 0, phase: [] },
    awards: {},
    counters: { nextOfferId: 0, nextSlotId: 0, inputSeq: 0 },
    ext: {},
    result: null,
  };
}

const retoken = (index: number, token: number | null) => {
  const changed = board();
  changed.hexes = changed.hexes.map((hex, at) => (at === index ? { ...hex, token } : hex));
  return changed;
};

describe('sea-aware placement', () => {
  const seaOnly = vertexId({ q: 3, r: 0 }, 'N');
  const fogOnly = vertexId({ q: 5, r: 0 }, 'NE');
  const landVertex = vertexId({ q: 1, r: 0 }, 'SE');

  test('a settlement needs a vertex that touches land; fog is not land', () => {
    const game = state();
    expect(vertexOnLand(game, landVertex)).toBe(true);
    expect(vertexOnLand(game, seaOnly)).toBe(false);
    expect(vertexOnLand(game, fogOnly)).toBe(false);
    expect(canPlaceSettlement(game, 0, landVertex, { setup: true })).toBe(true);
    expect(canPlaceSettlement(game, 0, seaOnly, { setup: true })).toBe(false);
    expect(canPlaceSettlement(game, 0, fogOnly, { setup: true })).toBe(false);
    const legal = legalSettlementVertices(game, 0, { setup: true });
    expect(legal.length).toBeGreaterThan(0);
    expect(legal.every((vertex) => vertexOnLand(game, vertex))).toBe(true);
    expect(legal).not.toContain(seaOnly);
  });
  test('a road may not use a sea-sea edge but may use land and coastal edges', () => {
    const game = state({ buildings: [{ vertex: landVertex, seat: 0, kind: 'settlement' }] });
    const incident = graph.vertexEdges[graph.vertexIndex[landVertex] ?? -1] ?? [];
    const kinds = incident.map((edge) => edgeKindOf(game, edge));
    expect(kinds).toContain('sea');
    expect(kinds).toContain('coastal');
    for (const edge of incident) {
      const usable = edgeKindOf(game, edge) !== 'sea';
      expect(canPlaceRoad(game, 0, edge)).toBe(usable);
      expect(legalRoadEdges(game, 0).includes(edge)).toBe(usable);
      expect(canPlaceRoad(game, 0, edge, { setupVertex: landVertex })).toBe(usable);
    }
  });
  test('the robber may only move to land hexes', () => {
    expect(legalRobberHexes(state())).toEqual(['h:1,0', 'h:4,0']);
    expect(isLandHex(state(), 'h:2,0')).toBe(false);
    expect(isLandHex(state(), 'h:5,0')).toBe(false);
    expect(isLandHex(state(), 'h:1,0')).toBe(true);
  });
  test('boardIslands is cached per hex list and follows a fog reveal', () => {
    const game = state();
    expect(boardIslands(game)).toBe(boardIslands(game));
    expect(boardIslands(game).map((island) => island.id)).toEqual(['h:0,0', 'h:4,0']);
    const revealed = {
      ...game,
      board: {
        ...game.board,
        hexes: game.board.hexes.map((hex) =>
          hex.id === 'h:5,0' ? { ...hex, terrain: 'pasture', token: 3 } : hex,
        ),
      },
    };
    expect(boardIslands(revealed)[1]?.hexes).toEqual(['h:4,0', 'h:5,0']);
  });
});

describe('production ignores gold, sea and fog', () => {
  test('a settlement beside a gold hex and a forest hex on the same roll collects only lumber', () => {
    const shared = vertexId({ q: 1, r: 0 }, 'NW');
    const game = state({
      buildings: [{ vertex: shared, seat: 0, kind: 'settlement' }],
      robberHex: 'h:4,0',
    });
    const context = { hooks: createRegistry([baseModule()]).hooks };
    const paid = productionPayments(game, 6, context).get(0);
    expect(paid).toEqual({ brick: 0, lumber: 1, wool: 0, grain: 0, ore: 0 });
  });
});

describe('invariants', () => {
  const engine = createBaseEngine();
  function genesis(): GameState {
    return engine.createGame(
      {
        modules: [{ id: 'base', version: baseModule().version }],
        seats: [0, 1],
        options: { base: { mapLayout: 'random' } },
      },
      new Uint8Array(32),
    );
  }
  test('a base genesis passes; a robber on a sea hex and a harbor on a sea edge do not', () => {
    const game = genesis();
    expect(engine.checkInvariants(game)).toEqual([]);
    const flooded = {
      ...game,
      board: {
        ...game.board,
        hexes: game.board.hexes.map((hex) =>
          hex.id === game.board.robberHex ? { ...hex, terrain: 'sea', token: null } : hex,
        ),
      },
    };
    expect(engine.checkInvariants(flooded)).toContain('robber must occupy a land hex');
    const inner = buildBoardGraph(game.board.hexes).edgeIds.find(
      (edge) => edgeKindOf(game, edge) === 'land',
    );
    if (!inner) throw new Error('No inner edge');
    const misplaced = {
      ...game,
      board: { ...game.board, harbors: [{ edge: inner, kind: 'generic' }] },
    };
    expect(engine.checkInvariants(misplaced)).toContain('harbor must be on a coastal edge');
  });
});

describe('fixed seafaring boards', () => {
  const layout = { mapLayout: 'standard-fixed', strictBalance: false } as const;

  test('the shape has consistent bags', () => {
    expect(boardShapeProblems(SPEC)).toEqual([]);
    expect(boardShapeProblems({ ...SPEC, tokens: [6, 6] })).toHaveLength(1);
  });
  test('a shape flagged seafaring accepts sea, gold and fog and keeps them on genesis', () => {
    expect(() => validateFixedBoard(board(), SPEC)).not.toThrow();
    const generated = generateBoard(createRng(new Uint8Array(32)), layout, board(), SPEC);
    expect(generated.hexes.map((hex) => hex.terrain)).toEqual(TERRAINS.map(([terrain]) => terrain));
  });
  test('the robber may start on any land hex, but not on sea or fog', () => {
    expect(() => validateFixedBoard(board({ robberHex: 'h:4,0' }), SPEC)).not.toThrow();
    expect(() => validateFixedBoard(board({ robberHex: 'h:2,0' }), SPEC)).toThrow(
      BoardGenerationError,
    );
    expect(() => validateFixedBoard(board({ robberHex: 'h:5,0' }), SPEC)).toThrow(
      BoardGenerationError,
    );
  });
  test('harbors must be on coastal edges of the supplied board', () => {
    for (const edge of [edgeId({ q: 1, r: 0 }, 'W'), edgeId({ q: 3, r: 0 }, 'W')])
      expect(() =>
        validateFixedBoard(board({ harbors: [{ edge, kind: 'generic' }] }), SPEC),
      ).toThrow(BoardGenerationError);
  });
  test('tokens follow terrain: sea and fog have none, gold has one', () => {
    expect(() => validateFixedBoard(retoken(2, 3), SPEC)).toThrow(BoardGenerationError);
    expect(() => validateFixedBoard(retoken(1, null), SPEC)).toThrow(BoardGenerationError);
  });
  test('base stays strict: the same board fails without the flag, and random layouts need a fixed board', () => {
    const { seafaring: _seafaring, ...strict } = SPEC;
    expect(() => validateFixedBoard(board(), strict)).toThrow(BoardGenerationError);
    for (const mapLayout of ['random', 'balanced-random'] as const)
      expect(() =>
        generateBoard(
          createRng(new Uint8Array(32)),
          { mapLayout, strictBalance: false },
          undefined,
          SPEC,
        ),
      ).toThrow(BoardGenerationError);
  });
});
