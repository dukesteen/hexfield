import type { EdgeId, HexId, VertexId } from '@cp2p/engine/geometry';
import type { Seat } from '@cp2p/engine';

/** Rules-neutral board data consumed by the renderer. */
export interface RenderModel {
  readonly hexes: readonly {
    readonly id: HexId;
    readonly q: number;
    readonly r: number;
    readonly terrain: string;
    readonly token: number | null;
  }[];
  readonly harbors: readonly { readonly edge: EdgeId; readonly kind: string }[];
  readonly roads: readonly { readonly edge: EdgeId; readonly seat: Seat }[];
  readonly buildings: readonly {
    readonly vertex: VertexId;
    readonly seat: Seat;
    readonly kind: 'settlement' | 'city';
  }[];
  readonly robberHex: HexId | null;
  readonly pirateHex?: HexId | null;
}

export type BoardHit =
  | { readonly kind: 'hex'; readonly id: HexId }
  | { readonly kind: 'vertex'; readonly id: VertexId }
  | { readonly kind: 'edge'; readonly id: EdgeId };

export type HitMode = BoardHit['kind'] | 'any';

/** The supplied IDs are the currently legal targets, not all board locations. */
export interface BoardHighlights {
  readonly vertices?: readonly VertexId[];
  readonly edges?: readonly EdgeId[];
  readonly hexes?: readonly HexId[];
  readonly mode?: HitMode;
  readonly style?: {
    readonly color?: number;
    readonly pulse?: boolean;
  };
}

export interface BoardAppearance {
  readonly theme: 'light' | 'dark';
  readonly players: readonly {
    readonly seat: Seat;
    readonly color: number;
    readonly marker: 'circle' | 'triangle' | 'square' | 'diamond';
  }[];
}

export interface BoardRendererOptions {
  readonly hexSize?: number;
  readonly maxPixelRatio?: number;
  readonly reducedMotion?: boolean;
  readonly appearance?: BoardAppearance;
  readonly accessibleLabel?: string;
  readonly formatHarborLabel?: (kind: string) => string;
  readonly onSelect?: (hit: BoardHit) => void;
  readonly onHover?: (hit: BoardHit | null) => void;
  readonly onReady?: (renderer: BoardRenderer) => void;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface BoardRenderer {
  render(model: RenderModel): void;
  setHighlights(highlights: BoardHighlights): void;
  setAppearance(appearance: BoardAppearance): void;
  setReducedMotion(reduced: boolean): void;
  setHarborLabelFormatter(formatter: (kind: string) => string): void;
  /** Input coordinates are CSS client coordinates. */
  hitTest(clientPoint: ScreenPoint, mode?: HitMode): BoardHit | null;
  /** Returns a target center in CSS client coordinates. */
  getPixelPosition(hit: BoardHit): ScreenPoint;
  /** Board points use engine geometry's local pixel basis. */
  boardToScreen(point: ScreenPoint): ScreenPoint;
  /** Converts CSS client coordinates into board-local pixels. */
  screenToBoard(clientPoint: ScreenPoint): ScreenPoint;
  fitToBoard(): void;
  destroy(): void;
}
