import { isLandTerrain } from '@cp2p/engine';
import { buildBoardGraph, hexId } from '@cp2p/engine/geometry';
import type { HexCoord } from '@cp2p/engine/geometry';
import { MAP_TOKENS, canonicalMap, defaultFogStack, isTokenless } from '@cp2p/maps';
import type { HarborKind, MapDef, MapFog, MapHex, MapModule, MapTerrain } from '@cp2p/maps';

/** The canvas: an inclusive rectangle of offset cells (odd rows sit half a hex right). */
export interface Bounds {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** What the editor edits: the map and the canvas it is drawn on. */
export interface EditorDoc {
  readonly map: MapDef;
  readonly bounds: Bounds;
}

export const MIN_SIZE = 3;
export const MAX_SIZE = 17;

/** Axial coordinates of an offset cell. */
export function cellCoord(col: number, row: number): HexCoord {
  return { q: col - (row - (row & 1)) / 2, r: row };
}

/** Offset cell of an axial hex. */
export function offsetOf({ q, r }: HexCoord): { col: number; row: number } {
  return { col: q + (r - (r & 1)) / 2, row: r };
}

export function boundsCells(bounds: Bounds): HexCoord[] {
  const cells: HexCoord[] = [];
  for (let row = bounds.top; row <= bounds.bottom; row++)
    for (let col = bounds.left; col <= bounds.right; col++) cells.push(cellCoord(col, row));
  return cells;
}

export function boundsSize(bounds: Bounds): { cols: number; rows: number } {
  return { cols: bounds.right - bounds.left + 1, rows: bounds.bottom - bounds.top + 1 };
}

/** A canvas of `cols` × `rows` cells around the origin. */
export function centredBounds(cols: number, rows: number): Bounds {
  const c = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(cols)));
  const r = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(rows)));
  const left = -Math.floor((c - 1) / 2);
  const top = -Math.floor((r - 1) / 2);
  return { left, right: left + c - 1, top, bottom: top + r - 1 };
}

const inside = (bounds: Bounds, coord: HexCoord): boolean => {
  const { col, row } = offsetOf(coord);
  return col >= bounds.left && col <= bounds.right && row >= bounds.top && row <= bounds.bottom;
};

/**
 * The smallest canvas around a map: exactly its hexes on a seafaring map (it lists its own sea),
 * with one cell of open water around a classic map.
 */
export function fitBounds(map: MapDef): Bounds {
  if (map.hexes.length === 0) return centredBounds(9, 7);
  const cells = map.hexes.map(offsetOf);
  const margin = map.modules.includes('seafaring') ? 0 : 1;
  return {
    left: Math.min(...cells.map((cell) => cell.col)) - margin,
    right: Math.max(...cells.map((cell) => cell.col)) + margin,
    top: Math.min(...cells.map((cell) => cell.row)) - margin,
    bottom: Math.max(...cells.map((cell) => cell.row)) + margin,
  };
}

const isSeafaring = (map: MapDef): boolean => map.modules.includes('seafaring');

/** Edges of a hex, by the engine's graph. */
function hexEdges(coord: HexCoord): string[] {
  const graph = buildBoardGraph([coord]);
  return [...(graph.hexEdges[0] ?? [])];
}

/**
 * Keep a document consistent after any change: a seafaring map fills its canvas with sea, a classic
 * map lists only land; references to hexes that are gone are dropped, tokenless terrain loses its
 * token, and a fog stack comes with the first fog hex and goes with the last.
 */
export function normalize(doc: EditorDoc): EditorDoc {
  const { map, bounds } = doc;
  const seafaring = isSeafaring(map);
  const byId = new Map(
    map.hexes.filter((hex) => inside(bounds, hex)).map((hex) => [hexId(hex), hex]),
  );
  if (seafaring)
    for (const cell of boundsCells(bounds))
      if (!byId.has(hexId(cell))) byId.set(hexId(cell), { ...cell, terrain: 'sea', token: null });
  const hexes = [...byId.values()]
    .filter((hex) => seafaring || hex.terrain !== 'sea')
    .map((hex) => (isTokenless(hex.terrain) && hex.token !== null ? { ...hex, token: null } : hex));
  const kept = new Map<string, MapHex>(hexes.map((hex) => [hexId(hex), hex]));
  const land = new Set<string>(
    hexes.filter((hex) => isLandTerrain(hex.terrain)).map((hex) => hexId(hex)),
  );
  const graph = buildBoardGraph(hexes);
  const harbors = map.harbors.filter(({ edge }) => {
    const index = graph.edgeIndex[edge];
    return index !== undefined && (graph.edgeHexes[index] ?? []).some((id) => land.has(id));
  });
  const setup = seafaring && map.setupAreas ? map.setupAreas.filter((id) => land.has(id)) : [];
  const fogHexes = hexes.filter((hex) => hex.terrain === 'fog').length;
  const next: MapDef = {
    ...map,
    hexes,
    harbors,
    robber: map.robber !== null && land.has(map.robber) ? map.robber : null,
    pirate:
      seafaring && map.pirate !== null && kept.get(map.pirate)?.terrain === 'sea'
        ? map.pirate
        : null,
    setupAreas: setup.length > 0 ? setup : null,
    // The first fog hex brings a stack that fits it; later changes are the author's to match.
    fog: seafaring && fogHexes > 0 ? (map.fog ?? defaultFogStack(fogHexes)) : null,
  };
  return { map: canonicalMap(next), bounds };
}

export type EditorAction =
  | { readonly type: 'paint'; readonly at: HexCoord; readonly terrain: MapTerrain }
  | { readonly type: 'cycle-token'; readonly at: HexCoord; readonly step: 1 | -1 }
  | { readonly type: 'harbor'; readonly edge: string; readonly kind: HarborKind }
  | { readonly type: 'erase'; readonly at: HexCoord }
  | { readonly type: 'robber'; readonly at: HexCoord }
  | { readonly type: 'pirate'; readonly at: HexCoord }
  | { readonly type: 'toggle-setup'; readonly at: HexCoord }
  | { readonly type: 'setup-all' }
  | { readonly type: 'modules'; readonly modules: readonly MapModule[] }
  | { readonly type: 'seats'; readonly min: number; readonly max: number }
  | { readonly type: 'vp'; readonly vpTarget: number }
  | { readonly type: 'name'; readonly name: string }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly type: 'fog'; readonly fog: MapFog | null }
  | { readonly type: 'replace'; readonly map: MapDef; readonly bounds?: Bounds };

const TOKEN_CYCLE: readonly MapHex['token'][] = [null, ...MAP_TOKENS];

function withHex(map: MapDef, at: HexCoord, change: (hex: MapHex | undefined) => MapHex | null) {
  const id = hexId(at);
  const old = map.hexes.find((hex) => hexId(hex) === id);
  const next = change(old);
  const others = map.hexes.filter((hex) => hexId(hex) !== id);
  return { ...map, hexes: next ? [...others, next] : others };
}

/** Apply one editing action. Returns the same document when nothing changes. */
export function applyAction(doc: EditorDoc, action: EditorAction): EditorDoc {
  const { map } = doc;
  const edit = (next: MapDef, bounds = doc.bounds): EditorDoc => normalize({ map: next, bounds });
  switch (action.type) {
    case 'paint':
      if (!inside(doc.bounds, action.at)) return doc;
      return edit(
        withHex(map, action.at, (old) => ({
          q: action.at.q,
          r: action.at.r,
          terrain: action.terrain,
          // A tile keeps its number when it swaps for another producing tile.
          token: old && !isTokenless(action.terrain) ? old.token : null,
        })),
      );
    case 'cycle-token':
      return edit(
        withHex(map, action.at, (old) => {
          if (!old || isTokenless(old.terrain)) return old ?? null;
          const index = TOKEN_CYCLE.indexOf(old.token);
          const next =
            TOKEN_CYCLE[(index + action.step + TOKEN_CYCLE.length) % TOKEN_CYCLE.length] ?? null;
          return { ...old, token: next };
        }),
      );
    case 'harbor': {
      const existing = map.harbors.find((harbor) => harbor.edge === action.edge);
      const others = map.harbors.filter((harbor) => harbor.edge !== action.edge);
      // Placing the same kind again removes the harbor; another kind replaces it.
      const harbors =
        existing?.kind === action.kind
          ? others
          : [...others, { edge: action.edge, kind: action.kind }];
      return edit({ ...map, harbors });
    }
    case 'erase': {
      const edges = new Set(hexEdges(action.at));
      const cleared = withHex(map, action.at, (old) =>
        old && isSeafaring(map) ? { ...old, terrain: 'sea', token: null } : null,
      );
      return edit({
        ...cleared,
        harbors: cleared.harbors.filter((harbor) => !edges.has(harbor.edge)),
      });
    }
    case 'robber': {
      const id = hexId(action.at);
      return edit({ ...map, robber: map.robber === id && isSeafaring(map) ? null : id });
    }
    case 'pirate': {
      const id = hexId(action.at);
      return edit({ ...map, pirate: map.pirate === id ? null : id });
    }
    case 'toggle-setup': {
      const id = hexId(action.at);
      const current = map.setupAreas ?? [];
      const setupAreas = current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
      return edit({ ...map, setupAreas: setupAreas.length > 0 ? setupAreas : null });
    }
    case 'setup-all':
      return edit({ ...map, setupAreas: null });
    case 'modules': {
      const modules = [...new Set(action.modules)];
      const next = { ...map, modules };
      // A classic map becomes a seafaring one on a canvas with room for water around it.
      const bounds =
        modules.includes('seafaring') && !isSeafaring(map) ? fitBounds(map) : doc.bounds;
      return edit(next, bounds);
    }
    case 'seats': {
      const min = Math.min(6, Math.max(2, action.min));
      const max = Math.min(6, Math.max(min, action.max));
      return edit({ ...map, seats: { min, max } });
    }
    case 'vp':
      return edit({ ...map, vpTarget: Math.min(20, Math.max(3, Math.round(action.vpTarget))) });
    case 'name':
      return edit({ ...map, name: action.name.slice(0, 60) || map.name });
    case 'resize':
      return edit(map, resized(doc.bounds, action.cols, action.rows));
    case 'fog':
      return edit({ ...map, fog: action.fog });
    case 'replace':
      return edit(action.map, action.bounds ?? fitBounds(action.map));
    default:
      return doc;
  }
}

/** Grow or shrink the canvas symmetrically, keeping what sits in the middle. */
function resized(bounds: Bounds, cols: number, rows: number): Bounds {
  const size = boundsSize(bounds);
  const c = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(cols)));
  const r = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(rows)));
  const dc = c - size.cols;
  const dr = r - size.rows;
  const left = bounds.left - Math.floor(dc / 2);
  const top = bounds.top - Math.floor(dr / 2);
  return { left, right: left + c - 1, top, bottom: top + r - 1 };
}

/** Undo history: past documents, the present one, and the redo stack. */
export interface History {
  readonly past: readonly EditorDoc[];
  readonly present: EditorDoc;
  readonly future: readonly EditorDoc[];
}

const HISTORY_LIMIT = 200;
const same = (a: EditorDoc, b: EditorDoc): boolean => JSON.stringify(a) === JSON.stringify(b);

export function startHistory(doc: EditorDoc): History {
  return { past: [], present: normalize(doc), future: [] };
}

/** Run an action as one undoable step. Actions that change nothing leave the history alone. */
export function perform(history: History, action: EditorAction): History {
  const next = applyAction(history.present, action);
  if (same(next, history.present)) return history;
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
  };
}

export function undo(history: History): History {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo(history: History): History {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}

/** Parse a hex id back to its coordinates. */
export function coordOf(id: string): HexCoord | null {
  const match = /^h:(-?\d+),(-?\d+)$/.exec(id);
  return match ? { q: Number(match[1]), r: Number(match[2]) } : null;
}
