import { hexId } from '@cp2p/engine/geometry';
import { emptyMap, mapFromScenario, scenarioById, validateMap } from '@cp2p/maps';
import type { MapDef } from '@cp2p/maps';
import { describe, expect, test } from 'vitest';
import {
  applyAction,
  boundsCells,
  cellCoord,
  centredBounds,
  fitBounds,
  offsetOf,
  perform,
  redo,
  startHistory,
  undo,
} from './document';
import type { EditorDoc } from './document';
import { canvasHexes, editorRenderModel, harborEdges } from './view';

function classic(): MapDef {
  const scenario = scenarioById('standard-fixed');
  const map = scenario && mapFromScenario(scenario, 'Classic');
  if (!map) throw new Error('missing');
  return map;
}

const doc = (map: MapDef): EditorDoc => startHistory({ map, bounds: fitBounds(map) }).present;
const at = (q: number, r: number) => ({ q, r });
const find = (d: EditorDoc, q: number, r: number) =>
  d.map.hexes.find((hex) => hexId(hex) === hexId({ q, r }));

describe('canvas geometry', () => {
  test('offset and axial coordinates convert both ways', () => {
    for (const [col, row] of [
      [0, 0],
      [3, 1],
      [-2, -3],
      [5, 4],
    ] as const)
      expect(offsetOf(cellCoord(col, row))).toEqual({ col, row });
  });

  test('a classic map gets a ring of open water; the canvas covers every hex', () => {
    const map = classic();
    const bounds = fitBounds(map);
    const cells = new Set(boundsCells(bounds).map(hexId));
    for (const hex of map.hexes) expect(cells.has(hexId(hex))).toBe(true);
    expect(canvasHexes({ map, bounds }).filter((hex) => hex.terrain === 'sea').length).toBe(
      cells.size - 19,
    );
    expect(boundsCells(centredBounds(9, 7))).toHaveLength(63);
  });
});

describe('editing actions', () => {
  test('painting keeps a producing number, a desert drops it, and erasing removes land', () => {
    let d = doc(classic());
    const hex = d.map.hexes.find((item) => item.token !== null);
    if (!hex) throw new Error('no numbered hex');
    d = applyAction(d, { type: 'paint', at: hex, terrain: 'mountains' });
    expect(find(d, hex.q, hex.r)).toMatchObject({ terrain: 'mountains', token: hex.token });
    d = applyAction(d, { type: 'paint', at: hex, terrain: 'desert' });
    expect(find(d, hex.q, hex.r)?.token).toBeNull();
    d = applyAction(d, { type: 'erase', at: hex });
    expect(find(d, hex.q, hex.r)).toBeUndefined();
    // Painting off the canvas does nothing.
    expect(applyAction(d, { type: 'paint', at: at(40, 0), terrain: 'forest' })).toBe(d);
  });

  test('numbers cycle through 2–12 without 7 and back to none', () => {
    let d = applyAction(doc(emptyMap('x')), { type: 'paint', at: at(0, 0), terrain: 'forest' });
    const seen: (number | null)[] = [];
    for (let step = 0; step < 11; step++) {
      d = applyAction(d, { type: 'cycle-token', at: at(0, 0), step: 1 });
      seen.push(find(d, 0, 0)?.token ?? null);
    }
    expect(seen).toEqual([2, 3, 4, 5, 6, 8, 9, 10, 11, 12, null]);
    d = applyAction(d, { type: 'cycle-token', at: at(0, 0), step: -1 });
    expect(find(d, 0, 0)?.token).toBe(12);
  });

  test('harbors toggle and change kind on coastal edges, and go with their land', () => {
    let d = applyAction(doc(emptyMap('x')), { type: 'paint', at: at(0, 0), terrain: 'forest' });
    const [edge] = harborEdges(d);
    if (!edge) throw new Error('no coast');
    d = applyAction(d, { type: 'harbor', edge, kind: 'ore' });
    expect(d.map.harbors).toEqual([{ edge, kind: 'ore' }]);
    d = applyAction(d, { type: 'harbor', edge, kind: 'wool' });
    expect(d.map.harbors).toEqual([{ edge, kind: 'wool' }]);
    d = applyAction(d, { type: 'harbor', edge, kind: 'wool' });
    expect(d.map.harbors).toEqual([]);
    d = applyAction(d, { type: 'harbor', edge, kind: 'grain' });
    d = applyAction(d, { type: 'erase', at: at(0, 0) });
    expect(d.map.harbors).toEqual([]);
  });

  test('turning on seafaring fills the canvas with sea; fog brings a stack; off again drops it', () => {
    let d = applyAction(doc(classic()), { type: 'modules', modules: ['seafaring'] });
    expect(d.map.hexes.some((hex) => hex.terrain === 'sea')).toBe(true);
    expect(canvasHexes(d)).toHaveLength(d.map.hexes.length);
    const sea = d.map.hexes.find((hex) => hex.terrain === 'sea');
    if (!sea) throw new Error('no sea');
    d = applyAction(d, { type: 'paint', at: sea, terrain: 'fog' });
    expect(d.map.fog).not.toBeNull();
    d = applyAction(d, { type: 'pirate', at: sea });
    expect(d.map.pirate).toBeNull(); // the hex is fog now, not sea
    d = applyAction(d, { type: 'modules', modules: [] });
    expect(d.map.hexes.some((hex) => hex.terrain === 'sea')).toBe(false);
    expect(d.map.fog).toBeNull();
    expect(validateMap(d.map).errors.map((p) => p.code)).toContain('terrain-needs-seafaring');
  });

  test('setup areas toggle per land hex and reset to anywhere', () => {
    let d = applyAction(doc(classic()), { type: 'modules', modules: ['seafaring'] });
    d = applyAction(d, { type: 'toggle-setup', at: at(0, 0) });
    expect(d.map.setupAreas).toEqual(['h:0,0']);
    d = applyAction(d, { type: 'toggle-setup', at: at(0, 0) });
    expect(d.map.setupAreas).toBeNull();
    d = applyAction(d, { type: 'toggle-setup', at: at(0, 0) });
    d = applyAction(d, { type: 'setup-all' });
    expect(d.map.setupAreas).toBeNull();
  });

  test('resizing keeps the middle and clamps the size', () => {
    const d = applyAction(doc(classic()), { type: 'resize', cols: 30, rows: 1 });
    const cells = boundsCells(d.bounds);
    expect(cells).toHaveLength(17 * 3);
    expect(cells.some((cell) => cell.q === 0 && cell.r === 0)).toBe(true);
  });
});

describe('history', () => {
  test('undo and redo walk the command stack; no-op actions are not recorded', () => {
    let history = startHistory({ map: emptyMap('x'), bounds: centredBounds(5, 5) });
    history = perform(history, { type: 'paint', at: at(0, 0), terrain: 'hills' });
    history = perform(history, { type: 'paint', at: at(1, 0), terrain: 'forest' });
    history = perform(history, { type: 'paint', at: at(1, 0), terrain: 'forest' });
    expect(history.past).toHaveLength(2);
    history = undo(history);
    expect(history.present.map.hexes).toHaveLength(1);
    history = undo(undo(history));
    expect(history.present.map.hexes).toHaveLength(0);
    history = redo(history);
    expect(history.present.map.hexes).toHaveLength(1);
    history = perform(history, { type: 'vp', vpTarget: 12 });
    expect(history.future).toEqual([]);
  });
});

test('the render model draws every canvas cell and marks problems', () => {
  const map = { ...classic(), robber: null };
  const d = doc(map);
  const model = editorRenderModel(d, validateMap(d.map), { showSetup: true });
  expect(model.hexes).toHaveLength(boundsCells(d.bounds).length);
  expect(model.robberHex).toBeNull();
  expect(model.ships).toBeUndefined();
  expect(model.layers?.['map-editor']).toMatchObject({ errors: [] });
});
