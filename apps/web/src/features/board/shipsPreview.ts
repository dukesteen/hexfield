import { buildBoardGraph, hexId } from '@cp2p/engine/geometry';
import type { EdgeId, VertexId } from '@cp2p/engine/geometry';
import type { RenderModel } from '@cp2p/renderer';

/** Land hexes of the ship preview: a crowded one-hex island and a harbor island. */
const LAND = [
  { q: 0, r: 0, terrain: 'pasture', token: 6 },
  { q: 3, r: -1, terrain: 'fields', token: 9 },
] as const;

/** Six ships around the first island, one per heading, each beside the blue settlement or city. */
const SHIPS: readonly { readonly edge: EdgeId; readonly seat: 0 | 1 }[] = [
  { edge: 'e:1,-1,W', seat: 0 },
  { edge: 'e:0,0,NE', seat: 0 },
  { edge: 'e:0,0,NW', seat: 0 },
  { edge: 'e:0,1,W', seat: 0 },
  { edge: 'e:0,1,NW', seat: 0 },
  { edge: 'e:-1,1,NE', seat: 0 },
  { edge: 'e:2,-1,NE', seat: 1 },
];

const BUILDINGS: readonly {
  readonly vertex: VertexId;
  readonly seat: 0 | 1 | 2 | 3;
  readonly kind: 'settlement' | 'city';
}[] = [
  { vertex: 'v:0,0,N', seat: 0, kind: 'settlement' },
  { vertex: 'v:0,0,S', seat: 0, kind: 'city' },
  // Other players' pieces at the far end of every ship, the tightest fit a ship can have.
  { vertex: 'v:1,-2,S', seat: 2, kind: 'settlement' },
  { vertex: 'v:1,-1,S', seat: 2, kind: 'city' },
  { vertex: 'v:0,-1,S', seat: 3, kind: 'settlement' },
  { vertex: 'v:-1,2,N', seat: 3, kind: 'city' },
  { vertex: 'v:0,1,N', seat: 2, kind: 'settlement' },
  { vertex: 'v:-1,1,N', seat: 3, kind: 'city' },
  { vertex: 'v:3,-2,S', seat: 1, kind: 'city' },
];

/**
 * A development board for checking ships and bonus chits by eye: ships on both headings of all
 * three edge lines, wedged between buildings, and a bonus chit beside a city whose coast has a
 * harbor, a road and a ship next to it.
 */
export function shipsPreviewModel(): RenderModel {
  const cells: { q: number; r: number }[] = [];
  const near = (q: number, r: number) =>
    LAND.some(
      (hex) =>
        Math.max(Math.abs(q - hex.q), Math.abs(r - hex.r), Math.abs(q + r - hex.q - hex.r)) <= 2,
    );
  for (let q = -3; q <= 6; q++) for (let r = -4; r <= 3; r++) if (near(q, r)) cells.push({ q, r });
  const graph = buildBoardGraph(cells);
  const land = new Map<string, (typeof LAND)[number]>(LAND.map((hex) => [hexId(hex), hex]));
  const hexes = cells.map((cell) => {
    const id = graph.hexIds.find((candidate) => candidate === hexId(cell));
    if (!id) throw new Error(`Missing preview hex ${hexId(cell)}`);
    const found = land.get(id);
    return { id, ...cell, terrain: found?.terrain ?? 'sea', token: found?.token ?? null };
  });
  return {
    hexes,
    harbors: [
      { edge: 'e:3,-1,NW', kind: 'grain' },
      { edge: 'e:1,0,W', kind: 'generic' },
    ],
    roads: [{ edge: 'e:3,-1,W', seat: 1 }],
    buildings: BUILDINGS,
    ships: SHIPS,
    islandBonuses: [
      { vertex: 'v:3,-2,S', seat: 1, vp: 1 },
      { vertex: 'v:0,0,S', seat: 0, vp: 2 },
    ],
    pirateHex: null,
    robberHex: null,
  };
}
