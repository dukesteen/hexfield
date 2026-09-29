import { describe, expect, test } from 'vitest';
import {
  MODULE_CATALOGUE,
  boardShapeProblems,
  classifyEdge,
  coastalEdges,
  detectIslands,
  engineForConfig,
  isLandTerrain,
  isTokenlessTerrain,
} from '@cp2p/engine';
import type { BoardState } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import {
  BOARD_SHAPES,
  FIXED_SEAFARING,
  OPEN_SEA_OPTIONS,
  SCENARIOS,
  harborProblems,
  scenarioById,
  scenarioConfig,
  scenarioOfConfig,
  tokenProblems,
} from './index.js';
import type { FixedSeafaringData } from './index.js';
import { FOGBOUND_56_FOG, FOGBOUND_FOG } from './scenarios/seafaring/index.js';
import { cellId, parseRows, renderRows } from './scenarios/seafaring/layout.js';

interface Expectation {
  data: FixedSeafaringData;
  hexes: number;
  /** Largest frame in offset rows and columns. */
  frame: [rows: number, cols: number];
  islands: number[];
  harbors: number;
  seats: number;
  vp: number;
  bonus: 1 | 2 | null;
  fog: boolean;
}

const byId = (id: string): FixedSeafaringData => {
  const found = FIXED_SEAFARING.find((data) => data.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
};

const EXPECTED: Expectation[] = [
  {
    data: byId('new-horizons'),
    hexes: 63,
    frame: [7, 9],
    islands: [21, 3, 3, 2, 2, 2, 1],
    harbors: 9,
    seats: 4,
    vp: 14,
    bonus: 2,
    fog: false,
  },
  {
    data: byId('new-horizons-56'),
    hexes: 99,
    frame: [9, 11],
    islands: [32, 3, 3, 3, 2, 2, 2, 1, 1],
    harbors: 10,
    seats: 6,
    vp: 16,
    bonus: 2,
    fog: false,
  },
  {
    data: byId('four-isles'),
    hexes: 63,
    frame: [7, 9],
    islands: [7, 7, 7, 7],
    harbors: 9,
    seats: 4,
    vp: 13,
    bonus: 2,
    fog: false,
  },
  {
    data: byId('four-isles-56'),
    hexes: 77,
    frame: [7, 11],
    islands: [10, 10, 10, 10],
    harbors: 10,
    seats: 6,
    vp: 13,
    bonus: 2,
    fog: false,
  },
  {
    data: byId('fogbound'),
    hexes: 63,
    frame: [7, 9],
    islands: [11, 11],
    harbors: 9,
    seats: 4,
    vp: 12,
    bonus: null,
    fog: true,
  },
  {
    data: byId('fogbound-56'),
    hexes: 99,
    frame: [9, 11],
    islands: [17, 17],
    harbors: 10,
    seats: 6,
    vp: 12,
    bonus: null,
    fog: true,
  },
  {
    data: byId('desert-crossing'),
    hexes: 63,
    frame: [7, 9],
    islands: [31, 2, 2, 2, 2],
    harbors: 9,
    seats: 4,
    vp: 13,
    bonus: 2,
    fog: false,
  },
  {
    data: byId('desert-crossing-56'),
    hexes: 99,
    frame: [9, 11],
    islands: [47, 3, 3, 3, 3],
    harbors: 10,
    seats: 6,
    vp: 13,
    bonus: 2,
    fog: false,
  },
];

/** Greedy distance-rule packing over the land vertices of the setup hexes. */
function setupSites(board: BoardState, area: readonly string[]): number {
  const wanted = new Set(area);
  const graph = buildBoardGraph(board.hexes);
  const taken = new Set<string>();
  let sites = 0;
  for (const [index, vertex] of graph.vertexIds.entries()) {
    const touches = (graph.vertexHexes[index] ?? []).some((id) => wanted.has(id));
    if (!touches || (graph.vertexNeighbors[index] ?? []).some((next) => taken.has(next))) continue;
    taken.add(vertex);
    sites++;
  }
  return sites;
}

describe.each(EXPECTED)('seafaring scenario $data.id', (expected) => {
  const { data } = expected;
  const board = data.board();
  const land = board.hexes.filter((hex) => isLandTerrain(hex.terrain));
  const hexById = new Map(board.hexes.map((hex) => [hex.id, hex]));
  const options = data.options;

  test('the shape lists every hex and passes the shape checks', () => {
    expect(data.shape.seafaring).toBe(true);
    expect(data.shape.hexes).toHaveLength(expected.hexes);
    expect(board.hexes).toHaveLength(expected.hexes);
    expect(boardShapeProblems(data.shape)).toEqual([]);
    expect(BOARD_SHAPES[data.id]).toBe(data.shape);
    expect(new Set(board.hexes.map((hex) => hex.id)).size).toBe(expected.hexes);
    expect(data.shape.terrains.toSorted((a, b) => a.localeCompare(b))).toEqual(
      board.hexes.map((hex) => hex.terrain).toSorted((a, b) => a.localeCompare(b)),
    );
    const tokens = board.hexes
      .filter((hex) => !isTokenlessTerrain(hex.terrain))
      .flatMap((hex) => (hex.token === null ? [] : [hex.token]));
    expect(data.shape.tokens.toSorted((a, b) => a - b)).toEqual(tokens.toSorted((a, b) => a - b));
  });

  test('fits the renderer frame', () => {
    const rows = new Set(board.hexes.map((hex) => hex.r)).size;
    const cols = renderRows(board.hexes)[0]?.trim().split(/\s+/).length;
    expect([rows, cols]).toEqual(expected.frame);
  });

  test('a layout survives a render and parse round trip', () => {
    expect(parseRows(renderRows(board.hexes))).toEqual(board.hexes);
  });

  test('tokens sit on productive land and never break the red-number rule', () => {
    expect(tokenProblems(board.hexes)).toEqual([]);
    const tokenless = board.hexes.every(
      (hex) => (hex.token === null) === isTokenlessTerrain(hex.terrain),
    );
    expect(tokenless).toBe(true);
  });

  test('islands match the design', () => {
    const sizes = detectIslands(board.hexes)
      .map((island) => island.hexes.length)
      .toSorted((a, b) => b - a);
    expect(sizes).toEqual(expected.islands);
  });

  test('resources are spread evenly', () => {
    const counts = ['forest', 'pasture', 'fields', 'hills', 'mountains'].map(
      (kind) => board.hexes.filter((hex) => hex.terrain === kind).length,
    );
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(3);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(4);
  });

  test('harbors sit on distinct coastal edges without sharing a vertex', () => {
    expect(board.harbors).toHaveLength(expected.harbors);
    expect(harborProblems(board)).toEqual([]);
    const graph = buildBoardGraph(board.hexes);
    const landIds = new Set(land.map((hex) => hex.id));
    for (const { edge } of board.harbors) {
      expect(coastalEdges(board.hexes)).toContain(edge);
      expect(classifyEdge(graph, edge, landIds)).toBe('coastal');
    }
    const kinds = board.harbors.map((harbor) => harbor.kind);
    for (const kind of ['brick', 'lumber', 'wool', 'grain', 'ore'])
      expect(kinds.filter((k) => k === kind)).toHaveLength(1);
    expect(kinds.filter((k) => k === 'generic').length).toBe(expected.harbors - 5);
  });

  test('the pirate starts at sea and the robber on land', () => {
    expect(hexById.get(options.pirateHex ?? '')?.terrain).toBe('sea');
    const robber = hexById.get(board.robberHex ?? '');
    expect(robber && isLandTerrain(robber.terrain)).toBe(true);
    expect(board.roads).toEqual([]);
    expect(board.buildings).toEqual([]);
  });

  test('setup areas are land and roomy enough for every seat', () => {
    const area = options.setupAreas ?? [];
    expect(area.length).toBeGreaterThan(0);
    expect(new Set(area).size).toBe(area.length);
    for (const id of area)
      expect(hexById.get(id) && isLandTerrain(hexById.get(id)?.terrain ?? '')).toBe(true);
    expect(setupSites(board, area)).toBeGreaterThanOrEqual(expected.seats * 3);
    expect(area.length).toBeGreaterThanOrEqual(11);
  });

  test('bonus and fog options follow the rules', () => {
    expect(options.islandBonus?.vp ?? null).toBe(expected.bonus);
    // Fog and the island bonus never appear together.
    expect(Boolean(options.fog)).toBe(expected.fog);
    expect(options.fog !== undefined && options.islandBonus !== undefined).toBe(false);
  });

  test('a fresh board is built each call', () => {
    const again = data.board();
    expect(again).toEqual(board);
    expect(again).not.toBe(board);
    expect(again.hexes[0]).not.toBe(board.hexes[0]);
  });
});

describe('New Horizons', () => {
  test('setup is on the home island alone and the small islands earn the bonus', () => {
    for (const id of ['new-horizons', 'new-horizons-56']) {
      const data = byId(id);
      const board = data.board();
      const islands = detectIslands(board.hexes);
      const home = islands.toSorted((a, b) => b.hexes.length - a.hexes.length)[0];
      expect(data.options.setupAreas).toEqual(home?.hexes);
      expect(data.options.bonusRegions).toBeUndefined();
      const gold = board.hexes.filter((hex) => hex.terrain === 'gold');
      expect(gold.length).toBeGreaterThanOrEqual(3);
      for (const hex of gold) expect(home?.hexes).not.toContain(hex.id);
      expect(board.hexes.find((hex) => hex.id === board.robberHex)?.terrain).toBe('desert');
    }
  });
});

describe('Four Isles', () => {
  test('islands are separated by open water and setup may use any of them', () => {
    for (const id of ['four-isles', 'four-isles-56']) {
      const data = byId(id);
      const board = data.board();
      expect(data.options.setupAreas).toHaveLength(
        board.hexes.filter((h) => isLandTerrain(h.terrain)).length,
      );
      expect(board.hexes.filter((hex) => hex.terrain === 'desert')).toHaveLength(2);
    }
  });
});

describe.each(['fogbound', 'fogbound-56'])('Fogbound (%s)', (fogId) => {
  const data = byId(fogId);
  const board = data.board();
  const fog = data.options.fog;

  test('the fog stack matches the fog hexes', () => {
    expect(fog).toBe(fogId === 'fogbound' ? FOGBOUND_FOG : FOGBOUND_56_FOG);
    if (!fog) throw new Error('missing fog');
    const fogHexes = board.hexes.filter((hex) => hex.terrain === 'fog');
    const tiles = Object.values(fog.terrains).reduce((sum, count) => sum + count, 0);
    expect(tiles).toBe(fogHexes.length);
    for (const hex of fogHexes) expect(hex.token).toBeNull();
    const withToken = Object.entries(fog.terrains)
      .filter(([terrain]) => !isTokenlessTerrain(terrain))
      .reduce((sum, [, count]) => sum + count, 0);
    expect(Object.values(fog.tokens).reduce((sum, count) => sum + count, 0)).toBe(withToken);
    expect(fog.terrains.sea).toBeGreaterThan(0);
    expect(fog.terrains.gold).toBeGreaterThan(0);
    expect(fog.terrains.fog).toBeUndefined();
    for (const token of Object.keys(fog.tokens)) {
      expect(Number(token)).toBeGreaterThanOrEqual(2);
      expect(Number(token)).toBeLessThanOrEqual(12);
      expect(Number(token)).not.toBe(7);
    }
  });

  test('fog is reachable across open water from both islands', () => {
    const graph = buildBoardGraph(board.hexes);
    const seaVertices = new Set<string>();
    const touching = (terrain: string) =>
      new Set(board.hexes.filter((hex) => hex.terrain === terrain).map((hex) => hex.id));
    const fogIds = touching('fog');
    const landIds = new Set(
      board.hexes.filter((hex) => isLandTerrain(hex.terrain)).map((hex) => hex.id),
    );
    for (const [index, hexes] of graph.vertexHexes.entries())
      if (hexes.some((id) => fogIds.has(id)) && hexes.some((id) => touching('sea').has(id)))
        seaVertices.add(graph.vertexIds[index] ?? '');
    expect(seaVertices.size).toBeGreaterThan(6);
    // No fog hex touches a land hex, so a reveal always needs a ship voyage.
    for (const [, hexes] of graph.vertexHexes.entries())
      expect(hexes.some((id) => fogIds.has(id)) && hexes.some((id) => landIds.has(id))).toBe(false);
  });

  test('two starting islands are both setup areas', () => {
    const area = new Set(data.options.setupAreas);
    const islands = detectIslands(board.hexes);
    expect(islands).toHaveLength(2);
    for (const island of islands) for (const id of island.hexes) expect(area.has(id)).toBe(true);
  });
});

const CROSSINGS = [
  { id: 'desert-crossing', main: 31, strip: 5, side: 13, center: cellId(4, 3) },
  { id: 'desert-crossing-56', main: 47, strip: 7, side: 20, center: cellId(5, 4) },
];

describe.each(CROSSINGS)('Desert Crossing ($id)', (crossing) => {
  const data = byId(crossing.id);
  const board = data.board();
  const regions = data.options.bonusRegions ?? [];
  const land = new Set(
    board.hexes.filter((hex) => isLandTerrain(hex.terrain)).map((hex) => hex.id),
  );

  test('the desert strip joins both sides into one connected island', () => {
    const [big] = detectIslands(board.hexes).toSorted((a, b) => b.hexes.length - a.hexes.length);
    expect(big?.hexes).toHaveLength(crossing.main);
    const strip = board.hexes.filter((hex) => hex.terrain === 'desert');
    expect(strip).toHaveLength(crossing.strip);
    for (const hex of strip) expect(big?.hexes).toContain(hex.id);
  });

  test('explicit regions are disjoint land and leave only the strip uncovered', () => {
    expect(regions).toHaveLength(6);
    const all = regions.flat();
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(land.has(id)).toBe(true);
    const uncovered = [...land].filter((id) => !all.includes(id));
    expect(uncovered.toSorted()).toEqual(
      board.hexes
        .filter((hex) => hex.terrain === 'desert')
        .map((hex) => hex.id)
        .toSorted(),
    );
  });

  test('each region is one connected group, and the two sides never touch', () => {
    const graph = buildBoardGraph(board.hexes);
    const adjacent = (a: string, b: string) =>
      graph.edgeHexes.some(
        (pair) => pair.length === 2 && pair.some((id) => id === a) && pair.some((id) => id === b),
      );
    for (const region of regions) {
      const seen = new Set([region[0] ?? '']);
      const queue = [region[0] ?? ''];
      for (let head = 0; head < queue.length; head++)
        for (const id of region)
          if (!seen.has(id) && adjacent(queue[head] ?? '', id)) {
            seen.add(id);
            queue.push(id);
          }
      expect(seen.size).toBe(region.length);
    }
    const [west = [], east = []] = regions;
    for (const a of west) for (const b of east) expect(adjacent(a, b)).toBe(false);
  });

  test('setup is on the home side only, and the home side is the first region', () => {
    expect(data.options.setupAreas).toEqual(regions[0]);
    expect(regions[0]).toHaveLength(crossing.side);
    expect(regions[1]).toHaveLength(crossing.side);
    for (const id of regions.slice(2).flat()) expect(data.options.setupAreas).not.toContain(id);
    expect(board.robberHex).toBe(crossing.center);
  });
});

describe('Open Sea', () => {
  test('is generated at genesis by the archipelago layout', () => {
    expect(OPEN_SEA_OPTIONS).toEqual({
      layout: 'archipelago-v2',
      pirateHex: null,
      islandBonus: { vp: 1 },
    });
    for (const id of ['open-sea', 'open-sea-56']) {
      const scenario = scenarioById(id);
      expect(scenario?.board).toEqual({ kind: 'generator', shape: 'archipelago' });
      expect(scenario?.options).toEqual({ seafaring: OPEN_SEA_OPTIONS });
      expect(scenario?.vpTarget).toBe(12);
    }
  });
});

describe('seafaring scenario registry', () => {
  const TABLE: [string, string[], number, number, number][] = [
    ['new-horizons', ['base', 'seafaring'], 3, 4, 14],
    ['new-horizons-56', ['base', 'five-six', 'seafaring'], 5, 6, 16],
    ['four-isles', ['base', 'seafaring'], 3, 4, 13],
    ['four-isles-56', ['base', 'five-six', 'seafaring'], 5, 6, 13],
    ['fogbound', ['base', 'seafaring'], 3, 4, 12],
    ['fogbound-56', ['base', 'five-six', 'seafaring'], 5, 6, 12],
    ['desert-crossing', ['base', 'seafaring'], 3, 4, 13],
    ['desert-crossing-56', ['base', 'five-six', 'seafaring'], 5, 6, 13],
    ['open-sea', ['base', 'seafaring'], 3, 4, 12],
    ['open-sea-56', ['base', 'five-six', 'seafaring'], 5, 6, 12],
  ];

  test.each(TABLE)(
    '%s uses the documented modules, seats and target',
    (id, modules, min, max, vp) => {
      const scenario = scenarioById(id);
      expect(scenario?.modules).toEqual(modules);
      expect(scenario?.seats).toEqual({ min, max });
      expect(scenario?.vpTarget).toBe(vp);
    },
  );

  test('every scenario has a title and about key', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.titleKey).toMatch(/^scenario[A-Z]/);
      expect(scenario.aboutKey).toBe(`${scenario.titleKey}About`);
    }
    expect(new Set(SCENARIOS.map((scenario) => scenario.titleKey)).size).toBe(SCENARIOS.length);
  });

  // The seafaring module may not be in the engine catalogue yet. These run once it is.
  describe.runIf(Object.hasOwn(MODULE_CATALOGUE, 'seafaring'))('with the seafaring module', () => {
    test.each(TABLE)('%s builds a config and a game', (id, _modules, min, max) => {
      const scenario = scenarioById(id);
      if (!scenario) throw new Error(`missing ${id}`);
      for (const seats of [min, max]) {
        const config = scenarioConfig(scenario, seats);
        expect(config.options.seafaring).toEqual(scenario.options.seafaring);
        expect(config.options.base).toMatchObject({ vpTarget: scenario.vpTarget });
        expect(scenarioOfConfig(config)?.id).toBe(id);
        const state = engineForConfig(config).createGame(config, new Uint8Array(32));
        expect(state.config.seats).toHaveLength(seats);
      }
    });
  });
});
