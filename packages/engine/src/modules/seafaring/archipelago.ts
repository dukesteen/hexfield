import { coastalEdges, detectIslands, isLandTerrain } from '../../core/board/index.js';
import type { Island } from '../../core/board/index.js';
import { HEX_DIRECTIONS, buildBoardGraph, edgeToPixel, hexId } from '../../core/geometry/index.js';
import type { EdgeId, HexCoord } from '../../core/geometry/index.js';
import type { GenesisRandom } from '../../core/modules/types.js';
import type { BoardHex, BoardState } from '../../core/state/types.js';

/**
 * Open Sea board generator: a seeded archipelago on an offset-row frame. A pure function of the
 * random source and the parameters, so every peer builds the same board from the genesis seed.
 *
 * Rules the result always satisfies (see `archipelagoProblems`):
 * - one home island (the largest) holds the only desert and room for every seat's setup;
 * - the other islands have a bounded size, never touch one another, and hold the gold fields;
 * - the sea is one connected body, so every island can be reached by ship;
 * - no two adjacent land hexes share a token or both carry a red number (6 or 8), and the
 *   average pips of the five resources stay within one pip of each other;
 * - harbors sit on coastal edges, never share a vertex, and the pirate starts at sea.
 */
export interface ArchipelagoParams {
  /** Frame width and height in hexes (odd rows sit half a hex to the right). */
  readonly cols: number;
  readonly rows: number;
  /** Number of islands besides the home island. */
  readonly islands: { readonly min: number; readonly max: number };
  /** Hexes per non-home island. */
  readonly islandSize: { readonly min: number; readonly max: number };
  /** Hexes on the home island. Its minimum must exceed the other islands' maximum. */
  readonly homeSize: { readonly min: number; readonly max: number };
  /** Settlement sites the home island must hold under the distance rule (greedy lower bound). */
  readonly homeSites: number;
  /** Gold fields, all on non-home islands. */
  readonly goldFields: number;
  /** One entry per harbor: `generic` or a resource. Kinds are shuffled over the chosen edges. */
  readonly harbors: readonly string[];
  /** Layout attempts before giving up. */
  readonly maxAttempts: number;
}

const HARBOR_KINDS = [
  'generic',
  'generic',
  'generic',
  'generic',
  'brick',
  'lumber',
  'wool',
  'grain',
  'ore',
];
const RESOURCES = ['forest', 'pasture', 'fields', 'hills', 'mountains'] as const;

/** 3-4 players: a 9x7 frame (63 hexes) with a 14-18 hex home island and 4-5 small islands. */
export const ARCHIPELAGO_STANDARD: ArchipelagoParams = Object.freeze({
  cols: 9,
  rows: 7,
  islands: Object.freeze({ min: 4, max: 5 }),
  islandSize: Object.freeze({ min: 2, max: 4 }),
  homeSize: Object.freeze({ min: 14, max: 18 }),
  homeSites: 12,
  goldFields: 3,
  harbors: Object.freeze(HARBOR_KINDS),
  maxAttempts: 400,
});

/** 5-6 players: an 11x9 frame (99 hexes) with a 24-30 hex home island and 5-7 small islands. */
export const ARCHIPELAGO_LARGE: ArchipelagoParams = Object.freeze({
  cols: 11,
  rows: 9,
  islands: Object.freeze({ min: 5, max: 7 }),
  islandSize: Object.freeze({ min: 2, max: 5 }),
  homeSize: Object.freeze({ min: 24, max: 30 }),
  homeSites: 18,
  goldFields: 4,
  harbors: Object.freeze([...HARBOR_KINDS, 'generic']),
  maxAttempts: 400,
});

/** The preset for a seat count: the large frame from five seats. */
export function archipelagoParamsFor(seatCount: number): ArchipelagoParams {
  return seatCount >= 5 ? ARCHIPELAGO_LARGE : ARCHIPELAGO_STANDARD;
}

/** A generated board with the facts the module needs at genesis. */
export interface Archipelago {
  board: BoardState;
  /** Sea hex the pirate starts on. */
  pirateHex: string;
  /** Every hex of the home island. */
  homeHexes: string[];
  /** Hex ids of each island, home first. */
  islands: string[][];
}

const TOKEN_PIPS: Readonly<Record<number, number>> = {
  2: 1,
  3: 2,
  4: 3,
  5: 4,
  6: 5,
  8: 5,
  9: 4,
  10: 3,
  11: 2,
  12: 1,
};
/** Relative token frequency, the base game's bag over 18 hexes. */
const TOKEN_WEIGHT: Readonly<Record<number, number>> = {
  2: 1,
  3: 2,
  4: 2,
  5: 2,
  6: 2,
  8: 2,
  9: 2,
  10: 2,
  11: 2,
  12: 1,
};

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Archipelago: missing ${what}`);
  return value;
}

/** Axial coordinate of an offset cell (odd rows sit half a hex to the right). */
function cellCoord(col: number, row: number): HexCoord {
  return { q: col - (row - (row & 1)) / 2, r: row };
}

function neighborIds(hex: HexCoord): string[] {
  return HEX_DIRECTIONS.map((step) => hexId({ q: hex.q + step.q, r: hex.r + step.r }));
}

function pixel(hex: HexCoord): { x: number; y: number } {
  return { x: Math.sqrt(3) * (hex.q + hex.r / 2), y: 1.5 * hex.r };
}

function edgeMid(edge: EdgeId): { x: number; y: number } {
  return edgeToPixel(edge, 1).midpoint;
}

function isRed(token: number): boolean {
  return token === 6 || token === 8;
}

/** Pick an index with probability proportional to its weight. */
function weightedIndex(rng: GenesisRandom, weights: readonly number[]): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = rng.int(total);
  for (let index = 0; index < weights.length; index++) {
    roll -= must(weights[index], 'weight');
    if (roll < 0) return index;
  }
  return weights.length - 1;
}

/** Grow the islands on the frame. Returns hex ids per island (home first) or null when stuck. */
function growIslands(rng: GenesisRandom, params: ArchipelagoParams): string[][] | null {
  const cells: HexCoord[] = [];
  for (let row = 0; row < params.rows; row++)
    for (let col = 0; col < params.cols; col++) cells.push(cellCoord(col, row));
  const inFrame = new Set<string>(cells.map(hexId));
  const interior = new Set<string>(
    cells
      .filter((cell) => cell.r > 0 && cell.r < params.rows - 1)
      .filter((cell) => {
        const col = cell.q + (cell.r - (cell.r & 1)) / 2;
        return col > 0 && col < params.cols - 1;
      })
      .map(hexId),
  );
  const owner = new Map<string, number>();
  const count = params.islands.min + rng.int(params.islands.max - params.islands.min + 1);
  const targets = [
    params.homeSize.min + rng.int(params.homeSize.max - params.homeSize.min + 1),
    ...Array.from(
      { length: count },
      () => params.islandSize.min + rng.int(params.islandSize.max - params.islandSize.min + 1),
    ),
  ];
  const middle = pixel(must(cells[Math.floor(cells.length / 2)], 'centre cell'));
  const islands: string[][] = [];
  for (const [index, target] of targets.entries()) {
    // The home island keeps off the frame's rim so ships can sail round it.
    const free = (id: string) =>
      inFrame.has(id) && !owner.has(id) && (index > 0 || interior.has(id));
    const touchesOther = (id: string, self: number) =>
      neighborIds(coordOf(id)).some((next) => {
        const other = owner.get(next);
        return other !== undefined && other !== self;
      });
    let seeds = cells.filter((cell) => free(hexId(cell)) && !touchesOther(hexId(cell), index));
    if (index === 0)
      seeds = seeds.filter((cell) => {
        const at = pixel(cell);
        return Math.hypot(at.x - middle.x, at.y - middle.y) <= params.cols * 0.6;
      });
    if (seeds.length === 0) return null;
    const seed = rng.pick(seeds);
    const members: string[] = [hexId(seed)];
    owner.set(hexId(seed), index);
    while (members.length < target) {
      const frontier = new Map<string, number>();
      for (const id of members)
        for (const next of neighborIds(coordOf(id)))
          if (free(next) && !touchesOther(next, index))
            frontier.set(
              next,
              neighborIds(coordOf(next)).filter((n) => owner.get(n) === index).length,
            );
      const options = [...frontier.keys()].toSorted();
      if (options.length === 0) break;
      const pick = must(
        options[
          weightedIndex(
            rng,
            options.map((id) => 1 + must(frontier.get(id), 'weight') ** 3),
          )
        ],
        'frontier cell',
      );
      members.push(pick);
      owner.set(pick, index);
    }
    const min = index === 0 ? params.homeSize.min : params.islandSize.min;
    if (members.length < min) return null;
    islands.push(members.toSorted());
  }
  return islands;
}

function coordOf(id: string): HexCoord {
  const match = /^h:(-?\d+),(-?\d+)$/.exec(id);
  if (!match) throw new Error(`Invalid hex id ${id}`);
  return { q: Number(match[1]), r: Number(match[2]) };
}

/** All sea hexes form one body of water (adjacency among sea hexes on the frame). */
function seaIsConnected(hexes: readonly BoardHex[]): boolean {
  const sea = new Set(hexes.filter((hex) => !isLandTerrain(hex.terrain)).map((hex) => hex.id));
  const first = [...sea][0];
  if (first === undefined) return false;
  const seen = new Set([first]);
  const queue = [first];
  for (let head = 0; head < queue.length; head++)
    for (const next of neighborIds(coordOf(must(queue[head], 'queue')))) {
      if (!sea.has(next) || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  return seen.size === sea.size;
}

/** Greedy count of settlement sites (distance rule) on the land vertices of some hexes. */
export function settlementSites(land: readonly HexCoord[]): number {
  const graph = buildBoardGraph(land);
  const taken = new Set<string>();
  let sites = 0;
  for (const [index, vertex] of graph.vertexIds.entries()) {
    if ((graph.vertexNeighbors[index] ?? []).some((next) => taken.has(next))) continue;
    taken.add(vertex);
    sites++;
  }
  return sites;
}

/** Terrain for every land hex: one desert at home, gold on the outer islands, balanced resources. */
function assignTerrain(
  rng: GenesisRandom,
  islands: readonly (readonly string[])[],
  params: ArchipelagoParams,
): Map<string, string> | null {
  const terrain = new Map<string, string>();
  const home = must(islands[0], 'home island');
  // The desert goes to the home hex with the most home neighbours (a heart, not a shore).
  const inner = (id: string) => neighborIds(coordOf(id)).filter((n) => home.includes(n)).length;
  const deepest = Math.max(...home.map(inner));
  terrain.set(rng.pick(home.filter((id) => inner(id) === deepest)), 'desert');
  // Gold: round-robin over the outer islands, at most half an island (at least one hex).
  const outer = islands.slice(1).map((members) => [...members]);
  const room = outer.map((members) => Math.max(1, Math.floor(members.length / 2)));
  const order = rng.shuffle(outer.map((_, index) => index));
  let placed = 0;
  for (let round = 0; placed < params.goldFields && round < 8; round++)
    for (const island of order) {
      if (placed >= params.goldFields) break;
      if (must(room[island], 'room') <= round) continue;
      const free = must(outer[island], 'island').filter((id) => !terrain.has(id));
      terrain.set(rng.pick(free), 'gold');
      placed++;
    }
  if (placed < params.goldFields) return null;
  // Resources: keep the global count of each within one, and home as even as its size allows.
  const totals = new Map<string, number>(RESOURCES.map((name) => [name, 0]));
  const give = (id: string) => {
    const least = Math.min(...totals.values());
    const kinds = RESOURCES.filter((name) => totals.get(name) === least);
    const kind = rng.pick(kinds);
    terrain.set(id, kind);
    totals.set(kind, must(totals.get(kind), 'total') + 1);
  };
  for (const id of rng.shuffle(home.filter((hex) => !terrain.has(hex)))) give(id);
  for (const members of islands.slice(1))
    for (const id of rng.shuffle(members.filter((hex) => !terrain.has(hex)))) give(id);
  return terrain;
}

/** Token counts for n tiles, following the base bag's proportions (largest remainder). */
function tokenPool(count: number): number[] {
  const keys = Object.keys(TOKEN_WEIGHT).map(Number);
  const ideal = keys.map((key) => ({
    key,
    share: (count * must(TOKEN_WEIGHT[key], 'weight')) / 18,
  }));
  const counts = new Map(ideal.map((item) => [item.key, Math.floor(item.share)]));
  let left = count - [...counts.values()].reduce((sum, value) => sum + value, 0);
  const byRemainder = ideal.toSorted(
    (a, b) =>
      b.share - Math.floor(b.share) - (a.share - Math.floor(a.share)) ||
      Math.abs(a.key - 7) - Math.abs(b.key - 7),
  );
  for (const item of byRemainder) {
    if (left-- <= 0) break;
    counts.set(item.key, must(counts.get(item.key), 'count') + 1);
  }
  return [...counts].flatMap(([key, amount]) => Array<number>(amount).fill(key));
}

/** Assign tokens with bounded backtracking: no adjacent red numbers or equal numbers, no 2 or 12 on gold. */
function assignTokens(
  rng: GenesisRandom,
  terrain: ReadonlyMap<string, string>,
): Map<string, number> | null {
  const tiles = [...terrain].filter(([, kind]) => kind !== 'desert').map(([id]) => id);
  const near = new Map(
    tiles.map((id) => [id, neighborIds(coordOf(id)).filter((next) => tiles.includes(next))]),
  );
  const order = rng
    .shuffle(tiles)
    .toSorted((a, b) => must(near.get(b), 'near').length - must(near.get(a), 'near').length);
  const remaining = new Map<number, number>();
  for (const token of tokenPool(tiles.length))
    remaining.set(token, (remaining.get(token) ?? 0) + 1);
  const assigned = new Map<string, number>();
  let steps = 0;
  const search = (depth: number): boolean => {
    if (depth === order.length) return true;
    if (steps++ > 6000) return false;
    const id = must(order[depth], 'tile');
    for (const token of rng.shuffle([...remaining.keys()])) {
      if ((remaining.get(token) ?? 0) === 0) continue;
      if (terrain.get(id) === 'gold' && (token === 2 || token === 12)) continue;
      const clash = must(near.get(id), 'near').some((next) => {
        const other = assigned.get(next);
        return (
          other !== undefined &&
          (other === token || ((token === 6 || token === 8) && (other === 6 || other === 8)))
        );
      });
      if (clash) continue;
      assigned.set(id, token);
      remaining.set(token, must(remaining.get(token), 'count') - 1);
      if (search(depth + 1)) return true;
      remaining.set(token, must(remaining.get(token), 'count') + 1);
      assigned.delete(id);
    }
    return false;
  };
  return search(0) ? assigned : null;
}

/** Average pips per hex of each resource, over resource hexes only. */
function resourcePips(hexes: readonly BoardHex[]): number[] {
  return RESOURCES.map((kind) => {
    const own = hexes.filter((hex) => hex.terrain === kind);
    return own.length === 0
      ? 0
      : own.reduce((sum, hex) => sum + (TOKEN_PIPS[hex.token ?? 0] ?? 0), 0) / own.length;
  });
}

/** The sea hex furthest from any land, nearest the centre on ties: where the pirate starts. */
export function pirateStartHex(hexes: readonly BoardHex[]): string {
  const known = new Map(hexes.map((hex) => [hex.id, hex]));
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const hex of hexes)
    if (isLandTerrain(hex.terrain)) {
      distance.set(hex.id, 0);
      queue.push(hex.id);
    }
  for (let head = 0; head < queue.length; head++) {
    const id = must(queue[head], 'queue');
    for (const next of neighborIds(coordOf(id)))
      if (known.has(next) && !distance.has(next)) {
        distance.set(next, must(distance.get(id), 'distance') + 1);
        queue.push(next);
      }
  }
  const centre = hexes.reduce(
    (sum, hex) => ({
      x: sum.x + pixel(hex).x / hexes.length,
      y: sum.y + pixel(hex).y / hexes.length,
    }),
    { x: 0, y: 0 },
  );
  const off = (hex: BoardHex) => Math.hypot(pixel(hex).x - centre.x, pixel(hex).y - centre.y);
  const sea = hexes.filter((hex) => !isLandTerrain(hex.terrain));
  const best = sea.toSorted(
    (a, b) =>
      (distance.get(b.id) ?? 0) - (distance.get(a.id) ?? 0) ||
      off(a) - off(b) ||
      (a.id < b.id ? -1 : 1),
  )[0];
  return must(best, 'sea hex').id;
}

/** Choose harbor edges: about half at home, the rest spread over the outer islands, no shared vertex. */
function placeHarbors(
  rng: GenesisRandom,
  hexes: readonly BoardHex[],
  islands: readonly Island[],
  homeId: string,
  kinds: readonly string[],
): { edge: string; kind: string }[] | null {
  const graph = buildBoardGraph(hexes);
  const coast = coastalEdges(hexes);
  const byIsland = islands.map((island) => {
    const members = new Set<string>(island.hexes);
    return coast.filter((edge) =>
      must(graph.edgeHexes[must(graph.edgeIndex[edge], 'edge')], 'owners').some((id) =>
        members.has(id),
      ),
    );
  });
  const homeIndex = islands.findIndex((island) => island.hexes.some((id) => id === homeId));
  const order = [
    homeIndex,
    ...islands
      .map((island, index) => ({ index, size: island.hexes.length }))
      .filter((item) => item.index !== homeIndex)
      .toSorted((a, b) => b.size - a.size || a.index - b.index)
      .map((item) => item.index),
  ];
  const quota = new Map(order.map((index) => [index, 0]));
  quota.set(homeIndex, Math.ceil(kinds.length / 2));
  let left = kinds.length - must(quota.get(homeIndex), 'quota');
  for (let round = 0; left > 0 && round < 2; round++)
    for (const index of order.slice(1)) {
      if (left === 0) break;
      quota.set(index, must(quota.get(index), 'quota') + 1);
      left--;
    }
  if (left > 0) return null;
  const used = new Set<string>();
  const picked: EdgeId[] = [];
  for (const index of order) {
    const mine: EdgeId[] = [];
    const edges = must(byIsland[index], 'coast');
    for (let step = 0; step < must(quota.get(index), 'quota'); step++) {
      const open = edges.filter(
        (edge) =>
          !mine.includes(edge) &&
          must(graph.edgeVertices[must(graph.edgeIndex[edge], 'edge')], 'ends').every(
            (vertex) => !used.has(vertex),
          ),
      );
      if (open.length === 0) return null;
      let choice: EdgeId;
      if (mine.length === 0) choice = rng.pick(open);
      else {
        const spread = (edge: EdgeId) =>
          Math.min(
            ...mine.map((other) =>
              Math.hypot(edgeMid(edge).x - edgeMid(other).x, edgeMid(edge).y - edgeMid(other).y),
            ),
          );
        choice = must(
          open.toSorted((a, b) => spread(b) - spread(a) || (a < b ? -1 : 1))[0],
          'harbor edge',
        );
      }
      mine.push(choice);
      for (const vertex of must(graph.edgeVertices[must(graph.edgeIndex[choice], 'edge')], 'ends'))
        used.add(vertex);
    }
    picked.push(...mine);
  }
  const shuffled = rng.shuffle(kinds);
  return picked.map((edge, index) => ({ edge, kind: must(shuffled[index], 'harbor kind') }));
}

/**
 * Everything the generator promises, checked on a finished board. Returns human-readable
 * problems, empty when the board is sound. The home island is the largest one.
 */
export function archipelagoProblems(board: BoardState, params: ArchipelagoParams): string[] {
  const problems: string[] = [];
  const islands = detectIslands(board.hexes);
  const ranked = islands.toSorted((a, b) => b.hexes.length - a.hexes.length);
  const home = ranked[0];
  const outer = ranked.slice(1);
  const byId = new Map(board.hexes.map((hex) => [hex.id, hex]));
  if (!home || home.hexes.length < params.homeSize.min || home.hexes.length > params.homeSize.max)
    problems.push(
      `home island size ${home?.hexes.length} outside ${JSON.stringify(params.homeSize)}`,
    );
  if (outer.length < params.islands.min || outer.length > params.islands.max)
    problems.push(`${outer.length} outer islands outside ${JSON.stringify(params.islands)}`);
  for (const island of outer)
    if (island.hexes.length < params.islandSize.min || island.hexes.length > params.islandSize.max)
      problems.push(`island ${island.id} has ${island.hexes.length} hexes`);
  if (!seaIsConnected(board.hexes)) problems.push('sea is not one connected body');
  const gold = board.hexes.filter((hex) => hex.terrain === 'gold');
  if (gold.length !== params.goldFields) problems.push(`${gold.length} gold fields`);
  if (home && gold.some((hex) => home.hexes.some((id) => id === hex.id)))
    problems.push('gold on the home island');
  const deserts = board.hexes.filter((hex) => hex.terrain === 'desert');
  if (deserts.length !== 1 || (home && !home.hexes.some((id) => id === deserts[0]?.id)))
    problems.push('the desert must be a single hex on the home island');
  if (board.robberHex !== deserts[0]?.id) problems.push('robber is not on the desert');
  if (home && settlementSites(home.hexes.map((id) => coordOf(id))) < params.homeSites)
    problems.push('home island is too small for setup');
  for (const hex of board.hexes) {
    const tokenless = hex.terrain === 'desert' || !isLandTerrain(hex.terrain);
    if (tokenless !== (hex.token === null)) problems.push(`${hex.id}: bad token`);
    if (hex.terrain === 'gold' && (hex.token === 2 || hex.token === 12))
      problems.push(`${hex.id}: gold on ${hex.token}`);
    if (hex.token === null) continue;
    for (const next of neighborIds(hex)) {
      const other = byId.get(next);
      if (!other || other.token === null || other.id < hex.id) continue;
      if (isRed(hex.token) && isRed(other.token)) problems.push(`${hex.id}/${next}: adjacent 6/8`);
      if (hex.token === other.token) problems.push(`${hex.id}/${next}: adjacent equal tokens`);
    }
  }
  const pips = resourcePips(board.hexes);
  if (Math.max(...pips) - Math.min(...pips) > 1) problems.push(`pip spread ${pips.join(',')}`);
  if (home)
    for (const kind of RESOURCES)
      if (!home.hexes.some((id) => byId.get(id)?.terrain === kind))
        problems.push(`home island lacks ${kind}`);
  const coast = new Set<string>(coastalEdges(board.hexes));
  const graph = buildBoardGraph(board.hexes);
  const corners = new Set<string>();
  if (board.harbors.length !== params.harbors.length) problems.push('wrong harbor count');
  for (const { edge } of board.harbors) {
    if (!coast.has(edge)) problems.push(`${edge}: harbor not on a coastal edge`);
    for (const vertex of graph.edgeVertices[graph.edgeIndex[edge] ?? -1] ?? []) {
      if (corners.has(vertex)) problems.push(`${edge}: harbors share ${vertex}`);
      corners.add(vertex);
    }
  }
  const kinds = board.harbors.map((harbor) => harbor.kind).toSorted();
  if (kinds.join() !== [...params.harbors].toSorted().join()) problems.push('wrong harbor kinds');
  const pirate = pirateStartHex(board.hexes);
  if (isLandTerrain(must(byId.get(pirate), 'pirate hex').terrain)) problems.push('pirate on land');
  return problems;
}

/** Tokens are re-rolled this many times per layout before the layout is abandoned. */
const TOKEN_ROLLS = 24;

/** Generate an archipelago board and its genesis facts. Throws if no attempt satisfies the rules. */
export function generateArchipelagoLayout(
  rng: GenesisRandom,
  params: ArchipelagoParams = ARCHIPELAGO_STANDARD,
): Archipelago {
  for (let attempt = 0; attempt < params.maxAttempts; attempt++) {
    const islands = growIslands(rng, params);
    if (!islands) continue;
    const terrain = assignTerrain(rng, islands, params);
    if (!terrain) continue;
    const homeHexes = must(islands[0], 'home island');
    const shape: BoardHex[] = [];
    for (let row = 0; row < params.rows; row++)
      for (let col = 0; col < params.cols; col++) {
        const at = cellCoord(col, row);
        const id = hexId(at);
        shape.push({ id, ...at, terrain: terrain.get(id) ?? 'sea', token: null });
      }
    const harbors = placeHarbors(
      rng,
      shape,
      detectIslands(shape),
      must(homeHexes[0], 'home hex'),
      params.harbors,
    );
    if (!harbors) continue;
    for (let roll = 0; roll < TOKEN_ROLLS; roll++) {
      const tokens = assignTokens(rng, terrain);
      if (!tokens) continue;
      const board: BoardState = {
        hexes: shape.map((hex) => ({ ...hex, token: tokens.get(hex.id) ?? null })),
        harbors,
        roads: [],
        buildings: [],
        robberHex: [...terrain].find(([, kind]) => kind === 'desert')?.[0] ?? null,
      };
      if (archipelagoProblems(board, params).length > 0) continue;
      return {
        board,
        pirateHex: pirateStartHex(board.hexes),
        homeHexes,
        islands: islands.map((members) => [...members]),
      };
    }
  }
  throw new Error('Archipelago: no board satisfied the constraints');
}

/** Generate just the board. See `generateArchipelagoLayout` for the pirate start and home island. */
export function generateArchipelago(
  rng: GenesisRandom,
  params: ArchipelagoParams = ARCHIPELAGO_STANDARD,
): BoardState {
  return generateArchipelagoLayout(rng, params).board;
}
