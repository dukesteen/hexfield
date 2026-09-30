import { coastalEdges } from '@cp2p/engine';
import { hexId } from '@cp2p/engine/geometry';
import type { EdgeId, HexCoord, HexId } from '@cp2p/engine/geometry';
import type { MapReport } from '@cp2p/maps';
import { MAP_EDITOR_LAYER } from '@cp2p/renderer';
import type { MapEditorOverlay, RenderModel } from '@cp2p/renderer';
import { boundsCells, coordOf } from './document';
import type { EditorDoc } from './document';

/** Every canvas cell as a board hex: the map's own, and open water where it has none. */
export function canvasHexes(doc: EditorDoc): RenderModel['hexes'][number][] {
  const byId = new Map(doc.map.hexes.map((hex) => [hexId(hex), hex]));
  return boundsCells(doc.bounds).map((cell) => {
    const id = hexId(cell);
    const hex = byId.get(id);
    return {
      id,
      q: cell.q,
      r: cell.r,
      terrain: hex?.terrain ?? 'sea',
      token: hex?.token ?? null,
    };
  });
}

/** Coastal edges of the canvas: where a harbor can go. */
export function harborEdges(doc: EditorDoc): EdgeId[] {
  return coastalEdges(canvasHexes(doc));
}

const coords = (ids: readonly string[]): HexCoord[] =>
  ids.flatMap((id) => {
    const coord = coordOf(id);
    return coord ? [coord] : [];
  });

/** The board the editor draws: the canvas, the map's harbors and robber, and its overlay. */
export function editorRenderModel(
  doc: EditorDoc,
  report: MapReport,
  options: { readonly showSetup: boolean },
): RenderModel {
  const hexes = canvasHexes(doc);
  const seafaring = doc.map.modules.includes('seafaring');
  const overlay: MapEditorOverlay = {
    grid: hexes.filter((hex) => hex.terrain === 'sea'),
    setup: options.showSetup && seafaring ? coords(doc.map.setupAreas ?? []) : [],
    errors: coords(report.errors.flatMap((problem) => problem.hexes ?? [])),
    errorEdges: report.errors.flatMap((problem) => problem.edges ?? []).filter(isEdgeId),
    warnings: coords(report.warnings.flatMap((problem) => problem.hexes ?? [])),
  };
  return {
    hexes,
    harbors: doc.map.harbors.flatMap(({ edge, kind }) => (isEdgeId(edge) ? [{ edge, kind }] : [])),
    roads: [],
    buildings: [],
    robberHex: isHexId(doc.map.robber) ? doc.map.robber : null,
    ...(seafaring ? { ships: [], pirateHex: isHexId(doc.map.pirate) ? doc.map.pirate : null } : {}),
    layers: { [MAP_EDITOR_LAYER]: overlay },
  };
}

function isEdgeId(value: string): value is EdgeId {
  return /^e:-?\d+,-?\d+,(?:NE|NW|W)$/.test(value);
}

function isHexId(value: string | null): value is HexId {
  return value !== null && /^h:-?\d+,-?\d+$/.test(value);
}
