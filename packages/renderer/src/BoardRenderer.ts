import { Application, Container, Graphics, Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';
import { buildBoardGraph, edgeToPixel, hexToPixel, vertexToPixel } from '@cp2p/engine/geometry';
import type { BoardGraph, EdgeId, HexId, Point, VertexId } from '@cp2p/engine/geometry';
import { hitTestBoard } from './input/hitTest.js';
import {
  drawDefaultFixture,
  drawFixtureOutline,
  fixtureCellIds,
  fixtureCenters,
  hitTestFixture,
} from './fixtures.js';
import { cameraPositionAtAnchor, clampCameraAxis, fitZoomToBounds } from './input/camera.js';
import {
  PIRATE_ART_SIZE,
  SHIP_ART_SIZE,
  artColorFromNumber,
  loadBoardTextures,
  loadSeafaringTextures,
} from './assets/terrainTextures.js';
import { assignTerrainVariants } from './assets/terrainVariants.js';
import { loadKnightsTextures } from './assets/knightsTextures.js';
import type { KnightsTextures } from './assets/knightsTextures.js';
import {
  BARBARIAN_SHIP_ANCHOR,
  BARBARIAN_SHIP_ART,
  BARBARIAN_SHIP_KEY,
  BARBARIAN_TRACK_ART,
  DEFAULT_BARBARIAN_STEPS,
  KNIGHT_ANCHOR,
  KNIGHT_ART,
  eventDieKey,
  redDieKey,
  MERCHANT_ANCHOR,
  MERCHANT_ART,
  barbarianStepPoint,
  barbarianTrackLayout,
  decoratedCity,
  knightArtKey,
  merchantArtKey,
  metropolisArtKey,
  routeDots,
  sailPosition,
  walledCityArtKey,
} from './knightsLayout.js';
import { hexExtents, islandBoundarySegments } from './boardShape.js';
import { FRAME_GROWTH, drawBoardFrame } from './boardFrame.js';
import { fogRevealShape } from './fogReveal.js';
import { roadVariantForEdge } from './roadVariant.js';
import { shipHeadings, shipVariantAmong, shipVariantForEdge } from './shipVariant.js';
import { shipAnchor } from './shipLayout.js';
import type { ShipVariant } from './shipVariant.js';
import type { Seat } from '@cp2p/engine';
import type { BoardTextures, SeafaringTextures } from './assets/terrainTextures.js';
import { sameAppearance } from './appearance.js';
import {
  DICE_ROLL_DURATION_MS,
  PRODUCTION_PULSE_START_MS,
  PRODUCTION_TOKEN_PULSE_MS,
  type EffectChannel,
  diceMotion,
  effectChannel,
  productionPulseProgress,
  productionTokenMotion,
  robberPosition,
} from './effectMotion.js';
import { harborOnBoard } from './harborLayout.js';
import { BONUS_CHIT_SIZE, islandBonusPoints } from './bonusLayout.js';
import type {
  BoardAppearance,
  BoardRendererDiagnostics,
  BoardEffect,
  BoardFocusPreview,
  BoardHighlights,
  BoardHit,
  BoardRenderer,
  BoardRendererOptions,
  KnightsRender,
  KnightsTrack,
  RenderFixture,
  RenderLayerContext,
  RenderLayerPlugin,
  RenderModel,
  ScreenPoint,
} from './types.js';

// Pixi Graphics.fill() is a drawing method; this rule's Array.fill suggestion is a false positive.
/* oxlint-disable unicorn/no-array-fill-with-reference-type */

const HEX_SIZE = 54;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 3.2;
const FIT_PADDING = 24;
/** A seafaring board keeps more room, because the phone layout bleeds the canvas 30px past the screen. */
const SEA_FIT_PADDING = 40;
const ROAD_ART_SCALE = 0.64;
const ROBBER_GROUND_ANCHOR = 70 / 92;
const LANE_INSET = 0.22;
const LANE_WIDTH = 0.15;
const LANE_DASHES = 3;
const LANE_DASH_LENGTH = 0.12;
const LANE_DASH_WIDTH = 0.06;
const EDGE_RING_LENGTH = 0.82;
const EDGE_RING_HEIGHT = 0.32;
const EDGE_INK = 0x18332b;
const EDGE_PAPER = 0xfcfdfc;
const WAKE_WIDTH = 0.26;
const WAKE_INK = 0x0e3f5c;
const SITE_HALO = 0.2;
const SITE_RING = 0.11;
const SITE_RING_WIDTH = 0.04;
const BRACKET_HALF = 0.46;
const BRACKET_ARM = 0.16;
const BADGE_RADIUS = 0.13;
const PREVIEW_CORNER = 0.12;
/** Ship art width in hex sizes: small enough that a hull fits between the buildings at its ends. */
const SHIP_WIDTH = 0.56;
const PIRATE_WIDTH = 1.2;
const PIRATE_ANCHOR_Y = 0.8;
/** Room kept around an explicit-sea board, its scenery ring and its frame when fitting the camera. */
const SEA_FIT_MARGIN = 0.25;
/** The smallest zoom a fit may pick, below the pinch floor, so a large board still fits whole. */
const FIT_FLOOR_ZOOM = 0.1;
const SHIP_MOVE_MS = 700;
/** The barbarian ship sailing one step, and a whole attack: landing, the blow and the return. */
/** As long as a card's flight, so the ship moves at the same pace. */
const BARBARIAN_SAIL_MS = 1150;
const BARBARIAN_ATTACK_MS = 3200;
const KNIGHT_MOVE_MS = 520;
const BURST_MS = 1100;
const PILLAGE_MS = 1800;
/** Knights draw a quarter larger than their art box, so they read beside a city. */
const KNIGHT_SCALE = 1.25;
const MERCHANT_OFFSET = { x: 0.36, y: 0.4 } as const;
const SIDEWAYS_OFFSET = { x: 0.36, y: 0.06 } as const;
/** One fog tile turning over, and the wait between the tiles of a batch. */
const FOG_REVEAL_MS = 1000;
const FOG_STAGGER_MS = 450;
const FOG_MAX_STAGGERED = 4;
const FOG_COLOR = 0xa9bcc6;
const DEBUG_ISLAND_COLORS = [0xe63946, 0x1d7874, 0xf4a261, 0x6a4c93, 0x2a9d8f, 0xd62828, 0x3a86ff];
const LAYER_NAMES = [
  'background',
  'fixtures',
  'terrain',
  'harbors',
  'tokens',
  'roads',
  'ships',
  'edgeTargets',
  'edgeFocus',
  'buildings',
  'knights',
  'bonus',
  'robber',
  'modulePieces',
  'debug',
  'highlights',
  'focus',
  'effects',
  'moduleOverlay',
] as const;
type LayerName = (typeof LAYER_NAMES)[number];

const TERRAIN_TEXTURES: Readonly<Record<string, keyof BoardTextures['terrain']>> = {
  forest: 'forest',
  hills: 'hills',
  pasture: 'pasture',
  fields: 'fields',
  mountains: 'mountains',
  desert: 'desert',
  sea: 'sea',
};
const HEX_NEIGHBORS = [
  { q: 1, r: 0 },
  { q: 0, r: 1 },
  { q: -1, r: 1 },
  { q: -1, r: 0 },
  { q: 0, r: -1 },
  { q: 1, r: -1 },
] as const;
const DEFAULT_PLAYER_STYLE = { color: 0x0072b2, marker: 'circle' } as const;
const DEFAULT_PLAYERS: BoardAppearance['players'] = [
  { seat: 0, color: 0x0072b2, marker: 'circle' },
  { seat: 1, color: 0xd55e00, marker: 'triangle' },
  { seat: 2, color: 0x009e73, marker: 'square' },
  { seat: 3, color: 0xb35b93, marker: 'diamond' },
  { seat: 4, color: 0xe6ad26, marker: 'hexagon' },
  { seat: 5, color: 0xcf4a44, marker: 'star' },
];

function sameHit(a: BoardHit | null, b: BoardHit | null): boolean {
  return a?.kind === b?.kind && a?.id === b?.id;
}

function hexCorners(center: Point, size: number): number[] {
  const points: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = ((-90 + i * 60) * Math.PI) / 180;
    points.push(center.x + Math.cos(angle) * size, center.y + Math.sin(angle) * size);
  }
  return points;
}

/** True when a model draws with gold, fog, ships, the pirate or island bonus chits. */
function needsSeafaringArt(model: RenderModel): boolean {
  return (
    model.ships !== undefined ||
    model.pirateHex !== undefined ||
    (model.islandBonuses?.length ?? 0) > 0 ||
    model.hexes.some((hex) => hex.terrain === 'gold' || hex.terrain === 'fog')
  );
}

/** True when a model draws knights, walls, metropolises, the merchant or the barbarian track. */
function needsKnightsArt(model: RenderModel): boolean {
  return (
    model.knights !== undefined ||
    (model.fixtures ?? []).some((fixture) => fixture.art === BARBARIAN_TRACK_ART) ||
    model.buildings.some((building) => building.wall === true || building.metropolis !== undefined)
  );
}

/** A rules-neutral Pixi renderer. Coordinates passed to public methods are CSS client coordinates. */
export class PixiBoardRenderer implements BoardRenderer {
  private readonly app: Application;
  private readonly host: HTMLElement;
  private readonly hexSize: number;
  private readonly camera: Container;
  private readonly screenEffects = new Container();
  private readonly layers: Record<LayerName, Container>;
  private readonly buildingNodes = new Map<VertexId, Container>();
  private readonly tokenSprites = new Map<HexId, Sprite>();
  private readonly detachedChildren: Container[] = [];
  private readonly activeEffects = new Map<
    string,
    {
      readonly kind: BoardEffect['kind'];
      readonly node: Container;
      readonly update: (progress: number) => boolean;
      readonly cleanup?: () => void;
      readonly started: number;
      readonly duration: number;
    }
  >();
  private readonly recentEffectIds = new Set<string>();
  private effectFrame = 0;
  private robberSprite: Sprite | null = null;
  private robberMoveActive = false;
  private pirateSprite: Sprite | null = null;
  private pirateMoveActive = false;
  private readonly shipNodes = new Map<EdgeId, Sprite>();
  /** Each drawn ship's hull, following its owner's route. */
  private shipVariants = new Map<EdgeId, ShipVariant>();
  private readonly hiddenShips = new Set<EdgeId>();
  private seafaring: SeafaringTextures | null = null;
  private seafaringLoading: Promise<void> | null = null;
  private knightsArt: KnightsTextures | null = null;
  private knightsLoading: Promise<void> | null = null;
  private readonly loadKnights: () => Promise<KnightsTextures>;
  private readonly knightNodes = new Map<VertexId, Sprite>();
  private readonly hiddenKnights = new Set<VertexId>();
  private barbarianSprite: Sprite | null = null;
  private barbarianHidden = false;
  private debugIslands: boolean;
  private readonly loadSeafaring: () => Promise<SeafaringTextures>;
  private readonly signatures = new Map<LayerName, string>();
  private readonly terrainVariants = new Map<string, 1 | 2 | 3>();
  private readonly terrainByHex = new Map<string, string>();
  private terrainIdentity = '';
  private terrainGraph = '';
  private graphIdentity = '';
  private readonly viewChangeListeners = new Set<() => void>();
  private viewSignature = '';
  private readonly onSelect?: BoardRendererOptions['onSelect'];
  private readonly onFixtureSelect?: BoardRendererOptions['onFixtureSelect'];
  private readonly plugins: readonly RenderLayerPlugin[];
  private readonly fixtureArt: NonNullable<BoardRendererOptions['fixtureArt']>;
  private readonly onHover?: BoardRendererOptions['onHover'];
  private readonly onReady?: BoardRendererOptions['onReady'];
  private forceReducedMotion: boolean;
  private readonly motionPreference: MediaQueryList;
  private harborLabelFormatter: (kind: string) => string;
  private readonly resizeObserver: ResizeObserver;
  private graph: BoardGraph | null = null;
  private model: RenderModel | null = null;
  private highlights: BoardHighlights = {};
  private focusTarget: BoardHit | null = null;
  private focusPreview: BoardFocusPreview | undefined;
  private hiddenBuilding: VertexId | null = null;
  private appearance: BoardAppearance;
  private zoom = 1;
  private minZoom = MIN_ZOOM;
  private cameraX = 0;
  private cameraY = 0;
  private drag: { pointerId: number; x: number; y: number; moved: boolean } | null = null;
  private pointers = new Map<number, ScreenPoint>();
  private pinch: { distance: number; zoom: number; x: number; y: number } | null = null;
  private lastTap: { readonly time: number; readonly x: number; readonly y: number } | null = null;
  private lastHit: BoardHit | null = null;
  private destroyed = false;
  private readyNotified = false;
  private pulseFrame = 0;
  private renderFrameId = 0;
  private renderedFrames = 0;
  private rebuiltLayers = 0;

  private constructor(
    host: HTMLElement,
    app: Application,
    options: BoardRendererOptions,
    private readonly textures: BoardTextures,
    seafaring: SeafaringTextures | null,
    loadSeafaring: () => Promise<SeafaringTextures>,
    knightsArt: KnightsTextures | null,
    loadKnights: () => Promise<KnightsTextures>,
  ) {
    this.app = app;
    this.host = host;
    this.seafaring = seafaring;
    this.loadSeafaring = loadSeafaring;
    this.knightsArt = knightsArt;
    this.loadKnights = loadKnights;
    this.debugIslands = options.debugIslands ?? false;
    this.hexSize = options.hexSize ?? HEX_SIZE;
    this.onSelect = options.onSelect;
    this.onHover = options.onHover;
    this.onReady = options.onReady;
    this.forceReducedMotion = options.reducedMotion ?? false;
    this.motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.harborLabelFormatter = options.formatHarborLabel ?? ((kind) => kind);
    this.appearance = options.appearance ?? {
      theme: 'light',
      players: DEFAULT_PLAYERS,
    };
    this.camera = new Container();
    this.layers = {
      background: new Container(),
      fixtures: new Container(),
      terrain: new Container(),
      harbors: new Container(),
      tokens: new Container(),
      roads: new Container(),
      ships: new Container(),
      edgeTargets: new Container(),
      edgeFocus: new Container(),
      buildings: new Container(),
      knights: new Container(),
      bonus: new Container(),
      robber: new Container(),
      modulePieces: new Container(),
      debug: new Container(),
      highlights: new Container(),
      focus: new Container(),
      effects: new Container(),
      moduleOverlay: new Container(),
    };
    this.onFixtureSelect = options.onFixtureSelect;
    this.plugins = [...(options.layers ?? [])].toSorted(
      (a, b) => a.zIndex - b.zIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    this.fixtureArt = options.fixtureArt ?? {};
    app.stage.addChild(this.camera);
    for (const name of LAYER_NAMES) this.camera.addChild(this.layers[name]);
    app.stage.addChild(this.screenEffects);

    app.canvas.style.display = 'block';
    app.canvas.style.width = '100%';
    app.canvas.style.height = '100%';
    app.canvas.style.touchAction = 'none';
    app.canvas.setAttribute('aria-label', options.accessibleLabel ?? 'Game board canvas');
    host.append(app.canvas);
    this.resizeObserver = new ResizeObserver(() => this.resizeAndClamp());
    this.resizeObserver.observe(host);
    this.motionPreference.addEventListener('change', this.onMotionPreferenceChange);
    this.bindInput();
  }

  static async create(
    host: HTMLElement,
    options: BoardRendererOptions = {},
  ): Promise<PixiBoardRenderer> {
    await import('pixi.js/unsafe-eval');
    const app = new Application();
    const devicePixelRatio = Math.min(window.devicePixelRatio || 1, options.maxPixelRatio ?? 2);
    try {
      await app.init({
        width: Math.max(1, host.clientWidth),
        height: Math.max(1, host.clientHeight),
        autoStart: false,
        autoDensity: true,
        resolution: devicePixelRatio,
        antialias: true,
        backgroundAlpha: 0,
        preference: 'webgl',
      });
      const hexSize = options.hexSize ?? HEX_SIZE;
      const textures = await loadBoardTextures(
        devicePixelRatio,
        options.maxPixelRatio ?? 2,
        MAX_ZOOM,
        hexSize,
      );
      const loadSeafaring = () =>
        loadSeafaringTextures(devicePixelRatio, options.maxPixelRatio ?? 2, MAX_ZOOM, hexSize);
      const seafaring = options.seafaring ? await loadSeafaring() : null;
      const loadKnights = () =>
        loadKnightsTextures(devicePixelRatio, options.maxPixelRatio ?? 2, MAX_ZOOM, hexSize);
      const knights = options.knights ? await loadKnights() : null;
      return new PixiBoardRenderer(
        host,
        app,
        options,
        textures,
        seafaring,
        loadSeafaring,
        knights,
        loadKnights,
      );
    } catch (error) {
      try {
        if (app.renderer)
          app.destroy(true, { children: true, texture: false, textureSource: false });
        else app.stage.destroy({ children: true });
      } catch {
        // Keep the initialization error as the reported failure.
      }
      throw error;
    }
  }

  render(model: RenderModel): void {
    if (this.destroyed) return;
    const firstRender = this.model === null;
    this.model = model;
    const graphIdentity = JSON.stringify(model.hexes.map(({ id, q, r }) => ({ id, q, r })));
    if (graphIdentity !== this.graphIdentity) {
      this.graph = buildBoardGraph(model.hexes);
      this.graphIdentity = graphIdentity;
    }
    const terrainIdentity = JSON.stringify(
      model.hexes.map(({ id, q, r, terrain, token }) => ({ id, q, r, terrain, token })),
    );
    if (terrainIdentity !== this.terrainIdentity) {
      const waterHexes: RenderModel['hexes'] = this.waterCells().map(({ q, r }) => ({
        id: `h:${q},${r}`,
        q,
        r,
        terrain: 'sea',
        token: null,
      }));
      // A fog reveal changes one hex in place. Every other tile keeps the art it had.
      const previous = graphIdentity === this.terrainGraph ? new Map(this.terrainVariants) : null;
      const previousTerrain = new Map(this.terrainByHex);
      this.terrainVariants.clear();
      this.terrainByHex.clear();
      for (const hex of [...model.hexes, ...waterHexes]) this.terrainByHex.set(hex.id, hex.terrain);
      for (const [id, variant] of assignTerrainVariants([...model.hexes, ...waterHexes])) {
        const kept =
          previous && previousTerrain.get(id) === this.terrainByHex.get(id)
            ? previous.get(id)
            : undefined;
        this.terrainVariants.set(id, kept ?? variant);
      }
      this.terrainIdentity = terrainIdentity;
      this.terrainGraph = graphIdentity;
    }
    this.ensureSeafaring(model);
    this.ensureKnights(model);
    this.drawChanged('background', [
      this.appearance.theme,
      model.hexes.map(({ q, r, terrain }) => ({ q, r, terrain })),
      (model.fixtures ?? []).map((fixture) => fixture.footprint),
    ]);
    this.drawChanged('terrain', [model.hexes, model.fixtures ?? [], this.seafaring !== null]);
    this.drawChanged('harbors', [
      model.harbors,
      model.hexes.map(({ id, terrain }) => [id, terrain]),
    ]);
    this.drawChanged('tokens', [model.hexes.map(({ id, q, r, token }) => ({ id, q, r, token }))]);
    this.drawChanged('roads', [model.roads, this.appearance.players]);
    this.drawShips();
    this.drawChanged('buildings', [
      model.buildings,
      this.appearance.players,
      this.knightsArt !== null,
    ]);
    this.drawChanged('knights', [
      model.knights ?? null,
      model.fixtures ?? [],
      this.appearance.players,
      this.knightsArt !== null,
      this.seafaring !== null,
    ]);
    this.drawChanged('bonus', [
      model.islandBonuses ?? [],
      (model.islandBonuses?.length ?? 0) > 0
        ? [
            model.hexes.map(({ id, terrain, token }) => [id, terrain, token]),
            model.harbors,
            model.roads,
            model.ships,
            model.buildings,
            model.knights?.pieces,
          ]
        : null,
      this.seafaring !== null,
    ]);
    this.drawChanged('robber', [model.robberHex, model.pirateHex, this.seafaring !== null]);
    this.drawChanged('debug', [
      this.debugIslands,
      model.hexes.map(({ q, r, terrain }) => [q, r, terrain]),
    ]);
    this.drawChanged('fixtures', [
      model.fixtures ?? [],
      model.knights?.barbarians?.steps ?? null,
      this.pluginSlices('fixtures'),
      this.appearance.theme,
      this.knightsArt !== null,
    ]);
    this.drawChanged('modulePieces', [this.pluginSlices('pieces'), this.appearance.theme]);
    this.drawChanged('moduleOverlay', [this.pluginSlices('overlay'), this.appearance.theme]);
    this.drawChanged('focus', [
      this.focusTarget,
      this.focusPreview,
      model.hexes.map(({ id, q, r }) => ({ id, q, r })),
    ]);
    if (firstRender) this.fitToBoard();
    else {
      this.clampCamera();
      this.updateCamera();
    }
    if (!this.readyNotified) {
      this.readyNotified = true;
      this.onReady?.(this);
    }
    this.renderFrame();
  }

  setHighlights(highlights: BoardHighlights): void {
    if (this.destroyed) return;
    const previous = this.highlights;
    this.highlights = highlights;
    const signature = JSON.stringify(highlights);
    if (this.signatures.get('highlights') === signature) return;
    this.signatures.set('highlights', signature);
    this.rebuiltLayers += 1;
    const layer = this.layers.highlights;
    this.detachedChildren.push(
      ...layer.removeChildren(),
      ...this.layers.edgeTargets.removeChildren(),
    );
    const style = highlights.style ?? {};
    const color = style.color ?? 0x086b52;
    const graphics = new Graphics();
    let hasGeometry = false;
    let hasEdgeGeometry = false;
    for (const id of highlights.hexes ?? []) {
      const hex = this.model?.hexes.find((candidate) => candidate.id === id);
      if (hex) {
        graphics
          .poly(hexCorners(hexToPixel(hex.q, hex.r, this.hexSize), this.hexSize), true)
          .fill({ color, alpha: 0.2 })
          .stroke({ color, width: 3 });
        hasGeometry = true;
      }
    }
    const lanes = new Graphics();
    const dashes = new Graphics();
    for (const id of highlights.edges ?? []) {
      const endpoints = this.edgeEndpoints(id);
      if (!endpoints) continue;
      if (style.edgeTarget === 'ring') {
        this.layers.edgeTargets.addChild(this.edgeRing(id, 0.9, 0.5, EDGE_PAPER));
        continue;
      }
      this.traceEdgeLane(lanes, dashes, endpoints[0], endpoints[1]);
      hasEdgeGeometry = true;
    }
    const wake = style.edgeTarget === 'wake';
    for (const id of highlights.selectedEdges ?? [])
      if (this.edgeEndpoints(id)) layer.addChild(this.edgeRing(id, 1.05, 0.62, 0xf0b64a));
    for (const id of highlights.selectedHexes ?? []) {
      const hex = this.model?.hexes.find((candidate) => candidate.id === id);
      if (hex)
        layer.addChild(
          new Graphics()
            .poly(hexCorners(hexToPixel(hex.q, hex.r, this.hexSize), this.hexSize * 0.94), true)
            .fill({ color: 0xf0b64a, alpha: 0.22 })
            .stroke({ color: EDGE_INK, width: this.hexSize * 0.09 })
            .stroke({ color: 0xf0b64a, width: this.hexSize * 0.05 }),
        );
    }
    for (const id of highlights.selectedVertices ?? [])
      if (this.graph?.vertexIndex[id] !== undefined)
        layer.addChild(this.pieceRing(id, 0.5, 0xf0b64a));
    const vertices = (highlights.vertices ?? []).filter(
      (id) => this.graph?.vertexIndex[id] !== undefined,
    );
    if (style.vertexTarget === 'site' && vertices.length > 0) {
      const halos = new Graphics();
      const rings = new Graphics();
      for (const id of vertices) {
        const point = vertexToPixel(id, this.hexSize);
        halos.circle(point.x, point.y, this.hexSize * SITE_HALO);
        rings.circle(point.x, point.y, this.hexSize * SITE_RING);
      }
      halos.fill({ color: EDGE_INK, alpha: 0.34 });
      rings.stroke({ color: EDGE_PAPER, width: this.hexSize * SITE_RING_WIDTH });
      layer.addChild(halos, rings);
    } else if (style.vertexTarget === 'piece' && vertices.length > 0) {
      for (const id of vertices) layer.addChild(this.pieceRing(id, 0.4, EDGE_PAPER));
    } else if (style.vertexTarget === 'upgrade' && vertices.length > 0) {
      const ink = new Graphics();
      const paper = new Graphics();
      for (const id of vertices) {
        const point = vertexToPixel(id, this.hexSize);
        this.traceBrackets(ink, point.x, point.y);
        this.traceBrackets(paper, point.x, point.y);
      }
      ink.stroke({ color: EDGE_INK, width: this.hexSize * 0.065, cap: 'round', join: 'round' });
      paper.stroke({ color: EDGE_PAPER, width: this.hexSize * 0.032, cap: 'round', join: 'round' });
      layer.addChild(ink, paper);
      for (const id of vertices) {
        const point = vertexToPixel(id, this.hexSize);
        layer.addChild(
          this.upgradeBadge(
            point.x + this.hexSize * BRACKET_HALF,
            point.y - this.hexSize * BRACKET_HALF,
          ),
        );
      }
    } else {
      for (const id of vertices) {
        const point = vertexToPixel(id, this.hexSize);
        graphics
          .circle(point.x, point.y, this.hexSize * 0.25)
          .fill({ color, alpha: 0.5 })
          .stroke({ color, width: 3 });
        hasGeometry = true;
      }
    }
    if (hasGeometry) layer.addChild(graphics);
    if (hasEdgeGeometry) {
      lanes.stroke(
        wake
          ? { color: EDGE_PAPER, alpha: 0.62, width: this.hexSize * WAKE_WIDTH, cap: 'round' }
          : { color: EDGE_INK, alpha: 0.32, width: this.hexSize * LANE_WIDTH, cap: 'round' },
      );
      dashes.stroke({
        color: wake ? WAKE_INK : EDGE_PAPER,
        width: this.hexSize * (wake ? LANE_DASH_WIDTH * 1.3 : LANE_DASH_WIDTH),
        cap: 'butt',
      });
      this.layers.edgeTargets.addChild(lanes, dashes);
    }
    this.syncMotion();
    if (previous !== highlights) this.renderFrame();
  }

  setFocusTarget(hit: BoardHit | null, preview?: BoardFocusPreview): void {
    if (
      this.destroyed ||
      (sameHit(this.focusTarget, hit) &&
        this.focusPreview?.piece === preview?.piece &&
        this.focusPreview?.color === preview?.color)
    )
      return;
    this.focusTarget = hit;
    this.focusPreview = preview;
    this.updateHiddenBuilding(hit, preview);
    this.drawChanged('focus', [
      hit,
      preview,
      this.model?.hexes.map(({ id, q, r }) => ({ id, q, r })),
    ]);
    this.syncMotion();
    this.renderFrame();
  }

  private get reducedMotion(): boolean {
    return this.forceReducedMotion || this.motionPreference.matches;
  }

  private readonly onMotionPreferenceChange = (): void => {
    if (this.destroyed) return;
    if (this.reducedMotion) this.skipAnimations();
    this.syncMotion();
    this.renderFrame();
  };

  setReducedMotion(reduced: boolean): void {
    if (this.destroyed) return;
    this.forceReducedMotion = reduced;
    if (this.reducedMotion) this.skipAnimations();
    this.syncMotion();
    this.renderFrame();
  }

  playEffects(effects: readonly BoardEffect[]): void {
    if (this.destroyed) return;
    for (const effect of effects) {
      if (!effect.id || this.recentEffectIds.has(effect.id)) continue;
      this.recentEffectIds.add(effect.id);
      if (this.recentEffectIds.size > 256) {
        const oldest = this.recentEffectIds.values().next().value;
        if (oldest !== undefined) this.recentEffectIds.delete(oldest);
      }
      if (this.reducedMotion) continue;
      // One of each: a newer roll, pulse, robber, pirate or barbarian move replaces the running
      // one at once, so fast turns never stack two dice or two barbarian ships.
      const channel = effectChannel(effect.kind);
      if (channel) this.finishEffects(channel);
      const active = this.createEffect(effect);
      if (active)
        this.activeEffects.set(effect.id, {
          kind: effect.kind,
          ...active,
          started: performance.now(),
        });
    }
    this.ensureEffectFrame();
    this.renderFrame();
  }

  skipAnimations(): void {
    if (this.effectFrame !== 0) cancelAnimationFrame(this.effectFrame);
    this.effectFrame = 0;
    for (const { node, cleanup } of this.activeEffects.values()) {
      cleanup?.();
      this.retireNode(node);
    }
    this.activeEffects.clear();
    this.setRobberMoveActive(false);
    this.setPirateMoveActive(false);
    this.renderFrame();
  }

  getDiagnostics(): BoardRendererDiagnostics {
    return {
      renderedFrames: this.renderedFrames,
      rebuiltLayers: this.rebuiltLayers,
      activeEffects: this.activeEffects.size,
      activeEffectKinds: [...this.activeEffects.values()].map((effect) => effect.kind),
      queuedDisposals: this.detachedChildren.length,
    };
  }

  private createEffect(effect: BoardEffect): {
    readonly node: Container;
    readonly update: (progress: number) => boolean;
    readonly duration: number;
    readonly cleanup?: () => void;
  } | null {
    const node = new Container();
    const duration =
      effect.kind === 'dice-roll'
        ? DICE_ROLL_DURATION_MS
        : effect.kind === 'production-pulse'
          ? PRODUCTION_PULSE_START_MS + PRODUCTION_TOKEN_PULSE_MS
          : effect.kind === 'ship-move'
            ? SHIP_MOVE_MS
            : effect.kind === 'barbarian-sail'
              ? BARBARIAN_SAIL_MS + (effect.delayMs ?? 0)
              : effect.kind === 'barbarian-attack'
                ? BARBARIAN_ATTACK_MS + (effect.delayMs ?? 0)
                : effect.kind === 'pillage'
                  ? PILLAGE_MS + (effect.delayMs ?? 0)
                  : effect.kind === 'burst'
                    ? BURST_MS
                    : effect.kind === 'knight-move'
                      ? KNIGHT_MOVE_MS
                      : effect.kind === 'fog-reveal'
                        ? FOG_REVEAL_MS +
                          Math.min(effect.order ?? 0, FOG_MAX_STAGGERED) * FOG_STAGGER_MS
                        : 420;
    if (effect.kind === 'dice-roll') {
      if (effect.dice.some((face) => !Number.isInteger(face) || face < 1 || face > 6)) return null;
      const faceSize = Math.min(64, Math.max(56, this.app.screen.width * 0.07));
      const gap = Math.max(10, faceSize * 0.2);
      node.position.set(this.app.screen.width / 2, this.app.screen.height / 2);
      const faces: (Texture | undefined)[] = effect.dice.map((face, index) =>
        effect.event !== undefined && index === 0
          ? (this.knightsArt?.get(redDieKey(face)) ?? this.textures.dice[face - 1])
          : this.textures.dice[face - 1],
      );
      if (effect.event !== undefined) faces.push(this.knightsArt?.get(eventDieKey(effect.event)));
      const shown = faces.filter((texture): texture is Texture => texture !== undefined);
      if (shown.length !== faces.length) return null;
      for (const [index, faceTexture] of shown.entries()) {
        const die = new Container();
        die.position.set((index - (shown.length - 1) / 2) * (faceSize + gap), 0);
        const sprite = new Sprite(faceTexture);
        sprite.anchor.set(0.5);
        sprite.width = faceSize;
        sprite.height = faceSize;
        die.addChild(sprite);
        node.addChild(die);
      }
      this.screenEffects.addChild(node);
      return {
        node,
        duration,
        update: (progress) => {
          const motion = diceMotion(progress);
          node.position.set(this.app.screen.width / 2, this.app.screen.height / 2);
          node.alpha = motion.alpha;
          node.scale.set(motion.scale);
          node.children.forEach((child, index) => {
            child.rotation = motion.rotation * (index === 0 ? 1 : -1);
          });
          return progress >= 1;
        },
      };
    }
    if (effect.kind === 'production-pulse') {
      const originals = [...new Set(effect.hexes)]
        .map((id) => this.tokenSprites.get(id))
        .filter((sprite): sprite is Sprite => sprite !== undefined);
      if (originals.length === 0) return null;
      const sprites = originals.map((original) => {
        const sprite = new Sprite(original.texture);
        sprite.anchor.set(0.5);
        sprite.position.copyFrom(original.position);
        sprite.width = original.width;
        sprite.height = original.height;
        node.addChild(sprite);
        return { sprite, scaleX: sprite.scale.x, scaleY: sprite.scale.y };
      });
      node.visible = false;
      this.layers.effects.addChild(node);
      return {
        node,
        duration,
        cleanup: () => {
          for (const original of originals) original.visible = true;
        },
        update: (progress) => {
          const pulseProgress = productionPulseProgress(progress * duration);
          if (pulseProgress === null) return false;
          node.visible = true;
          for (const original of originals) original.visible = false;
          const scale = 1 + productionTokenMotion(pulseProgress) * 0.6;
          for (const { sprite, scaleX, scaleY } of sprites) {
            sprite.scale.set(scaleX * scale, scaleY * scale);
          }
          return progress >= 1;
        },
      };
    }
    if (effect.kind === 'piece-pop' && effect.piece === 'ship') {
      if (effect.at.kind !== 'edge') return null;
      const sprite = this.shipSprite(
        effect.at.id,
        this.playerStyleMap().get(effect.seat)?.color ?? DEFAULT_PLAYER_STYLE.color,
        effect.seat,
      );
      const point = this.pointForHit(effect.at);
      if (!sprite || !point) return null;
      node.position.set(point.x, point.y);
      sprite.position.set(0, 0);
      node.addChild(sprite);
      this.layers.effects.addChild(node);
      return {
        node,
        duration,
        update: (progress) => {
          node.alpha = Math.min(1, progress * 4) * Math.max(0, 1 - progress * 0.25);
          node.scale.set(0.65 + 0.45 * Math.sin(Math.PI * progress));
          return progress >= 1;
        },
      };
    }
    if (effect.kind === 'ship-move') {
      const sprite = this.shipSprite(
        effect.toEdge,
        this.playerStyleMap().get(effect.seat)?.color ?? DEFAULT_PLAYER_STYLE.color,
        effect.seat,
      );
      if (!sprite) return null;
      const start = edgeToPixel(effect.fromEdge, this.hexSize).midpoint;
      const end = edgeToPixel(effect.toEdge, this.hexSize).midpoint;
      node.addChild(sprite);
      this.layers.effects.addChild(node);
      this.hiddenShips.add(effect.toEdge);
      this.applyHiddenShips();
      return {
        node,
        duration,
        cleanup: () => {
          this.hiddenShips.delete(effect.toEdge);
          this.applyHiddenShips();
        },
        update: (progress) => {
          const position = robberPosition(start, end, progress, this.hexSize * 0.12);
          sprite.position.set(position.x, position.y);
          return progress >= 1;
        },
      };
    }
    if (effect.kind === 'fog-reveal') {
      const hex = this.model?.hexes.find((candidate) => candidate.id === effect.hex);
      const texture = this.seafaring?.fog;
      if (!hex || !texture) return null;
      const center = hexToPixel(hex.q, hex.r, this.hexSize);
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.position.set(center.x, center.y);
      sprite.width = (150 / 80) * this.hexSize;
      sprite.height = (174 / 80) * this.hexSize;
      const scaleX = sprite.scale.x;
      const scaleY = sprite.scale.y;
      // The new terrain is already drawn underneath. The fog turns edge-on to show it, and a
      // light ring marks the tile as it lands.
      const ring = new Graphics()
        .poly(hexCorners(center, this.hexSize * 0.98), true)
        .stroke({ color: 0xfff6d6, width: Math.max(2, this.hexSize * 0.08) });
      ring.alpha = 0;
      // Scale the ring about the hex centre.
      ring.pivot.set(center.x, center.y);
      ring.position.set(center.x, center.y);
      node.addChild(sprite);
      node.addChild(ring);
      this.layers.effects.addChild(node);
      const wait = Math.min(effect.order ?? 0, FOG_MAX_STAGGERED) * FOG_STAGGER_MS;
      return {
        node,
        duration,
        update: (progress) => {
          const shown = fogRevealShape((progress * duration - wait) / FOG_REVEAL_MS);
          sprite.scale.set(scaleX * shown.flip, scaleY * shown.lift);
          sprite.position.y = center.y - shown.rise * this.hexSize;
          sprite.visible = shown.flip > 0.002;
          ring.alpha = shown.glow;
          ring.scale.set(shown.glowScale);
          return progress >= 1;
        },
      };
    }
    if (effect.kind === 'piece-pop' && (effect.piece === 'knight' || effect.piece === 'wall')) {
      if (effect.at.kind !== 'vertex') return null;
      const color = this.playerStyleMap().get(effect.seat)?.color ?? DEFAULT_PLAYER_STYLE.color;
      const point = vertexToPixel(effect.at.id, this.hexSize);
      let piece: Container | null;
      if (effect.piece === 'knight') {
        piece = this.knightSprite(effect.at.id, color, effect.level ?? 1, false);
        // Sprites carry their own board position; centre the pop on the vertex instead.
        piece?.position.set(0, 0);
      } else {
        const existing = this.model?.buildings.find(
          (building) => building.vertex === (effect.at.kind === 'vertex' ? effect.at.id : ''),
        );
        piece = this.buildingNode(
          'city',
          { color },
          { x: 0, y: 0 },
          {
            wall: true,
            ...(existing?.metropolis ? { metropolis: existing.metropolis } : {}),
          },
        );
      }
      if (!piece) return null;
      node.position.set(point.x, point.y);
      node.addChild(piece);
      this.layers.effects.addChild(node);
      return {
        node,
        duration,
        update: (progress) => {
          node.alpha = Math.min(1, progress * 4) * Math.max(0, 1 - progress * 0.25);
          node.scale.set(0.65 + 0.45 * Math.sin(Math.PI * progress));
          return progress >= 1;
        },
      };
    }
    if (effect.kind === 'knight-move') {
      const color = this.playerStyleMap().get(effect.seat)?.color ?? DEFAULT_PLAYER_STYLE.color;
      const sprite = this.knightSprite(effect.toVertex, color, effect.level, false);
      if (!sprite) return null;
      const start = vertexToPixel(effect.fromVertex, this.hexSize);
      const end = vertexToPixel(effect.toVertex, this.hexSize);
      node.addChild(sprite);
      this.layers.effects.addChild(node);
      this.hiddenKnights.add(effect.toVertex);
      this.applyHiddenKnights();
      return {
        node,
        duration,
        cleanup: () => {
          this.hiddenKnights.delete(effect.toVertex);
          this.applyHiddenKnights();
        },
        update: (progress) => {
          const position = robberPosition(start, end, progress, this.hexSize * 0.14);
          sprite.position.set(position.x, position.y);
          return progress >= 1;
        },
      };
    }
    if (effect.kind === 'barbarian-sail') {
      const fixture = this.model?.fixtures?.find((candidate) => candidate.id === effect.fixture);
      const sprite = fixture ? this.barbarianShipSprite(fixture) : null;
      if (!fixture || !sprite) return null;
      const steps = this.barbarianSteps(fixture);
      node.addChild(sprite);
      this.layers.effects.addChild(node);
      this.setBarbarianHidden(true);
      return {
        node,
        duration,
        cleanup: () => this.setBarbarianHidden(false),
        update: (progress) => {
          const at = sailPosition(
            fixture,
            this.hexSize,
            effect.fromStep,
            effect.toStep,
            (progress * duration - (effect.delayMs ?? 0)) / BARBARIAN_SAIL_MS,
            steps,
          );
          if (at) sprite.position.set(at.x, at.y);
          return progress >= 1;
        },
      };
    }
    if (effect.kind === 'barbarian-attack')
      return this.createBarbarianAttack(effect, node, duration);
    if (effect.kind === 'burst') return this.createBurst(effect, node, duration);
    if (effect.kind === 'pillage') return this.createPillage(effect, node, duration);
    if (effect.kind === 'piece-pop') {
      const point = this.pointForHit(effect.at);
      if (!point) return null;
      node.position.set(point.x, point.y);
      const color = artColorFromNumber(
        this.playerStyleMap().get(effect.seat)?.color ?? DEFAULT_PLAYER_STYLE.color,
      );
      const texture =
        effect.piece === 'road'
          ? this.textures.roads[color][1]
          : effect.piece === 'city'
            ? this.textures.cities[color]
            : this.textures.settlements[color];
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.position.set(0, 0);
      const size = effect.piece === 'road' ? this.hexSize * 0.72 : this.hexSize * 0.5;
      sprite.width = size;
      sprite.height = size;

      if (effect.piece === 'road' && effect.at.kind === 'edge') {
        sprite.texture = this.textures.roads[color][roadVariantForEdge(effect.at.id)];
        sprite.width = this.hexSize * ROAD_ART_SCALE;
        sprite.height = this.hexSize * ROAD_ART_SCALE;
      }
      node.addChild(sprite);
      this.layers.effects.addChild(node);
      return {
        node,
        duration,
        update: (progress) => {
          node.alpha = Math.min(1, progress * 4) * Math.max(0, 1 - progress * 0.25);
          node.scale.set(0.65 + 0.45 * Math.sin(Math.PI * progress));
          return progress >= 1;
        },
      };
    }
    if (effect.kind !== 'robber-move' && effect.kind !== 'pirate-move') return null;
    const pirate = effect.kind === 'pirate-move';
    const from = this.model?.hexes.find((hex) => hex.id === effect.fromHex);
    const to = this.model?.hexes.find((hex) => hex.id === effect.toHex);
    const texture = pirate ? this.seafaring?.pirate : this.textures.robber;
    if (!to || !texture || (!from && !pirate)) return null;
    const sprite = new Sprite(texture);
    if (pirate) {
      sprite.anchor.set(0.5, PIRATE_ANCHOR_Y);
      sprite.width = this.hexSize * PIRATE_WIDTH;
      sprite.height = (sprite.width * PIRATE_ART_SIZE.height) / PIRATE_ART_SIZE.width;
    } else {
      sprite.anchor.set(0.5, ROBBER_GROUND_ANCHOR);
      sprite.width = this.hexSize * 0.8;
      sprite.height = this.hexSize * 1.15;
    }
    node.addChild(sprite);
    this.layers.effects.addChild(node);
    const end = hexToPixel(to.q, to.r, this.hexSize);
    const start = from ? hexToPixel(from.q, from.r, this.hexSize) : end;
    if (pirate) this.setPirateMoveActive(true);
    else this.setRobberMoveActive(true);
    return {
      node,
      duration,
      update: (progress) => {
        const position = robberPosition(start, end, progress, this.hexSize * 0.18);
        sprite.position.set(position.x, position.y);
        node.alpha = Math.min(1, progress * 5);
        return progress >= 1;
      },
    };
  }

  /**
   * The barbarians land: the ship sails to the island, the blow is shown as a gold ring on the
   * knights that held or embers on the cities that fell, and the ship sails home.
   */
  private createBarbarianAttack(
    effect: Extract<BoardEffect, { kind: 'barbarian-attack' }>,
    node: Container,
    duration: number,
  ): {
    readonly node: Container;
    readonly update: (progress: number) => boolean;
    readonly duration: number;
    readonly cleanup?: () => void;
  } | null {
    const fixture = this.model?.fixtures?.find((candidate) => candidate.id === effect.fixture);
    const sprite = fixture ? this.barbarianShipSprite(fixture) : null;
    if (!fixture || !sprite) return null;
    const landing = this.barbarianSteps(fixture);
    const hexSize = this.hexSize;
    const impact = barbarianStepPoint(fixture, hexSize, landing, landing);
    // The ship faces the island on the way in and home on the way back.
    const inbound = sprite.scale.x;
    if (!impact) return null;
    const pillaged = effect.outcome === 'pillaged';
    const blast = new Graphics();
    const targets = (pillaged ? effect.pillaged : effect.defenders).map((vertex) => ({
      vertex,
      point: vertexToPixel(vertex, hexSize),
    }));
    node.addChild(blast, sprite);
    this.layers.effects.addChild(node);
    this.setBarbarianHidden(true);
    const SAIL_END = 0.28;
    const BLOW_END = 0.72;
    const ring = (at: Point, radius: number, alpha: number, color: number, width: number): void => {
      if (alpha <= 0.01) return;
      blast.circle(at.x, at.y, radius).stroke({ color, alpha, width });
    };
    return {
      node,
      duration,
      cleanup: () => this.setBarbarianHidden(false),
      update: (overall) => {
        blast.clear();
        const progress = Math.min(
          1,
          Math.max(0, (overall * duration - (effect.delayMs ?? 0)) / BARBARIAN_ATTACK_MS),
        );
        if (progress < SAIL_END) {
          const at = sailPosition(
            fixture,
            hexSize,
            effect.fromStep,
            landing,
            progress / SAIL_END,
            landing,
          );
          sprite.scale.x = inbound;
          if (at) sprite.position.set(at.x, at.y);
        } else if (progress < BLOW_END) {
          const local = (progress - SAIL_END) / (BLOW_END - SAIL_END);
          sprite.position.set(impact.x, impact.y + Math.sin(local * 18) * hexSize * 0.02);
          const color = pillaged ? 0xd6402f : 0xf0b64a;
          ring(impact, hexSize * (0.25 + local * 0.9), 1 - local, color, hexSize * 0.09);
          for (const [index, target] of targets.entries()) {
            const wait = Math.min(0.5, index * 0.12);
            const t = Math.min(1, Math.max(0, (local - wait) / (1 - wait)));
            if (pillaged) {
              ring(target.point, hexSize * (0.15 + t * 0.55), 1 - t, 0xff8a3c, hexSize * 0.08);
              ring(
                target.point,
                hexSize * (0.08 + t * 0.35),
                1 - t * 0.8,
                0xd6402f,
                hexSize * 0.05,
              );
            } else {
              ring(target.point, hexSize * (0.3 + t * 0.35), 1 - t, 0xfff6d6, hexSize * 0.07);
              ring(target.point, hexSize * (0.26 + t * 0.2), 1 - t, 0xf0b64a, hexSize * 0.04);
            }
          }
        } else {
          const local = (progress - BLOW_END) / (1 - BLOW_END);
          const at = sailPosition(fixture, hexSize, landing, 0, local, landing);
          sprite.scale.x = -inbound;
          if (at) sprite.position.set(at.x, at.y);
          sprite.alpha = 1;
        }
        return overall >= 1;
      },
    };
  }

  /**
   * A pillaged city: the old city flashes red and shakes over the settlement it became, its wall
   * drops away, then it sinks and fades to show the settlement, with embers rising around it.
   */
  private createPillage(
    effect: Extract<BoardEffect, { kind: 'pillage' }>,
    node: Container,
    duration: number,
  ): {
    readonly node: Container;
    readonly update: (progress: number) => boolean;
    readonly duration: number;
    readonly cleanup?: () => void;
  } {
    const at = vertexToPixel(effect.at, this.hexSize);
    const style = {
      color: this.playerStyleMap().get(effect.seat)?.color ?? DEFAULT_PLAYER_STYLE.color,
    };
    const origin = { x: 0, y: 0 };
    const walled = effect.wall ? this.buildingNode('city', style, origin, { wall: true }) : null;
    const city = this.buildingNode('city', style, origin);
    const glow = new Graphics();
    const piece = new Container();
    piece.position.set(at.x, at.y);
    piece.addChild(city);
    if (walled) piece.addChild(walled);
    node.addChild(glow, piece);
    this.layers.effects.addChild(node);
    const hexSize = this.hexSize;
    const wait = effect.delayMs ?? 0;
    const showSettlement = (shown: boolean) => {
      const settlement = this.buildingNodes.get(effect.at);
      if (settlement) settlement.visible = shown;
    };
    // Until the ship lands the old city stands where it was.
    showSettlement(false);
    if (walled) city.alpha = 0;
    return {
      node,
      duration,
      cleanup: () => showSettlement(true),
      update: (overall) => {
        glow.clear();
        if (overall * duration < wait) return false;
        const t = Math.min(1, (overall * duration - wait) / PILLAGE_MS);
        // 0-0.4: flash and shake; 0.4-0.55: the wall falls; 0.55-0.8: the city sinks away.
        const shake = t < 0.4 ? Math.sin(t * 90) * hexSize * 0.04 * (1 - t / 0.4) : 0;
        piece.position.set(at.x + shake, at.y);
        if (walled) {
          const fall = Math.min(1, Math.max(0, (t - 0.4) / 0.15));
          walled.alpha = 1 - fall;
          walled.position.y = fall * hexSize * 0.12;
          city.alpha = fall > 0 ? 1 : 0;
        }
        const sink = Math.min(1, Math.max(0, (t - 0.55) / 0.25));
        piece.alpha = 1 - sink;
        piece.scale.set(1 - sink * 0.35);
        if (sink > 0) showSettlement(true);
        const flash = t < 0.4 ? 0.5 + 0.5 * Math.sin(t * 40) : Math.max(0, 1 - (t - 0.4) / 0.6);
        glow
          .circle(at.x, at.y, hexSize * (0.3 + t * 0.35))
          .fill({ color: 0xd6402f, alpha: 0.35 * flash })
          .circle(at.x, at.y, hexSize * (0.25 + t * 0.5))
          .stroke({ color: 0xff8a3c, alpha: 1 - t, width: hexSize * 0.07 });
        for (let ember = 0; ember < 5; ember += 1) {
          const rise = (t * 1.6 + ember * 0.2) % 1;
          glow
            .circle(
              at.x + Math.sin(ember * 2.4) * hexSize * 0.3,
              at.y - rise * hexSize * 0.6,
              hexSize * 0.035,
            )
            .fill({ color: 0xff8a3c, alpha: (1 - rise) * (1 - t) });
        }
        return overall >= 1;
      },
    };
  }

  /** Embers over a pillaged city, or a ring of light over a knight that held the line. */
  private createBurst(
    effect: Extract<BoardEffect, { kind: 'burst' }>,
    node: Container,
    duration: number,
  ): {
    readonly node: Container;
    readonly update: (progress: number) => boolean;
    readonly duration: number;
  } {
    const at = vertexToPixel(effect.at, this.hexSize);
    const glow = new Graphics();
    node.addChild(glow);
    this.layers.effects.addChild(node);
    const fire = effect.tone === 'fire';
    return {
      node,
      duration,
      update: (progress) => {
        glow.clear();
        const fade = 1 - progress;
        if (fire) {
          glow
            .circle(at.x, at.y, this.hexSize * (0.15 + progress * 0.6))
            .stroke({ color: 0xff8a3c, alpha: fade, width: this.hexSize * 0.09 })
            .circle(
              at.x,
              at.y - progress * this.hexSize * 0.3,
              this.hexSize * (0.1 + progress * 0.3),
            )
            .fill({ color: 0xd6402f, alpha: fade * 0.5 });
        } else {
          glow
            .circle(at.x, at.y, this.hexSize * (0.3 + progress * 0.4))
            .stroke({ color: 0xfff6d6, alpha: fade, width: this.hexSize * 0.07 })
            .circle(at.x, at.y, this.hexSize * (0.24 + progress * 0.25))
            .stroke({ color: 0xf0b64a, alpha: fade, width: this.hexSize * 0.04 });
        }
        return progress >= 1;
      },
    };
  }

  private readonly tickEffects = (now: number): void => {
    this.effectFrame = 0;
    if (this.destroyed) return;
    for (const [id, effect] of this.activeEffects) {
      if (effect.update(Math.min(1, (now - effect.started) / effect.duration))) {
        effect.cleanup?.();
        this.retireNode(effect.node);
        this.activeEffects.delete(id);
        if (effect.kind === 'robber-move') this.setRobberMoveActive(false);
        if (effect.kind === 'pirate-move') this.setPirateMoveActive(false);
      }
    }
    this.renderFrame();
    this.ensureEffectFrame();
  };

  private ensureEffectFrame(): void {
    if (this.activeEffects.size > 0 && this.effectFrame === 0 && !this.destroyed)
      this.effectFrame = requestAnimationFrame(this.tickEffects);
  }

  private retireNode(node: Container): void {
    node.parent?.removeChild(node);
    this.detachedChildren.push(node);
  }

  private setRobberMoveActive(active: boolean): void {
    this.robberMoveActive = active;
    if (this.robberSprite) this.robberSprite.visible = !active;
  }

  private setPirateMoveActive(active: boolean): void {
    this.pirateMoveActive = active;
    if (this.pirateSprite) this.pirateSprite.visible = !active;
  }

  private applyHiddenShips(): void {
    for (const [edge, sprite] of this.shipNodes) sprite.visible = !this.hiddenShips.has(edge);
  }

  private cancelProductionPulse(): void {
    this.finishEffects('production');
  }

  /** End every running effect on a channel at once, as if it had finished. */
  private finishEffects(channel: EffectChannel): void {
    for (const [id, effect] of this.activeEffects) {
      if (effectChannel(effect.kind) !== channel) continue;
      effect.cleanup?.();
      this.retireNode(effect.node);
      this.activeEffects.delete(id);
    }
    if (channel === 'robber') this.setRobberMoveActive(false);
    if (channel === 'pirate') this.setPirateMoveActive(false);
  }

  private pointForHit(hit: BoardHit): Point | null {
    if (hit.kind === 'vertex') return vertexToPixel(hit.id, this.hexSize);
    if (hit.kind === 'edge') return edgeToPixel(hit.id, this.hexSize).midpoint;
    const hex = this.model?.hexes.find((candidate) => candidate.id === hit.id);
    return hex ? hexToPixel(hex.q, hex.r, this.hexSize) : null;
  }

  private isLegalHighlight(hit: BoardHit): boolean {
    if (hit.kind === 'vertex') return this.highlights.vertices?.includes(hit.id) ?? false;
    if (hit.kind === 'edge') return this.highlights.edges?.includes(hit.id) ?? false;
    return this.highlights.hexes?.includes(hit.id) ?? false;
  }

  private updateHiddenBuilding(hit: BoardHit | null, preview: BoardFocusPreview | undefined): void {
    if (this.hiddenBuilding) {
      const previous = this.buildingNodes.get(this.hiddenBuilding);
      if (previous) previous.visible = true;
    }
    const hidden =
      hit?.kind === 'vertex' &&
      preview?.piece === 'city' &&
      this.model?.buildings.some(
        (building) => building.vertex === hit.id && building.kind === 'settlement',
      )
        ? hit.id
        : null;
    this.hiddenBuilding = hidden;
    if (hidden) {
      const current = this.buildingNodes.get(hidden);
      if (current) current.visible = false;
    }
  }

  private edgeEndpoints(id: EdgeId): readonly [Point, Point] | null {
    const index = this.graph?.edgeIndex[id];
    const endpoints = index === undefined ? undefined : this.graph?.edgeVertices[index];
    return endpoints
      ? [vertexToPixel(endpoints[0], this.hexSize), vertexToPixel(endpoints[1], this.hexSize)]
      : null;
  }

  private traceEdgeLane(lanes: Graphics, dashes: Graphics, first: Point, second: Point): void {
    const at = (amount: number): Point => ({
      x: first.x + (second.x - first.x) * amount,
      y: first.y + (second.y - first.y) * amount,
    });
    const start = at(LANE_INSET);
    const end = at(1 - LANE_INSET);
    lanes.moveTo(start.x, start.y).lineTo(end.x, end.y);
    const span = 1 - LANE_INSET * 2;
    const gap = (span - LANE_DASH_LENGTH * LANE_DASHES) / (LANE_DASHES - 1);
    for (let index = 0; index < LANE_DASHES; index += 1) {
      const dashStart = at(LANE_INSET + index * (LANE_DASH_LENGTH + gap));
      const dashEnd = at(LANE_INSET + index * (LANE_DASH_LENGTH + gap) + LANE_DASH_LENGTH);
      dashes.moveTo(dashStart.x, dashStart.y).lineTo(dashEnd.x, dashEnd.y);
    }
  }

  private roadSprite(id: EdgeId, color: number): Sprite {
    const artColor = artColorFromNumber(color);
    const variant = roadVariantForEdge(id);
    const sprite = new Sprite(this.textures.roads[artColor][variant]);
    const edge = edgeToPixel(id, this.hexSize);
    sprite.anchor.set(0.5);
    sprite.position.set(edge.midpoint.x, edge.midpoint.y);
    sprite.width = this.hexSize * ROAD_ART_SCALE;
    sprite.height = this.hexSize * ROAD_ART_SCALE;
    return sprite;
  }

  /**
   * A ship centred on its edge, its hull along the edge and heading out along its owner's route,
   * or null while the seafaring art is not loaded. Without a seat it keeps a stable heading.
   */
  private shipSprite(id: EdgeId, color: number, seat?: Seat): Sprite | null {
    const textures = this.seafaring?.ships[artColorFromNumber(color)];
    const variant: ShipVariant =
      seat === undefined || !this.model
        ? shipVariantForEdge(id)
        : (this.shipVariants.get(id) ?? shipVariantAmong(this.model, id, seat));
    const texture = textures?.[variant - 1];
    if (!texture) return null;
    const sprite = new Sprite(texture);
    const midpoint = edgeToPixel(id, this.hexSize).midpoint;
    const anchor = shipAnchor(variant);
    sprite.anchor.set(anchor.x, anchor.y);
    sprite.position.set(midpoint.x, midpoint.y);
    sprite.width = this.hexSize * SHIP_WIDTH;
    sprite.height = (sprite.width * SHIP_ART_SIZE.height) / SHIP_ART_SIZE.width;
    return sprite;
  }

  /** An outlined ring around a piece on a vertex, radius in hex sizes. */
  private pieceRing(id: VertexId, radius: number, inner: number): Graphics {
    const point = vertexToPixel(id, this.hexSize);
    return new Graphics()
      .circle(point.x, point.y, this.hexSize * radius)
      .fill({ color: EDGE_INK, alpha: 0.16 })
      .circle(point.x, point.y, this.hexSize * radius)
      .stroke({ color: EDGE_INK, width: this.hexSize * 0.065 })
      .circle(point.x, point.y, this.hexSize * radius)
      .stroke({ color: inner, width: this.hexSize * 0.032 });
  }

  /** An outlined capsule around an edge, in board units of the hex size. */
  private edgeRing(id: EdgeId, length: number, height: number, inner: number): Graphics {
    const edge = edgeToPixel(id, this.hexSize);
    const width = this.hexSize * length;
    const tall = this.hexSize * height;
    const ring = new Graphics()
      .roundRect(-width / 2, -tall / 2, width, tall, tall / 2)
      .stroke({ color: EDGE_INK, width: this.hexSize * 0.065 })
      .roundRect(-width / 2, -tall / 2, width, tall, tall / 2)
      .stroke({ color: inner, width: this.hexSize * 0.032 });
    ring.position.set(edge.midpoint.x, edge.midpoint.y);
    ring.rotation = edge.angle;
    return ring;
  }

  private buildingNode(
    kind: 'settlement' | 'city',
    style: Pick<BoardAppearance['players'][number], 'color'>,
    point: Point,
    decoration?: { readonly wall?: boolean; readonly metropolis?: KnightsTrack },
  ): Container {
    const node = new Container();
    node.position.set(point.x, point.y);
    const color = artColorFromNumber(style.color);
    const decorated =
      kind === 'city' ? decoratedCity(decoration?.wall === true, decoration?.metropolis) : null;
    if (decorated) {
      const key = decoration?.metropolis
        ? metropolisArtKey(decoration.metropolis, decoration.wall === true, color)
        : walledCityArtKey(color);
      const texture = this.knightsArt?.get(key);
      if (texture) {
        const art = decorated.art;
        const unit = this.hexSize / 80;
        const piece = new Sprite(texture);
        piece.anchor.set(art.originX / art.width, art.originY / art.height);
        piece.width = art.width * unit;
        piece.height = art.height * unit;
        node.addChild(piece);
        return node;
      }
    }
    const sprite = new Sprite(
      kind === 'city' ? this.textures.cities[color] : this.textures.settlements[color],
    );
    sprite.anchor.set(kind === 'city' ? 23 / 48 : 0.5, kind === 'city' ? 28 / 50 : 22 / 40);
    sprite.width = this.hexSize * (kind === 'city' ? 48 / 80 : 40 / 80);
    sprite.height = this.hexSize * (kind === 'city' ? 50 / 80 : 40 / 80);
    node.addChild(sprite);
    return node;
  }

  /** The uncommitted piece shown at a focused vertex. */
  private previewNode(
    piece: 'settlement' | 'city' | 'knight' | 'wall' | 'mark',
    preview: BoardFocusPreview,
    vertex: VertexId,
    point: Point,
  ): Container {
    if (piece === 'mark') return new Container();
    if (piece === 'knight') {
      const knight = preview.knight ?? { level: 1, active: false };
      return (
        this.knightSprite(vertex, preview.color, knight.level, knight.active) ?? new Container()
      );
    }
    if (piece === 'wall') {
      const existing = this.model?.buildings.find((building) => building.vertex === vertex);
      return this.buildingNode('city', { color: preview.color }, point, {
        wall: true,
        ...(existing?.metropolis ? { metropolis: existing.metropolis } : {}),
      });
    }
    return this.buildingNode(piece, { color: preview.color }, point);
  }

  private traceBrackets(graphics: Graphics, x: number, y: number): void {
    const half = this.hexSize * BRACKET_HALF;
    const arm = this.hexSize * BRACKET_ARM;
    for (const [sx, sy] of [
      [-1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      graphics
        .moveTo(x + sx * half, y + sy * (half - arm))
        .lineTo(x + sx * half, y + sy * half)
        .lineTo(x + sx * (half - arm), y + sy * half);
    }
  }

  private upgradeBadge(x: number, y: number): Graphics {
    const unit = this.hexSize;
    const width = unit * 0.055;
    const height = unit * 0.03;
    return new Graphics()
      .circle(x, y, unit * BADGE_RADIUS)
      .fill({ color: EDGE_INK })
      .stroke({ color: EDGE_PAPER, width: unit * 0.024 })
      .moveTo(x - width, y + height / 2 + width * 0.3)
      .lineTo(x, y - height / 2 - width * 0.3)
      .lineTo(x + width, y + height / 2 + width * 0.3)
      .stroke({ color: EDGE_PAPER, width: unit * 0.03, cap: 'round', join: 'round' });
  }

  private syncMotion(): void {
    if (this.destroyed) return;
    if (this.pulseActive) {
      if (this.pulseFrame === 0) this.pulseFrame = requestAnimationFrame(this.tickHighlights);
      return;
    }
    if (this.pulseFrame !== 0) cancelAnimationFrame(this.pulseFrame);
    this.pulseFrame = 0;
    this.setPulseAlpha(1);
  }

  private get pulseActive(): boolean {
    return (
      this.highlights.style?.pulse === true &&
      !this.reducedMotion &&
      !(this.focusTarget !== null && this.focusPreview !== undefined)
    );
  }

  private setPulseAlpha(alpha: number): void {
    this.layers.highlights.alpha = alpha;
    this.layers.edgeTargets.alpha = alpha;
  }

  private readonly tickHighlights = (): void => {
    this.pulseFrame = 0;
    if (this.destroyed) return;
    if (!this.pulseActive) {
      this.setPulseAlpha(1);
      this.renderFrame();
      return;
    }
    const phase = (Math.sin(performance.now() / 400) + 1) / 2;
    this.setPulseAlpha(0.72 + phase * 0.28);
    this.renderFrame();
    this.pulseFrame = requestAnimationFrame(this.tickHighlights);
  };

  setAppearance(appearance: BoardAppearance): void {
    if (this.destroyed) return;
    if (sameAppearance(this.appearance, appearance)) return;
    this.appearance = appearance;
    this.signatures.delete('background');
    this.signatures.delete('roads');
    this.signatures.delete('buildings');
    this.signatures.delete('knights');
    if (!this.model) return;
    this.drawChanged('background', [appearance.theme]);
    this.drawChanged('roads', [this.model.roads, this.appearance.players]);
    this.drawShips();
    this.drawChanged('buildings', [
      this.model.buildings,
      this.appearance.players,
      this.knightsArt !== null,
    ]);
    this.drawChanged('knights', [
      this.model.knights ?? null,
      this.model.fixtures ?? [],
      this.appearance.players,
      this.knightsArt !== null,
      this.seafaring !== null,
    ]);
    this.renderFrame();
  }

  setDebugIslands(enabled: boolean): void {
    if (this.destroyed || this.debugIslands === enabled) return;
    this.debugIslands = enabled;
    if (this.model) {
      this.drawChanged('debug', [
        enabled,
        this.model.hexes.map(({ q, r, terrain }) => [q, r, terrain]),
      ]);
      this.renderFrame();
    }
  }

  /** Load the seafaring art the first time a model needs it, then redraw the pieces that use it. */
  private ensureSeafaring(model: RenderModel): void {
    if (this.seafaring || this.seafaringLoading || !needsSeafaringArt(model)) return;
    this.seafaringLoading = this.loadSeafaring()
      .then((art) => {
        if (this.destroyed) return undefined;
        this.seafaring = art;
        if (this.model) this.render(this.model);
        return undefined;
      })
      .catch(() => {
        this.seafaringLoading = null;
      });
  }

  /** Load the Cities & Knights art the first time a model needs it, then redraw its pieces. */
  private ensureKnights(model: RenderModel): void {
    if (this.knightsArt || this.knightsLoading || !needsKnightsArt(model)) return;
    this.knightsLoading = this.loadKnights()
      .then((art) => {
        if (this.destroyed) return undefined;
        this.knightsArt = art;
        if (this.model) this.render(this.model);
        return undefined;
      })
      .catch(() => {
        this.knightsLoading = null;
      });
  }

  setHarborLabelFormatter(formatter: (kind: string) => string): void {
    if (this.destroyed) return;
    this.harborLabelFormatter = formatter;
    this.signatures.delete('harbors');
    if (this.model) this.drawChanged('harbors', [this.model.harbors]);
    this.renderFrame();
  }

  hitTest(clientPoint: ScreenPoint, mode = this.highlights.mode ?? 'any'): BoardHit | null {
    if (!this.graph) return null;
    const point = this.screenToBoard(clientPoint);
    const haveLegal =
      this.highlights.vertices !== undefined ||
      this.highlights.edges !== undefined ||
      this.highlights.hexes !== undefined;
    return hitTestBoard({
      graph: this.graph,
      point,
      hexSize: this.hexSize,
      worldUnitsPerCssPixel: 1 / this.zoom,
      mode,
      ...(haveLegal
        ? {
            legalVertices: new Set(this.highlights.vertices ?? []),
            legalEdges: new Set(this.highlights.edges ?? []),
            legalHexes: new Set(this.highlights.hexes ?? []),
          }
        : {}),
    });
  }

  subscribeViewChange(listener: () => void): () => void {
    if (this.destroyed) return () => undefined;
    const isNewListener = !this.viewChangeListeners.has(listener);
    this.viewChangeListeners.add(listener);
    if (isNewListener) listener();
    return () => this.viewChangeListeners.delete(listener);
  }

  getPixelPosition(hit: BoardHit): ScreenPoint {
    if (hit.kind === 'hex') {
      const hex = this.model?.hexes.find((candidate) => candidate.id === hit.id);
      if (!hex) throw new Error(`Unknown hex ${hit.id}`);
      return this.boardToScreen(hexToPixel(hex.q, hex.r, this.hexSize));
    }
    return this.boardToScreen(
      hit.kind === 'vertex'
        ? vertexToPixel(hit.id, this.hexSize)
        : edgeToPixel(hit.id, this.hexSize).midpoint,
    );
  }

  boardToScreen(point: ScreenPoint): ScreenPoint {
    const rect = this.app.canvas.getBoundingClientRect();
    const scaleX = rect.width / this.app.screen.width || 1;
    const scaleY = rect.height / this.app.screen.height || 1;
    return {
      x: rect.left + (this.cameraX + point.x * this.zoom) * scaleX,
      y: rect.top + (this.cameraY + point.y * this.zoom) * scaleY,
    };
  }

  screenToBoard(clientPoint: ScreenPoint): ScreenPoint {
    const rect = this.app.canvas.getBoundingClientRect();
    const scaleX = this.app.screen.width / rect.width || 1;
    const scaleY = this.app.screen.height / rect.height || 1;
    return {
      x: ((clientPoint.x - rect.left) * scaleX - this.cameraX) / this.zoom,
      y: ((clientPoint.y - rect.top) * scaleY - this.cameraY) / this.zoom,
    };
  }

  fitToBoard(): void {
    if (this.destroyed || !this.model?.hexes.length) return;
    const bounds = this.fitPixelBounds();
    if (!bounds) return;
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    this.zoom = fitZoomToBounds(
      width,
      height,
      this.app.screen.width,
      this.app.screen.height,
      this.hasSeaHexes() ? SEA_FIT_PADDING : FIT_PADDING,
      FIT_FLOOR_ZOOM,
      MAX_ZOOM,
    );
    // A board too big to fit at the usual floor lets the player zoom back out to the fit.
    this.minZoom = Math.min(MIN_ZOOM, this.zoom);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    this.cameraX = this.app.screen.width / 2 - centerX * this.zoom;
    this.cameraY = this.app.screen.height / 2 - centerY * this.zoom;
    this.clampCamera();
    this.updateCamera();
    this.renderFrame();
  }

  isFixtureInView(fixtureId: string): boolean {
    const fixture = this.model?.fixtures?.find((candidate) => candidate.id === fixtureId);
    if (!fixture || this.destroyed) return false;
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    const centers = fixtureCenters(fixture, this.hexSize);
    const middle = {
      x: centers.reduce((sum, point) => sum + point.x, 0) / Math.max(1, centers.length),
      y: centers.reduce((sum, point) => sum + point.y, 0) / Math.max(1, centers.length),
    };
    return [...centers, middle].every((point) => {
      const x = this.cameraX + point.x * this.zoom;
      const y = this.cameraY + point.y * this.zoom;
      return x >= 0 && x <= width && y >= 0 && y <= height;
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.motionPreference.removeEventListener('change', this.onMotionPreferenceChange);
    this.unbindInput();
    if (this.pulseFrame !== 0) cancelAnimationFrame(this.pulseFrame);
    if (this.renderFrameId !== 0) cancelAnimationFrame(this.renderFrameId);
    if (this.effectFrame !== 0) cancelAnimationFrame(this.effectFrame);
    for (const { node, cleanup } of this.activeEffects.values()) {
      cleanup?.();
      node.destroy({ children: true });
    }
    this.activeEffects.clear();
    this.viewChangeListeners.clear();
    this.app.destroy(true, { children: true, texture: false, textureSource: false });
    this.destroyDetachedChildren();
  }

  /** Redraw the ships when they, their owners' routes (which set headings) or colours change. */
  private drawShips(): void {
    if (!this.model) return;
    this.shipVariants = this.model.ships ? shipHeadings(this.model) : new Map();
    this.drawChanged('ships', [
      this.model.ships ?? [],
      [...this.shipVariants],
      this.appearance.players,
      this.seafaring !== null,
    ]);
  }

  private drawChanged(name: LayerName, value: unknown): void {
    const signature = JSON.stringify(value);
    if (this.signatures.get(name) === signature) return;
    if (name === 'tokens') this.cancelProductionPulse();
    this.signatures.set(name, signature);
    this.rebuiltLayers += 1;
    const layer = this.layers[name];
    this.detachedChildren.push(...layer.removeChildren());
    const model = this.model;
    if (!model) return;
    if (name === 'background') {
      // The frame follows every hex that is drawn: the board, its sea ring and fixture cells.
      const fixtureCells = (model.fixtures ?? []).flatMap((fixture) => fixture.footprint);
      layer.addChild(
        drawBoardFrame([...model.hexes, ...this.waterCells(), ...fixtureCells], this.hexSize),
      );
      if (this.isStandardFootprint()) {
        const underlay = new Sprite(this.textures.underlay);
        underlay.anchor.set(0.5);
        underlay.width = this.hexSize * 14;
        underlay.height = this.hexSize * 13;
        layer.addChild(underlay);
      } else {
        const underlay = new Graphics();
        for (const hex of model.hexes) {
          underlay
            .poly(hexCorners(hexToPixel(hex.q, hex.r, this.hexSize), this.hexSize * 1.01), true)
            .fill({
              color:
                hex.terrain === 'sea' ? 0x4d97ae : hex.terrain === 'fog' ? FOG_COLOR : 0xe3c98f,
            });
        }
        for (const center of this.waterCenters()) {
          underlay.poly(hexCorners(center, this.hexSize * 1.01), true).fill({ color: 0x4d97ae });
        }
        layer.addChild(underlay);
      }
      // Fixture cells are water under their art, like the sea ring they extend.
      if (fixtureCells.length > 0) {
        const underlay = new Graphics();
        for (const { q, r } of fixtureCells)
          underlay
            .poly(hexCorners(hexToPixel(q, r, this.hexSize), this.hexSize * 1.01), true)
            .fill({ color: 0x4d97ae });
        layer.addChild(underlay);
      }
    } else if (name === 'terrain') {
      const covered = fixtureCellIds(model.fixtures ?? []);
      for (const { q, r, center } of this.waterCells()) {
        if (covered.has(`h:${q},${r}`)) continue;
        const variant = this.terrainVariants.get(`h:${q},${r}`) ?? 1;
        const texture = this.textures.terrain.sea[variant - 1] ?? this.textures.terrain.sea[0];
        if (texture) this.drawTerrainTile(layer, center, texture);
      }

      for (const hex of model.hexes) {
        if (hex.terrain === 'sea' && covered.has(hex.id)) continue;
        const center = hexToPixel(hex.q, hex.r, this.hexSize);
        if (hex.terrain === 'gold' || hex.terrain === 'fog') {
          const art = this.seafaring;
          const texture =
            hex.terrain === 'fog'
              ? art?.fog
              : (art?.gold[(this.terrainVariants.get(hex.id) ?? 1) - 1] ?? art?.gold[0]);
          if (texture) this.drawTerrainTile(layer, center, texture);
          continue;
        }
        const textureKey = TERRAIN_TEXTURES[hex.terrain];
        if (textureKey) {
          const variants = this.textures.terrain[textureKey];
          const index = textureKey === 'desert' ? 0 : (this.terrainVariants.get(hex.id) ?? 1) - 1;
          const texture = variants[index] ?? variants[0];
          if (texture) this.drawTerrainTile(layer, center, texture);
        }
      }
    } else if (name === 'harbors') {
      for (const harbor of model.harbors) this.drawHarbor(layer, harbor.edge, harbor.kind);
    } else if (name === 'fixtures' || name === 'modulePieces' || name === 'moduleOverlay') {
      const context: RenderLayerContext = {
        hexSize: this.hexSize,
        theme: this.appearance.theme,
        reducedMotion: this.forceReducedMotion,
      };
      if (name === 'fixtures')
        for (const fixture of model.fixtures ?? []) {
          const art = this.fixtureArt[fixture.art];
          if (art) layer.addChild(art(fixture, context));
          else if (fixture.art === BARBARIAN_TRACK_ART) {
            // Until the knights art is in, the cells show the sea underlay and the outline.
            const track = this.barbarianTrack(fixture);
            if (track) layer.addChild(track);
          } else layer.addChild(drawDefaultFixture(fixture, this.hexSize, context.theme));
          layer.addChild(drawFixtureOutline(fixture, this.hexSize));
        }
      const band =
        name === 'fixtures' ? 'fixtures' : name === 'modulePieces' ? 'pieces' : 'overlay';
      for (const plugin of this.plugins) {
        if (plugin.band !== band) continue;
        const target = new Container();
        target.label = `plugin:${plugin.id}`;
        plugin.draw(target, model.layers?.[plugin.id], context);
        layer.addChild(target);
      }
    } else if (name === 'tokens') {
      this.tokenSprites.clear();
      for (const hex of model.hexes) {
        if (hex.token === null) continue;
        const center = hexToPixel(hex.q, hex.r, this.hexSize);
        const texture = this.textures.tokens[hex.token];
        if (!texture) continue;
        const face = new Sprite(texture);
        face.anchor.set(0.5);
        face.position.set(center.x, center.y);
        face.width = this.hexSize * 0.625;
        face.height = this.hexSize * 0.625;
        this.tokenSprites.set(hex.id, face);
        layer.addChild(face);
      }
    } else if (name === 'focus') {
      this.detachedChildren.push(...this.layers.edgeFocus.removeChildren());
      const hit = this.focusTarget;
      if (!hit) return;
      const color = 0xf0b64a;
      const graphics = new Graphics();
      if (hit.kind === 'hex') {
        const hex = model.hexes.find((candidate) => candidate.id === hit.id);
        if (!hex) return;
        graphics
          .poly(hexCorners(hexToPixel(hex.q, hex.r, this.hexSize), this.hexSize * 0.88), true)
          .fill({ color, alpha: 0.12 })
          .stroke({ color: 0xffffff, width: 7 })
          .stroke({ color, width: 3 });
      } else if (hit.kind === 'edge') {
        if (
          this.focusPreview &&
          this.focusPreview.piece !== 'road' &&
          this.focusPreview.piece !== 'ship'
        )
          return;
        const endpoints = this.edgeEndpoints(hit.id);
        if (!endpoints) return;
        const edge = edgeToPixel(hit.id, this.hexSize);
        const width = this.hexSize * EDGE_RING_LENGTH;
        const height = this.hexSize * EDGE_RING_HEIGHT;
        const ring = new Graphics()
          .roundRect(-width / 2, -height / 2, width, height, height / 2)
          .stroke({ color: EDGE_INK, width: this.hexSize * 0.065 })
          .roundRect(-width / 2, -height / 2, width, height, height / 2)
          .stroke({ color: EDGE_PAPER, width: this.hexSize * 0.032 });
        ring.position.set(edge.midpoint.x, edge.midpoint.y);
        ring.rotation = edge.angle;
        this.layers.edgeFocus.addChild(ring);
        if (this.focusPreview) {
          const preview =
            this.focusPreview.piece === 'ship'
              ? this.shipSprite(
                  hit.id,
                  this.focusPreview.color,
                  this.appearance.players.find((style) => style.color === this.focusPreview?.color)
                    ?.seat,
                )
              : this.roadSprite(hit.id, this.focusPreview.color);
          if (preview) this.layers.edgeFocus.addChild(preview);
        }
        return;
      } else {
        const previewPiece = this.focusPreview?.piece;
        if (previewPiece === 'road' || previewPiece === 'ship') return;
        const point = vertexToPixel(hit.id, this.hexSize);
        if (this.graph?.vertexIndex[hit.id] === undefined) return;
        const existing = model.buildings.find((building) => building.vertex === hit.id);
        if (this.focusPreview && previewPiece) {
          if (existing?.kind === previewPiece) return;
          const half = this.hexSize * BRACKET_HALF;
          const corner = this.hexSize * PREVIEW_CORNER;
          const preview = this.previewNode(previewPiece, this.focusPreview, hit.id, point);
          const outline = new Graphics()
            .roundRect(point.x - half, point.y - half, 2 * half, 2 * half, corner)
            .stroke({ color: EDGE_INK, width: this.hexSize * 0.065 })
            .roundRect(point.x - half, point.y - half, 2 * half, 2 * half, corner)
            .stroke({ color: EDGE_PAPER, width: this.hexSize * 0.032 });
          layer.addChild(preview, outline);
          if (this.focusPreview.piece === 'city')
            layer.addChild(this.upgradeBadge(point.x + half, point.y - half));
          return;
        }
        graphics
          .circle(point.x, point.y, this.hexSize * 0.4)
          .fill({ color, alpha: 0.18 })
          .stroke({ color: 0xffffff, width: 7 })
          .stroke({ color, width: 3 });
      }
      layer.addChild(graphics);
    } else if (name === 'roads') {
      const styles = this.playerStyleMap();
      for (const road of model.roads) {
        layer.addChild(this.roadSprite(road.edge, styles.get(road.seat)?.color ?? 0x49665b));
      }
    } else if (name === 'buildings') {
      const styles = this.playerStyleMap();
      this.buildingNodes.clear();
      if (
        this.hiddenBuilding &&
        !model.buildings.some(
          (building) => building.vertex === this.hiddenBuilding && building.kind === 'settlement',
        )
      )
        this.hiddenBuilding = null;
      for (const building of model.buildings) {
        const point = vertexToPixel(building.vertex, this.hexSize);
        const style = styles.get(building.seat) ?? DEFAULT_PLAYER_STYLE;
        const node = this.buildingNode(building.kind, style, point, building);
        node.visible = building.vertex !== this.hiddenBuilding;
        this.buildingNodes.set(building.vertex, node);
        layer.addChild(node);
      }
    } else if (name === 'knights') {
      this.drawKnightsLayer(layer, model);
    } else if (name === 'ships') {
      this.shipNodes.clear();
      const styles = this.playerStyleMap();
      const ships = (model.ships ?? [])
        .map((ship) => ({ ship, y: edgeToPixel(ship.edge, this.hexSize).midpoint.y }))
        .toSorted((a, b) => a.y - b.y);
      for (const { ship } of ships) {
        const sprite = this.shipSprite(
          ship.edge,
          styles.get(ship.seat)?.color ?? 0x49665b,
          ship.seat,
        );
        if (!sprite) continue;
        sprite.visible = !this.hiddenShips.has(ship.edge);
        this.shipNodes.set(ship.edge, sprite);
        layer.addChild(sprite);
      }
    } else if (name === 'bonus') {
      const chits = this.seafaring?.chits;
      const points = this.graph ? islandBonusPoints(model, this.graph, this.hexSize) : new Map();
      for (const bonus of model.islandBonuses ?? []) {
        const texture = chits?.[bonus.vp <= 1 ? 1 : 2];
        const point = points.get(bonus.vertex);
        if (!texture || !point) continue;
        const sprite = new Sprite(texture);
        sprite.anchor.set(0.5);
        sprite.position.set(point.x, point.y);
        sprite.width = this.hexSize * BONUS_CHIT_SIZE;
        sprite.height = this.hexSize * BONUS_CHIT_SIZE;
        layer.addChild(sprite);
      }
    } else if (name === 'debug') {
      if (!this.debugIslands) return;
      const outlines = new Graphics();
      for (const { island, from, to } of islandBoundarySegments(model.hexes, this.hexSize)) {
        outlines
          .moveTo(from.x, from.y)
          .lineTo(to.x, to.y)
          .stroke({
            color: DEBUG_ISLAND_COLORS[island % DEBUG_ISLAND_COLORS.length] ?? 0xe63946,
            width: 3,
          });
      }
      layer.addChild(outlines);
    } else if (name === 'robber') {
      this.robberSprite = null;
      this.pirateSprite = null;
      const pirateHex = model.hexes.find((candidate) => candidate.id === model.pirateHex);
      const pirateTexture = this.seafaring?.pirate;
      if (pirateHex && pirateTexture) {
        const center = hexToPixel(pirateHex.q, pirateHex.r, this.hexSize);
        const sprite = new Sprite(pirateTexture);
        sprite.anchor.set(0.5, PIRATE_ANCHOR_Y);
        sprite.position.set(center.x, center.y);
        sprite.width = this.hexSize * PIRATE_WIDTH;
        sprite.height = (sprite.width * PIRATE_ART_SIZE.height) / PIRATE_ART_SIZE.width;
        sprite.visible = !this.pirateMoveActive;
        layer.addChild(sprite);
        this.pirateSprite = sprite;
      }
      const hex = model.hexes.find((candidate) => candidate.id === model.robberHex);
      if (hex) {
        const center = hexToPixel(hex.q, hex.r, this.hexSize);
        const sprite = new Sprite(this.textures.robber);
        sprite.anchor.set(0.5, ROBBER_GROUND_ANCHOR);
        sprite.position.set(center.x, center.y);
        sprite.width = this.hexSize * 0.8;
        sprite.height = this.hexSize * 1.15;
        sprite.visible = !this.robberMoveActive;
        layer.addChild(sprite);
        this.robberSprite = sprite;
      }
    }
  }

  /** A knight disc at a vertex: strength in its pips, an active one with a gold rim. */
  private knightSprite(
    vertex: VertexId,
    color: number,
    level: number,
    active: boolean,
  ): Sprite | null {
    const texture = this.knightsArt?.get(knightArtKey(artColorFromNumber(color), level, active));
    if (!texture) return null;
    const point = vertexToPixel(vertex, this.hexSize);
    const unit = this.hexSize / 80;
    const sprite = new Sprite(texture);
    sprite.anchor.set(KNIGHT_ANCHOR.x, KNIGHT_ANCHOR.y);
    sprite.position.set(point.x, point.y);
    sprite.width = KNIGHT_ART.width * unit * KNIGHT_SCALE;
    sprite.height = KNIGHT_ART.height * unit * KNIGHT_SCALE;
    return sprite;
  }

  /** The upright barbarian ship, its bow towards the island of `fixture`. */
  private barbarianShipSprite(fixture: RenderFixture): Sprite | null {
    const texture = this.knightsArt?.get(BARBARIAN_SHIP_KEY);
    if (!texture) return null;
    const unit = (this.hexSize / 80) * 0.8;
    const sprite = new Sprite(texture);
    sprite.anchor.set(BARBARIAN_SHIP_ANCHOR.x, BARBARIAN_SHIP_ANCHOR.y);
    sprite.width = BARBARIAN_SHIP_ART.width * unit;
    sprite.height = BARBARIAN_SHIP_ART.height * unit;
    const layout = barbarianTrackLayout(fixture, this.hexSize, this.barbarianSteps(fixture));
    if (layout?.shipFacesWest) sprite.scale.x = -sprite.scale.x;
    return sprite;
  }

  /** Knights, the merchant, sideways city pieces and the barbarian ship on its track. */
  private drawKnightsLayer(layer: Container, model: RenderModel): void {
    this.knightNodes.clear();
    this.barbarianSprite = null;
    const knights: KnightsRender | undefined = model.knights;
    if (!knights) return;
    const styles = this.playerStyleMap();
    const colorOf = (seat: number): number => styles.get(seat)?.color ?? DEFAULT_PLAYER_STYLE.color;
    const unit = this.hexSize / 80;
    for (const sideways of knights.sideways) {
      const point = vertexToPixel(sideways.vertex, this.hexSize);
      const color = artColorFromNumber(colorOf(sideways.seat));
      const badge = new Sprite(this.textures.cities[color]);
      badge.anchor.set(0.5);
      badge.rotation = Math.PI / 2;
      badge.position.set(
        point.x + this.hexSize * SIDEWAYS_OFFSET.x,
        point.y + this.hexSize * SIDEWAYS_OFFSET.y,
      );
      badge.width = this.hexSize * 0.42;
      badge.height = this.hexSize * 0.44;
      layer.addChild(badge);
    }
    const pieces = [...knights.pieces].toSorted(
      (a, b) => vertexToPixel(a.vertex, this.hexSize).y - vertexToPixel(b.vertex, this.hexSize).y,
    );
    for (const piece of pieces) {
      const sprite = this.knightSprite(
        piece.vertex,
        colorOf(piece.seat),
        piece.level,
        piece.active,
      );
      if (!sprite) continue;
      sprite.visible = !this.hiddenKnights.has(piece.vertex);
      this.knightNodes.set(piece.vertex, sprite);
      layer.addChild(sprite);
    }
    if (knights.merchant) {
      const hex = model.hexes.find((candidate) => candidate.id === knights.merchant?.hex);
      const texture = this.knightsArt?.get(
        merchantArtKey(artColorFromNumber(colorOf(knights.merchant.seat))),
      );
      if (hex && texture) {
        const center = hexToPixel(hex.q, hex.r, this.hexSize);
        const sprite = new Sprite(texture);
        sprite.anchor.set(MERCHANT_ANCHOR.x, MERCHANT_ANCHOR.y);
        sprite.position.set(
          center.x + this.hexSize * MERCHANT_OFFSET.x,
          center.y + this.hexSize * MERCHANT_OFFSET.y,
        );
        sprite.width = MERCHANT_ART.width * unit * 1.1;
        sprite.height = MERCHANT_ART.height * unit * 1.1;
        layer.addChild(sprite);
      }
    }
    const track = knights.barbarians;
    const fixture = track
      ? model.fixtures?.find((candidate) => candidate.id === track.fixture)
      : null;
    if (track && fixture) {
      const at = barbarianStepPoint(fixture, this.hexSize, track.step, track.steps);
      const sprite = this.barbarianShipSprite(fixture);
      if (at && sprite) {
        sprite.position.set(at.x, at.y);
        sprite.visible = !this.barbarianHidden;
        this.barbarianSprite = sprite;
        layer.addChild(sprite);
      }
    }
  }

  private setBarbarianHidden(hidden: boolean): void {
    this.barbarianHidden = hidden;
    if (this.barbarianSprite) this.barbarianSprite.visible = !hidden;
  }

  private applyHiddenKnights(): void {
    for (const [vertex, sprite] of this.knightNodes)
      sprite.visible = !this.hiddenKnights.has(vertex);
  }

  private drawHarbor(layer: Container, edgeId: EdgeId, kind: string): void {
    if (!this.model || !this.graph) return;
    const placed = harborOnBoard(this.model, this.graph, edgeId, this.hexSize);
    if (!placed) return;
    const { layout, landCenter } = placed;

    const texture = this.textures.harbors[kind === 'generic' ? '3to1' : kind];
    if (!texture) return;
    const outward = { x: layout.midpoint.x - landCenter.x, y: layout.midpoint.y - landCenter.y };
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, 0.23);
    sprite.position.set(layout.hub.x, layout.hub.y);
    sprite.width = this.hexSize * 1.25;
    sprite.height = this.hexSize * 1.25;
    sprite.rotation = Math.atan2(outward.y, outward.x) + Math.PI / 2;
    layer.addChild(sprite);
  }

  /** Steps of the barbarian track on `fixture`, as the model gives them. */
  private barbarianSteps(fixture: RenderFixture): number {
    const barbarians = this.model?.knights?.barbarians;
    return barbarians?.fixture === fixture.id ? barbarians.steps : DEFAULT_BARBARIAN_STEPS;
  }

  /**
   * The barbarian track composed on its footprint: the joined sea tile for the footprint's axis,
   * the dotted route, and the start, numbered steps and island as upright sprites along it.
   */
  private barbarianTrack(fixture: RenderFixture): Container | null {
    const art = this.knightsArt;
    const layout = barbarianTrackLayout(fixture, this.hexSize, this.barbarianSteps(fixture));
    if (!art || !layout) return null;
    const track = new Container();
    track.label = `fixture:${fixture.id}`;
    const place = (piece: (typeof layout)['tile']): void => {
      const texture = art.get(piece.key);
      if (!texture) return;
      const sprite = new Sprite(texture);
      sprite.anchor.set(piece.anchor.x, piece.anchor.y);
      sprite.position.set(piece.at.x, piece.at.y);
      sprite.width = piece.width;
      sprite.height = piece.height;
      sprite.rotation = piece.rotation;
      track.addChild(sprite);
    };
    place(layout.tile);
    const unit = this.hexSize / 80;
    const dots = new Graphics();
    for (const dot of routeDots(layout.route, 6 * unit)) dots.circle(dot.x, dot.y, 1.1 * unit);
    track.addChild(dots.fill({ color: 0xe9f7f8, alpha: 0.95 }));
    for (const marker of layout.markers) place(marker);
    return track;
  }

  /** The fixture under a client point, when a fixture handler is registered. */
  fixtureAt(clientPoint: ScreenPoint): string | null {
    if (!this.onFixtureSelect || !this.model?.fixtures?.length) return null;
    return hitTestFixture(this.screenToBoard(clientPoint), this.model.fixtures, this.hexSize);
  }

  private pluginSlices(band: RenderLayerPlugin['band']): unknown[] {
    return this.plugins
      .filter((plugin) => plugin.band === band)
      .map((plugin) => [plugin.id, this.model?.layers?.[plugin.id] ?? null]);
  }

  /** True for a board that lists its own sea hexes, which is how seafaring boards are made. */
  private hasSeaHexes(): boolean {
    return this.model?.hexes.some((hex) => hex.terrain === 'sea') ?? false;
  }

  private isStandardFootprint(): boolean {
    if (!this.model || this.model.hexes.length !== 19) return false;
    const cells = new Set(this.model.hexes.map(({ q, r }) => `${q},${r}`));
    for (let q = -2; q <= 2; q += 1) {
      for (let r = -2; r <= 2; r += 1) {
        if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= 2 && !cells.has(`${q},${r}`))
          return false;
      }
    }
    return true;
  }

  private waterCells(): { q: number; r: number; center: Point }[] {
    if (!this.model) return [];
    const occupied = new Set(this.model.hexes.map((hex) => `${hex.q},${hex.r}`));
    const water = new Map<string, { q: number; r: number; center: Point }>();
    for (const hex of this.model.hexes) {
      for (const offset of HEX_NEIGHBORS) {
        const q = hex.q + offset.q;
        const r = hex.r + offset.r;
        const key = `${q},${r}`;
        if (!occupied.has(key)) water.set(key, { q, r, center: hexToPixel(q, r, this.hexSize) });
      }
    }
    return [...water.values()];
  }

  private waterCenters(): Point[] {
    return this.waterCells().map(({ center }) => center);
  }

  private drawTerrainTile(layer: Container, center: Point, texture: Texture): void {
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.position.set(center.x, center.y);
    sprite.width = (150 / 80) * this.hexSize;
    sprite.height = (174 / 80) * this.hexSize;
    layer.addChild(sprite);
    layer.addChild(
      new Graphics()
        .poly(hexCorners(center, this.hexSize), true)
        .stroke({ color: 0xf5f8f5, width: 1.5 }),
    );
  }

  private playerStyleMap(): Map<number, BoardAppearance['players'][number]> {
    return new Map(this.appearance.players.map((style) => [style.seat, style]));
  }

  private resizeAndClamp(): void {
    if (this.destroyed) return;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    let resized = false;
    if (
      width > 0 &&
      height > 0 &&
      (this.app.screen.width !== width || this.app.screen.height !== height)
    ) {
      this.app.renderer.resize(width, height);
      resized = true;
    }
    if (!resized) return;
    if (this.model) this.fitToBoard();
    // Resizing clears the canvas immediately. Draw before the browser can paint a blank frame.
    this.renderFrameNow();
  }

  private clampCamera(): void {
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    const bounds = this.fitPixelBounds();
    if (!bounds) return;
    const margin = FIT_PADDING;
    this.cameraX = clampCameraAxis(
      this.cameraX,
      bounds.minX,
      bounds.maxX,
      width,
      this.zoom,
      margin,
    );
    this.cameraY = clampCameraAxis(
      this.cameraY,
      bounds.minY,
      bounds.maxY,
      height,
      this.zoom,
      margin,
    );
  }

  private boardPixelBounds(): {
    readonly minX: number;
    readonly maxX: number;
    readonly minY: number;
    readonly maxY: number;
  } | null {
    if (!this.model?.hexes.length) return null;
    if (this.isStandardFootprint()) {
      // The authored 1120×1040 frame uses an 80-unit hex radius and is centered at (0, 0).
      return {
        minX: -this.hexSize * 7,
        maxX: this.hexSize * 7,
        minY: -this.hexSize * 6.5,
        maxY: this.hexSize * 6.5,
      };
    }
    // The scenery water ring and the wooden frame around it are part of the picture, so the
    // whole thing is fitted, not only the game hexes. Seafaring boards keep a little more water.
    return hexExtents(
      [...this.model.hexes, ...this.waterCells()],
      this.hexSize,
      this.hexSize * (this.hasSeaHexes() ? SEA_FIT_MARGIN : FRAME_GROWTH),
    );
  }

  private fitPixelBounds(): {
    readonly minX: number;
    readonly maxX: number;
    readonly minY: number;
    readonly maxY: number;
  } | null {
    const board = this.boardPixelBounds();
    if (!board || !this.model) return null;
    let { minX, maxX, minY, maxY } = board;
    const fixtures = hexExtents(
      (this.model.fixtures ?? []).flatMap((fixture) => fixture.footprint),
      this.hexSize,
      this.hexSize * FRAME_GROWTH,
    );
    if (fixtures) {
      minX = Math.min(minX, fixtures.minX);
      maxX = Math.max(maxX, fixtures.maxX);
      minY = Math.min(minY, fixtures.minY);
      maxY = Math.max(maxY, fixtures.maxY);
    }
    const badgeRadius = this.hexSize * 0.8;
    for (const harbor of this.model.harbors) {
      const layout = this.graph
        ? harborOnBoard(this.model, this.graph, harbor.edge, this.hexSize)?.layout
        : undefined;
      if (!layout) continue;
      minX = Math.min(minX, layout.hub.x - badgeRadius);
      maxX = Math.max(maxX, layout.hub.x + badgeRadius);
      minY = Math.min(minY, layout.hub.y - badgeRadius);
      maxY = Math.max(maxY, layout.hub.y + badgeRadius);
    }
    return { minX, maxX, minY, maxY };
  }

  private updateCamera(): void {
    this.camera.position.set(this.cameraX, this.cameraY);
    this.camera.scale.set(this.zoom);
    const signature = `${this.cameraX},${this.cameraY},${this.zoom},${this.app.screen.width},${this.app.screen.height}`;
    if (signature === this.viewSignature) return;
    this.viewSignature = signature;
    for (const listener of this.viewChangeListeners) listener();
  }

  private renderFrame(): void {
    if (this.destroyed || this.renderFrameId !== 0) return;
    this.renderFrameId = requestAnimationFrame(() => {
      this.renderFrameId = 0;
      if (!this.destroyed) {
        this.app.render();
        this.renderedFrames += 1;
        this.destroyDetachedChildren();
      }
    });
  }

  private renderFrameNow(): void {
    if (this.destroyed) return;
    if (this.renderFrameId !== 0) cancelAnimationFrame(this.renderFrameId);
    this.renderFrameId = 0;
    this.app.render();
    this.renderedFrames += 1;
    this.destroyDetachedChildren();
  }

  private destroyDetachedChildren(): void {
    for (const child of this.detachedChildren.splice(0)) child.destroy({ children: true });
  }

  private zoomAt(client: ScreenPoint, factor: number): void {
    const before = this.screenToBoard(client);
    this.zoom = Math.max(this.minZoom, Math.min(MAX_ZOOM, this.zoom * factor));
    const rect = this.app.canvas.getBoundingClientRect();
    const scaleX = this.app.screen.width / rect.width || 1;
    const scaleY = this.app.screen.height / rect.height || 1;
    this.cameraX = (client.x - rect.left) * scaleX - before.x * this.zoom;
    this.cameraY = (client.y - rect.top) * scaleY - before.y * this.zoom;
    this.clampCamera();
    this.updateCamera();
    this.renderFrame();
  }

  private bindInput(): void {
    const canvas = this.app.canvas;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('lostpointercapture', this.onPointerCancel);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDoubleClick);
  }

  private unbindInput(): void {
    const canvas = this.app.canvas;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    canvas.removeEventListener('lostpointercapture', this.onPointerCancel);
    canvas.removeEventListener('wheel', this.onWheel);
    canvas.removeEventListener('dblclick', this.onDoubleClick);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.destroyed) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.app.canvas.setPointerCapture(event.pointerId);
    if (this.pointers.size === 1)
      this.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    else if (this.pointers.size === 2) {
      const [first, second] = [...this.pointers.values()];
      if (first && second)
        this.pinch = {
          distance: Math.hypot(second.x - first.x, second.y - first.y),
          zoom: this.zoom,
          x: (first.x + second.x) / 2,
          y: (first.y + second.y) / 2,
        };
      this.drag = null;
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.destroyed) return;
    const old = this.pointers.get(event.pointerId);
    if (old) this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pinch && this.pointers.size >= 2) {
      const [first, second] = [...this.pointers.values()];
      if (first && second) {
        const nextDistance = Math.hypot(second.x - first.x, second.y - first.y);
        const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
        const worldAnchor = this.screenToBoard({ x: this.pinch.x, y: this.pinch.y });
        this.zoom = Math.max(
          this.minZoom,
          Math.min(MAX_ZOOM, this.pinch.zoom * (nextDistance / Math.max(1, this.pinch.distance))),
        );
        const rect = this.app.canvas.getBoundingClientRect();
        const scaleX = this.app.screen.width / rect.width || 1;
        const scaleY = this.app.screen.height / rect.height || 1;
        const camera = cameraPositionAtAnchor(
          worldAnchor,
          { x: (center.x - rect.left) * scaleX, y: (center.y - rect.top) * scaleY },
          this.zoom,
        );
        this.cameraX = camera.x;
        this.cameraY = camera.y;
        this.pinch = { distance: nextDistance, zoom: this.zoom, ...center };
        this.clampCamera();
        this.updateCamera();
        this.renderFrame();
      }
      return;
    }
    if (this.drag && this.drag.pointerId === event.pointerId && old) {
      const dx = event.clientX - old.x;
      const dy = event.clientY - old.y;
      if (Math.hypot(event.clientX - this.drag.x, event.clientY - this.drag.y) > 5)
        this.drag.moved = true;
      if (this.drag.moved) {
        this.cameraX += dx;
        this.cameraY += dy;
        this.clampCamera();
        this.updateCamera();
        this.renderFrame();
      }
    }
    const hit = this.hitTest({ x: event.clientX, y: event.clientY });
    this.app.canvas.style.cursor = hit && this.isLegalHighlight(hit) ? 'pointer' : '';
    if (!sameHit(hit, this.lastHit)) {
      this.lastHit = hit;
      this.onHover?.(hit);
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.destroyed) return;
    const drag = this.drag;
    this.pointers.delete(event.pointerId);
    if (this.app.canvas.hasPointerCapture(event.pointerId))
      this.app.canvas.releasePointerCapture(event.pointerId);
    if (drag?.pointerId === event.pointerId && !drag.moved && this.pointers.size === 0) {
      const point = { x: event.clientX, y: event.clientY };
      const hit = this.hitTest(point);
      if (hit) this.onSelect?.(hit);
      const fixture = hit ? null : this.fixtureAt(point);
      if (fixture !== null) {
        this.onFixtureSelect?.(fixture);
        this.lastTap = null;
        this.drag = null;
        if (this.pointers.size < 2) this.pinch = null;
        return;
      }
      if (hit && this.isLegalHighlight(hit)) {
        this.lastTap = null;
      } else {
        const now = performance.now();
        const prior = this.lastTap;
        if (
          prior &&
          now - prior.time < 300 &&
          Math.hypot(point.x - prior.x, point.y - prior.y) < 24
        ) {
          this.fitToBoard();
          this.lastTap = null;
        } else {
          this.lastTap = { time: now, ...point };
        }
      }
    }
    this.drag = null;
    if (this.pointers.size < 2) this.pinch = null;
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.destroyed) return;
    this.pointers.delete(event.pointerId);
    this.drag = null;
    this.pinch = null;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (this.destroyed) return;
    event.preventDefault();
    this.zoomAt({ x: event.clientX, y: event.clientY }, Math.exp(-event.deltaY * 0.001));
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (this.destroyed) return;
    event.preventDefault();
    const hit = this.hitTest({ x: event.clientX, y: event.clientY });
    if (!hit || !this.isLegalHighlight(hit)) this.fitToBoard();
  };
}

export async function createBoardRenderer(
  host: HTMLElement,
  options?: BoardRendererOptions,
): Promise<BoardRenderer> {
  return PixiBoardRenderer.create(host, options);
}

export type { EdgeId, HexId, VertexId };
