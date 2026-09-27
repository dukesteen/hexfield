// Run after building engine, maps and renderer: node tools/generate-board-preview.mjs
// Keep this a static asset so the home page does not need a second WebGL board.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { BASE_VERSION, createBaseEngine, LocalGame } from '../packages/engine/dist/index.js';
import {
  buildBoardGraph,
  edgeToPixel,
  HEX_DIRECTIONS,
  hexToPixel,
  vertexToPixel,
} from '../packages/engine/dist/geometry.js';
import { standardFixedBoard } from '../packages/maps/dist/index.js';
import { harborLayout } from '../packages/renderer/dist/harborLayout.js';
import { roadVariantForEdge } from '../packages/renderer/dist/roadVariant.js';
import { assignTerrainVariants } from '../packages/renderer/dist/assets/terrainVariants.js';

const engine = createBaseEngine();
const created = LocalGame.create(
  engine,
  {
    modules: [{ id: 'base', version: BASE_VERSION }],
    seats: [0, 1, 2, 3],
    options: { base: { mapLayout: 'standard-fixed' } },
    board: standardFixedBoard(),
  },
  new Uint8Array(32).fill(7),
  {
    resolve: (pending) => {
      assert.equal(pending.systemType, 'START_SEAT', 'Preview must stop before rolling dice');
      return { input: { kind: 'system', type: 'START_SEAT', seat: 0 } };
    },
  },
);
assert(created.ok, JSON.stringify(created));
const game = created.value;
const graph = buildBoardGraph(game.state.board.hexes);

// Play a complete snake setup through the engine. Prefer productive intersections;
// the engine filters occupied/adjacent sites and roads disconnected from the owner.
for (let step = 0; step < 16; step += 1) {
  const pending = game.getPending()[0];
  assert.equal(pending?.kind, 'player');
  const commands = engine.getLegalCommands(game.state, pending.seat).commands;
  const score = (command) => {
    if (typeof command.vertex !== 'string') return 0;
    const index = graph.vertexIndex[command.vertex];
    return graph.vertexHexes[index].reduce((sum, id) => {
      const token = game.state.board.hexes.find((hex) => hex.id === id)?.token;
      return sum + (token ? 6 - Math.abs(7 - token) : 0);
    }, 0);
  };
  const command = commands.toSorted((a, b) => score(b) - score(a))[0];
  assert(command, 'Setup must have a legal move');
  assert(['PLACE_SETTLEMENT', 'PLACE_ROAD'].includes(command.type), command.type);
  const applied = game.submit({ kind: 'command', seat: pending.seat, command });
  assert(applied.ok, JSON.stringify(applied));
}
assert.deepEqual(engine.checkInvariants(game.state), []);
const board = game.state.board;
for (const seat of game.state.config.seats) {
  assert.equal(board.buildings.filter((piece) => piece.seat === seat).length, 2);
  assert.equal(board.roads.filter((piece) => piece.seat === seat).length, 2);
}

const artDirectory = new URL('../packages/renderer/src/assets/redesign/', import.meta.url);
const symbols = new Map();
const layers = [];
const size = 80;
const colors = ['blue', 'orange', 'red', 'white'];
const round = (value) => Number(value.toFixed(3));

// Reuse the original SVG art once per symbol, with namespaced local clip/mask IDs.
function sprite(name, x, y, width, height, anchorX = 0.5, anchorY = 0.5, angle = 0) {
  if (!symbols.has(name)) {
    const source = readFileSync(new URL(`${name}.svg`, artDirectory), 'utf8');
    const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1];
    assert(viewBox, `${name} needs a viewBox`);
    const body = source
      .slice(source.indexOf('>') + 1, source.lastIndexOf('</svg>'))
      .replace(/<metadata[\s\S]*?<\/metadata>/g, '')
      .replace(/\bid="([^"]+)"/g, `id="${name}-$1"`)
      .replace(/url\(#([^)]+)\)/g, `url(#${name}-$1)`)
      .replace(/href="#([^"]+)"/g, `href="#${name}-$1"`);
    symbols.set(name, `<symbol id="${name}" viewBox="${viewBox}">${body}</symbol>`);
  }
  layers.push(
    `<g transform="translate(${round(x)} ${round(y)}) rotate(${round(angle)})"><use href="#${name}" x="${round(-width * anchorX)}" y="${round(-height * anchorY)}" width="${round(width)}" height="${round(height)}"/></g>`,
  );
}

sprite('board-frame', 0, 0, size * 14, size * 13);
sprite('board-underlay', 0, 0, size * 14, size * 13);
const landIds = new Set(board.hexes.map((hex) => hex.id));
const water = new Map();
for (const hex of board.hexes) {
  for (const offset of HEX_DIRECTIONS) {
    const q = hex.q + offset.q;
    const r = hex.r + offset.r;
    const id = `h:${q},${r}`;
    if (!landIds.has(id)) water.set(id, { id, q, r, terrain: 'sea', token: null });
  }
}
const hexes = [...water.values(), ...board.hexes];
const variants = assignTerrainVariants(hexes);
for (const hex of hexes) {
  const center = hexToPixel(hex.q, hex.r, size);
  const name =
    hex.terrain === 'desert' ? 'tile-desert' : `tile-${hex.terrain}-${variants.get(hex.id)}`;
  sprite(name, center.x, center.y, 150, 174);
}
for (const harbor of board.harbors) {
  const index = graph.edgeIndex[harbor.edge];
  const [first, second] = graph.edgeVertices[index].map((vertex) => vertexToPixel(vertex, size));
  const land = board.hexes.find((hex) => graph.edgeHexes[index].includes(hex.id));
  const center = hexToPixel(land.q, land.r, size);
  const layout = harborLayout(first, second, center);
  assert(layout);
  const angle =
    (Math.atan2(layout.midpoint.y - center.y, layout.midpoint.x - center.x) * 180) / Math.PI + 90;
  sprite(
    `harbor-${harbor.kind === 'generic' ? '3to1' : harbor.kind}`,
    layout.hub.x,
    layout.hub.y,
    100,
    100,
    0.5,
    0.23,
    angle,
  );
}
for (const hex of board.hexes) {
  if (hex.token === null) continue;
  const center = hexToPixel(hex.q, hex.r, size);
  sprite(`token-${hex.token}`, center.x, center.y, 50, 50);
}
for (const road of board.roads) {
  const point = edgeToPixel(road.edge, size).midpoint;
  sprite(
    `road-${colors[road.seat]}-${roadVariantForEdge(road.edge) + 1}`,
    point.x,
    point.y,
    51.2,
    51.2,
  );
}
for (const building of board.buildings) {
  const point = vertexToPixel(building.vertex, size);
  sprite(`settlement-${colors[building.seat]}`, point.x, point.y, 40, 40, 0.5, 22 / 40);
}
const robber = board.hexes.find((hex) => hex.id === board.robberHex);
const point = hexToPixel(robber.q, robber.r, size);
sprite('robber', point.x, point.y, 64, 92, 0.5, 70 / 92);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-560 -520 1120 1040">
<!-- Generated by tools/generate-board-preview.mjs from an engine-validated four-player setup. -->
<defs>${[...symbols.values()].join('\n')}</defs>
${layers.join('\n')}
</svg>\n`;
writeFileSync(new URL('board-preview.svg', artDirectory), svg);
console.log(
  `Generated legal preview: ${board.hexes.length} hexes, ${board.harbors.length} harbors, ${board.buildings.length} settlements, ${board.roads.length} roads.`,
);
