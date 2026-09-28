import type { Container } from 'pixi.js';
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
  /** Non-hex board pieces such as a two-hex track. Rules ignore them; the camera fits them. */
  readonly fixtures?: readonly RenderFixture[];
  /** Per-plugin render-model slices, keyed by plugin layer id. */
  readonly layers?: Readonly<Record<string, unknown>>;
}

/** A board fixture in board coordinates. The footprint lists the anchor first. */
export interface RenderFixture {
  readonly id: string;
  readonly module: string;
  readonly footprint: readonly { readonly q: number; readonly r: number }[];
  readonly orientation: number;
  readonly art: string;
}

/** Drawing context shared with fixture art and plugin layers. */
export interface RenderLayerContext {
  readonly hexSize: number;
  readonly theme: 'light' | 'dark';
  readonly reducedMotion: boolean;
}

/**
 * A module renderer layer. `fixtures` sits above the sea and below terrain; `pieces` sits
 * above buildings and the robber (for pieces on fixtures, such as a ship on its track);
 * `overlay` sits above effects. Within a band, lower zIndex draws first.
 */
export interface RenderLayerPlugin {
  readonly id: string;
  readonly band: 'fixtures' | 'pieces' | 'overlay';
  readonly zIndex: number;
  /** Draw this plugin's slice (`RenderModel.layers[id]`) into a fresh container. */
  draw(target: Container, slice: unknown, context: RenderLayerContext): void;
}

/** Draws one fixture's art in the fixtures band. */
export type FixtureArt = (fixture: RenderFixture, context: RenderLayerContext) => Container;

export type BoardHit =
  | { readonly kind: 'hex'; readonly id: HexId }
  | { readonly kind: 'vertex'; readonly id: VertexId }
  | { readonly kind: 'edge'; readonly id: EdgeId };

export type HitMode = BoardHit['kind'] | 'any';

/** Base-game development-card identities with original renderer artwork. */
export type DevelopmentCard =
  | 'knight'
  | 'roadBuilding'
  | 'yearOfPlenty'
  | 'monopoly'
  | 'victoryPoint';

/** The supplied IDs are the currently legal targets, not all board locations. */
export interface BoardHighlights {
  readonly vertices?: readonly VertexId[];
  readonly edges?: readonly EdgeId[];
  readonly hexes?: readonly HexId[];
  readonly mode?: HitMode;
  readonly style?: {
    readonly color?: number;
    readonly pulse?: boolean;
    /** Empty settlement sites or existing settlements available for city upgrade. */
    readonly vertexTarget?: 'site' | 'upgrade';
  };
}

export interface BoardAppearance {
  readonly theme: 'light' | 'dark';
  readonly players: readonly {
    readonly seat: Seat;
    readonly color: number;
    readonly marker: 'circle' | 'triangle' | 'square' | 'diamond' | 'hexagon' | 'star';
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
  /** A tap on a fixture's footprint that selected no other board target. */
  readonly onFixtureSelect?: (fixtureId: string) => void;
  /** Module plugin layers, drawn in their band by zIndex. */
  readonly layers?: readonly RenderLayerPlugin[];
  /** Fixture art by `RenderFixture.art`; unknown art uses a generic track. */
  readonly fixtureArt?: Readonly<Record<string, FixtureArt>>;
  readonly onHover?: (hit: BoardHit | null) => void;
  readonly onReady?: (renderer: BoardRenderer) => void;
}

/** Read-only counters for acceptance and performance diagnostics. */
export interface BoardRendererDiagnostics {
  readonly renderedFrames: number;
  readonly rebuiltLayers: number;
  readonly activeEffects: number;
  readonly queuedDisposals: number;
}

export interface BoardFocusPreview {
  /** Temporary, uncommitted piece shown at the focused legal target. */
  readonly piece: 'road' | 'settlement' | 'city';
  /** The active player's public board color. */
  readonly color: number;
  /** Player marker shape, used behind building previews. */
  readonly marker?: BoardAppearance['players'][number]['marker'];
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** A rules-neutral visual cue. IDs are stable per public event and deduplicated briefly. */
export type BoardEffect =
  | { readonly id: string; readonly kind: 'dice-roll'; readonly dice: readonly [number, number] }
  | { readonly id: string; readonly kind: 'production-pulse'; readonly hexes: readonly HexId[] }
  | {
      readonly id: string;
      readonly kind: 'piece-pop';
      readonly piece: 'road' | 'settlement' | 'city';
      readonly seat: Seat;
      readonly at: BoardHit;
    }
  | {
      readonly id: string;
      readonly kind: 'robber-move';
      readonly fromHex: HexId;
      readonly toHex: HexId;
    };

export interface BoardRenderer {
  render(model: RenderModel): void;
  setHighlights(highlights: BoardHighlights): void;
  /** Highlight a keyboard-selected target in board coordinates. */
  setFocusTarget(hit: BoardHit | null, preview?: BoardFocusPreview): void;
  setAppearance(appearance: BoardAppearance): void;
  setReducedMotion(reduced: boolean): void;
  /** Play public, board-contained effects; repeated IDs are ignored. */
  playEffects(effects: readonly BoardEffect[]): void;
  /** Immediately removes all active effects. */
  skipAnimations(): void;
  getDiagnostics(): BoardRendererDiagnostics;
  setHarborLabelFormatter(formatter: (kind: string) => string): void;
  /** Input coordinates are CSS client coordinates. */
  hitTest(clientPoint: ScreenPoint, mode?: HitMode): BoardHit | null;
  /** Subscribe to camera or viewport changes; the listener fires once immediately. */
  subscribeViewChange(listener: () => void): () => void;
  /** Returns a target center in CSS client coordinates. */
  getPixelPosition(hit: BoardHit): ScreenPoint;
  /** Board points use engine geometry's local pixel basis. */
  boardToScreen(point: ScreenPoint): ScreenPoint;
  /** Converts CSS client coordinates into board-local pixels. */
  screenToBoard(clientPoint: ScreenPoint): ScreenPoint;
  fitToBoard(): void;
  destroy(): void;
}
