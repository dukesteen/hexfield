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
    /** A city wall stands under this city (Cities & Knights). */
    readonly wall?: boolean;
    /** A metropolis of this track stands on this city (Cities & Knights). */
    readonly metropolis?: KnightsTrack;
  }[];
  readonly robberHex: HexId | null;
  /** Ships on sea edges. Present, possibly empty, on seafaring boards. */
  readonly ships?: readonly { readonly edge: EdgeId; readonly seat: Seat }[];
  /** The pirate's sea hex. `null` while it is off the board. */
  readonly pirateHex?: HexId | null;
  /** New-island bonus chits, each drawn beside its settlement. */
  readonly islandBonuses?: readonly {
    readonly vertex: VertexId;
    readonly seat: Seat;
    readonly vp: number;
  }[];
  /** Cities & Knights pieces. Present, possibly empty, on knights boards. */
  readonly knights?: KnightsRender;
  /** Non-hex board pieces such as a two-hex track. Rules ignore them; the camera fits them. */
  readonly fixtures?: readonly RenderFixture[];
  /** Per-plugin render-model slices, keyed by plugin layer id. */
  readonly layers?: Readonly<Record<string, unknown>>;
}

export type KnightsTrack = 'trade' | 'politics' | 'science';

/** The Cities & Knights pieces the board draws: knights, the merchant and the barbarian ship. */
export interface KnightsRender {
  /** Knights on vertices. `ready` marks the active seat's knights that may still act. */
  readonly pieces: readonly {
    readonly vertex: VertexId;
    readonly seat: Seat;
    readonly level: 1 | 2 | 3;
    readonly active: boolean;
    readonly ready?: boolean;
  }[];
  /** The merchant's land hex and the seat that controls it, or null before the first is played. */
  readonly merchant: { readonly hex: HexId; readonly seat: Seat } | null;
  /** City pieces lying on their side: settlements that must be upgraded first. */
  readonly sideways: readonly { readonly vertex: VertexId; readonly seat: Seat }[];
  /** The barbarian ship on the fixture named `fixture`, at `step` of `steps`. */
  readonly barbarians: {
    readonly fixture: string;
    readonly step: number;
    readonly steps: number;
  } | null;
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
    /** Empty settlement sites, settlements available for city upgrade, or rings on pieces. */
    readonly vertexTarget?: 'site' | 'upgrade' | 'piece';
    /**
     * Edge targets as a dashed lane, a brighter wake for open water, or a ring around a piece
     * already there.
     */
    readonly edgeTarget?: 'lane' | 'wake' | 'ring';
  };
  /** Edges of pieces marked as the chosen one, such as the ship about to move. */
  readonly selectedEdges?: readonly EdgeId[];
  /** Vertices of pieces marked as the chosen one, such as the knight about to move. */
  readonly selectedVertices?: readonly VertexId[];
  /** Hexes marked as the chosen one, such as the first of two number tokens to swap. */
  readonly selectedHexes?: readonly HexId[];
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
  /** Load the seafaring art (gold, fog, ships, pirate) before the first draw. */
  readonly seafaring?: boolean;
  /** Load the Cities & Knights art (knights, walls, metropolises, merchant, ship) before the first draw. */
  readonly knights?: boolean;
  /** Outline every island, for debugging generated and revealed boards. */
  readonly debugIslands?: boolean;
}

/** Read-only counters for acceptance and performance diagnostics. */
export interface BoardRendererDiagnostics {
  readonly renderedFrames: number;
  readonly rebuiltLayers: number;
  readonly activeEffects: number;
  /** The kind of each running effect, so a check can see that nothing stacks. */
  readonly activeEffectKinds?: readonly BoardEffect['kind'][];
  readonly queuedDisposals: number;
}

export interface BoardFocusPreview {
  /** Temporary, uncommitted piece shown at the focused legal target. */
  readonly piece: 'road' | 'ship' | 'settlement' | 'city' | 'knight' | 'wall' | 'mark';
  /** For a knight preview: its strength and whether it stands active. */
  readonly knight?: { readonly level: 1 | 2 | 3; readonly active: boolean; readonly seat?: Seat };
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
  | {
      readonly id: string;
      readonly kind: 'dice-roll';
      readonly dice: readonly [number, number];
      /** A knights roll: the first die is red and the event die's face is shown beside them. */
      readonly event?: 'ship' | 'trade' | 'politics' | 'science';
    }
  | { readonly id: string; readonly kind: 'production-pulse'; readonly hexes: readonly HexId[] }
  | {
      readonly id: string;
      readonly kind: 'piece-pop';
      readonly piece: 'road' | 'ship' | 'settlement' | 'city' | 'knight' | 'wall';
      readonly seat: Seat;
      readonly at: BoardHit;
      /** A knight's strength, for its art. */
      readonly level?: 1 | 2 | 3;
    }
  | {
      readonly id: string;
      readonly kind: 'robber-move';
      readonly fromHex: HexId;
      readonly toHex: HexId;
    }
  | {
      readonly id: string;
      readonly kind: 'pirate-move';
      /** `null` when the pirate enters from off the board. */
      readonly fromHex: HexId | null;
      readonly toHex: HexId;
    }
  | {
      readonly id: string;
      readonly kind: 'ship-move';
      readonly seat: Seat;
      readonly fromEdge: EdgeId;
      readonly toEdge: EdgeId;
    }
  | {
      readonly id: string;
      readonly kind: 'knight-move';
      readonly seat: Seat;
      readonly level: 1 | 2 | 3;
      readonly fromVertex: VertexId;
      readonly toVertex: VertexId;
    }
  | {
      readonly id: string;
      readonly kind: 'barbarian-sail';
      readonly fixture: string;
      readonly fromStep: number;
      readonly toStep: number;
      /** Wait this long before sailing, so the dice roll can finish first. */
      readonly delayMs?: number;
    }
  | {
      readonly id: string;
      readonly kind: 'barbarian-attack';
      readonly fixture: string;
      /** The step the ship sailed from before landing. */
      readonly fromStep: number;
      readonly outcome: 'defended' | 'pillaged';
      /** Vertices of the active knights that held the line. */
      readonly defenders: readonly VertexId[];
      /** Vertices of the cities that were pillaged. */
      readonly pillaged: readonly VertexId[];
      /** Wait this long before sailing, so the dice roll can finish first. */
      readonly delayMs?: number;
    }
  | {
      readonly id: string;
      /**
       * A city the barbarians pillaged: the old city (and its wall) flashes and shakes over the
       * settlement it became, the wall falls away and the city sinks to reveal the settlement.
       */
      readonly kind: 'pillage';
      readonly at: VertexId;
      readonly seat: Seat;
      /** The city had a wall, which is shown falling. */
      readonly wall: boolean;
      /** Wait this long first, so the ship can land. */
      readonly delayMs?: number;
    }
  | {
      readonly id: string;
      /** Embers over a pillaged city, or a shield ring over a knight that held. */
      readonly kind: 'burst';
      readonly at: VertexId;
      readonly tone: 'fire' | 'shield';
    }
  | {
      readonly id: string;
      readonly kind: 'fog-reveal';
      readonly hex: HexId;
      /** Position in a batch of reveals: later ones start later, so each is seen on its own. */
      readonly order?: number;
    };

export interface BoardRenderer {
  render(model: RenderModel): void;
  setHighlights(highlights: BoardHighlights): void;
  /** Highlight a keyboard-selected target in board coordinates. */
  setFocusTarget(hit: BoardHit | null, preview?: BoardFocusPreview): void;
  setAppearance(appearance: BoardAppearance): void;
  setReducedMotion(reduced: boolean): void;
  /** Draw or remove the island outlines. */
  setDebugIslands(enabled: boolean): void;
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
  /** True while any part of the fixture is inside the visible board area. */
  isFixtureInView(fixtureId: string): boolean;
  destroy(): void;
}
