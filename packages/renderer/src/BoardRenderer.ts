import { Application, Container, Graphics, Sprite, Text } from 'pixi.js';
import type { Texture } from 'pixi.js';
import { buildBoardGraph, edgeToPixel, hexToPixel, vertexToPixel } from '@cp2p/engine/geometry';
import type { BoardGraph, EdgeId, HexId, Point, VertexId } from '@cp2p/engine/geometry';
import { hitTestBoard } from './input/hitTest.js';
import { cameraPositionAtAnchor, clampCameraAxis } from './input/camera.js';
import { loadBoardTextures } from './assets/terrainTextures.js';
import type { BoardTextures } from './assets/terrainTextures.js';
import { sameAppearance } from './appearance.js';
import { diceMotion, robberPosition } from './effectMotion.js';
import { harborLayout } from './harborLayout.js';
import { tokenFontSize, tokenPipRadius, tokenPips } from './tokenLayout.js';
import type {
  BoardAppearance,
  BoardRendererDiagnostics,
  BoardEffect,
  BoardFocusPreview,
  BoardHighlights,
  BoardHit,
  BoardRenderer,
  BoardRendererOptions,
  RenderModel,
  ScreenPoint,
} from './types.js';

// Pixi Graphics.fill() is a drawing method; this rule's Array.fill suggestion is a false positive.
/* oxlint-disable unicorn/no-array-fill-with-reference-type */

const HEX_SIZE = 54;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 3.2;
const HARBOR_MARKER_SCALE = 0.96;
const ROAD_LENGTH = 0.74;
const ROAD_THICKNESS = 0.18;
const LANE_INSET = 0.22;
const LANE_WIDTH = 0.15;
const LANE_DASHES = 3;
const LANE_DASH_LENGTH = 0.12;
const LANE_DASH_WIDTH = 0.06;
const EDGE_RING_LENGTH = 0.82;
const EDGE_RING_HEIGHT = 0.32;
const EDGE_INK = 0x18332b;
const EDGE_PAPER = 0xfcfdfc;
const DARK_BOARD_BACKDROP = 0x17191c;
const SITE_HALO = 0.2;
const SITE_RING = 0.11;
const SITE_RING_WIDTH = 0.04;
const BRACKET_HALF = 0.46;
const BRACKET_ARM = 0.16;
const BADGE_RADIUS = 0.13;
const PREVIEW_CORNER = 0.12;
const LAYER_NAMES = [
  'background',
  'terrain',
  'harbors',
  'tokens',
  'roads',
  'edgeTargets',
  'edgeFocus',
  'buildings',
  'robber',
  'highlights',
  'focus',
  'effects',
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
const DICE_DOTS: readonly (readonly Point[])[] = [
  [{ x: 0, y: 0 }],
  [
    { x: -1, y: -1 },
    { x: 1, y: 1 },
  ],
  [
    { x: -1, y: -1 },
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: -1, y: 1 },
    { x: 1, y: 1 },
  ],
  [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 0, y: 0 },
    { x: -1, y: 1 },
    { x: 1, y: 1 },
  ],
  [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: -1, y: 1 },
    { x: 1, y: 1 },
  ],
];
const HARBOR_RESOURCE: Readonly<Record<string, 'brick' | 'lumber' | 'wool' | 'grain' | 'ore'>> = {
  brick: 'brick',
  lumber: 'lumber',
  wool: 'wool',
  grain: 'grain',
  ore: 'ore',
};

const DEFAULT_PLAYER_STYLE = { color: 0x0072b2, marker: 'circle' } as const;
const DEFAULT_PLAYERS: BoardAppearance['players'] = [
  { seat: 0, color: 0x0072b2, marker: 'circle' },
  { seat: 1, color: 0xd55e00, marker: 'triangle' },
  { seat: 2, color: 0x009e73, marker: 'square' },
  { seat: 3, color: 0xb35b93, marker: 'diamond' },
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

function markerShape(
  graphics: Graphics,
  x: number,
  y: number,
  color: number,
  marker: BoardAppearance['players'][number]['marker'],
  radius: number,
): void {
  if (marker === 'circle') graphics.circle(x, y, radius);
  else if (marker === 'square') graphics.rect(x - radius, y - radius, radius * 2, radius * 2);
  else if (marker === 'diamond')
    graphics.poly([x, y - radius, x + radius, y, x, y + radius, x - radius, y], true);
  else graphics.poly([x, y - radius, x + radius, y + radius, x - radius, y + radius], true);
  graphics.fill({ color }).stroke({ color: 0x18332b, width: 2 });
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
  private readonly detachedChildren: Container[] = [];
  private readonly activeEffects = new Map<
    string,
    {
      readonly kind: BoardEffect['kind'];
      readonly node: Container;
      readonly update: (progress: number) => boolean;
      readonly started: number;
      readonly duration: number;
    }
  >();
  private readonly recentEffectIds = new Set<string>();
  private effectFrame = 0;
  private robberSprite: Sprite | null = null;
  private robberMoveActive = false;
  private readonly signatures = new Map<LayerName, string>();
  private readonly viewChangeListeners = new Set<() => void>();
  private viewSignature = '';
  private readonly onSelect?: BoardRendererOptions['onSelect'];
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
  ) {
    this.app = app;
    this.host = host;
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
      terrain: new Container(),
      harbors: new Container(),
      tokens: new Container(),
      roads: new Container(),
      edgeTargets: new Container(),
      edgeFocus: new Container(),
      buildings: new Container(),
      robber: new Container(),
      highlights: new Container(),
      focus: new Container(),
      effects: new Container(),
    };
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
        backgroundColor: options.appearance?.theme === 'dark' ? DARK_BOARD_BACKDROP : 0xd1e7e9,
        preference: 'webgl',
      });
      const hexSize = options.hexSize ?? HEX_SIZE;
      const textures = await loadBoardTextures(
        devicePixelRatio,
        options.maxPixelRatio ?? 2,
        MAX_ZOOM,
        hexSize,
      );
      return new PixiBoardRenderer(host, app, options, textures);
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
    this.graph = buildBoardGraph(model.hexes);
    this.drawChanged('background', [this.appearance.theme]);
    this.drawChanged('terrain', [model.hexes]);
    this.drawChanged('harbors', [model.harbors]);
    this.drawChanged('tokens', [model.hexes.map(({ id, q, r, token }) => ({ id, q, r, token }))]);
    this.drawChanged('roads', [model.roads, this.appearance.players]);
    this.drawChanged('buildings', [model.buildings, this.appearance.players]);
    this.drawChanged('robber', [model.robberHex, model.pirateHex]);
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
      this.traceEdgeLane(lanes, dashes, endpoints[0], endpoints[1]);
      hasEdgeGeometry = true;
    }
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
      lanes.stroke({
        color: EDGE_INK,
        alpha: 0.32,
        width: this.hexSize * LANE_WIDTH,
        cap: 'round',
      });
      dashes.stroke({
        color: EDGE_PAPER,
        width: this.hexSize * LANE_DASH_WIDTH,
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
        this.focusPreview?.color === preview?.color &&
        this.focusPreview?.marker === preview?.marker)
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
      if (effect.kind === 'robber-move') this.cancelRobberMove();
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
    for (const { node } of this.activeEffects.values()) this.retireNode(node);
    this.activeEffects.clear();
    this.setRobberMoveActive(false);
    this.renderFrame();
  }

  getDiagnostics(): BoardRendererDiagnostics {
    return {
      renderedFrames: this.renderedFrames,
      rebuiltLayers: this.rebuiltLayers,
      activeEffects: this.activeEffects.size,
      queuedDisposals: this.detachedChildren.length,
    };
  }

  private createEffect(effect: BoardEffect): {
    readonly node: Container;
    readonly update: (progress: number) => boolean;
    readonly duration: number;
  } | null {
    const node = new Container();
    const duration = effect.kind === 'dice-roll' ? 700 : 420;
    if (effect.kind === 'dice-roll') {
      if (effect.dice.some((face) => !Number.isInteger(face) || face < 1 || face > 6)) return null;
      const faceSize = Math.min(64, Math.max(56, this.app.screen.width * 0.07));
      const gap = Math.max(10, faceSize * 0.2);
      node.position.set(this.app.screen.width / 2, this.app.screen.height / 2);
      for (const [index, face] of effect.dice.entries()) {
        const die = new Container();
        die.position.set(index === 0 ? -(faceSize + gap) / 2 : (faceSize + gap) / 2, 0);
        die.addChild(
          new Graphics()
            .roundRect(-faceSize / 2, -faceSize / 2, faceSize, faceSize, faceSize * 0.16)
            .fill({ color: 0xffffff })
            .stroke({ color: 0x18332b, width: Math.max(2, faceSize * 0.04) }),
        );
        const faceGraphics = new Graphics();
        const spots = DICE_DOTS[face - 1];
        if (spots) {
          for (const spot of spots)
            faceGraphics
              .circle(spot.x * faceSize * 0.19, spot.y * faceSize * 0.19, faceSize * 0.075)
              .fill({ color: 0x18332b });
          die.addChild(faceGraphics);
        }
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
    if (effect.kind === 'piece-pop') {
      const point = this.pointForHit(effect.at);
      if (!point) return null;
      node.position.set(point.x, point.y);
      const texture =
        effect.piece === 'road'
          ? this.textures.road
          : effect.piece === 'city'
            ? this.textures.city
            : this.textures.settlement;
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.position.set(0, 0);
      const size = effect.piece === 'road' ? this.hexSize * 0.72 : this.hexSize * 0.5;
      sprite.width = size;
      sprite.height = effect.piece === 'road' ? this.hexSize * 0.14 : size;
      sprite.tint = this.playerStyleMap().get(effect.seat)?.color ?? DEFAULT_PLAYER_STYLE.color;
      if (effect.piece === 'road' && effect.at.kind === 'edge')
        sprite.rotation = edgeToPixel(effect.at.id, this.hexSize).angle;
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
    const from = this.model?.hexes.find((hex) => hex.id === effect.fromHex);
    const to = this.model?.hexes.find((hex) => hex.id === effect.toHex);
    if (!from || !to) return null;
    const sprite = new Sprite(this.textures.robber);
    sprite.anchor.set(0.5);
    sprite.width = this.hexSize * 0.52;
    sprite.height = this.hexSize * 0.52;
    node.addChild(sprite);
    this.layers.effects.addChild(node);
    const start = hexToPixel(from.q, from.r, this.hexSize);
    const end = hexToPixel(to.q, to.r, this.hexSize);
    this.setRobberMoveActive(true);
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

  private readonly tickEffects = (now: number): void => {
    this.effectFrame = 0;
    if (this.destroyed) return;
    for (const [id, effect] of this.activeEffects) {
      if (effect.update(Math.min(1, (now - effect.started) / effect.duration))) {
        this.retireNode(effect.node);
        this.activeEffects.delete(id);
        if (effect.kind === 'robber-move') this.setRobberMoveActive(false);
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

  private cancelRobberMove(): void {
    for (const [id, effect] of this.activeEffects) {
      if (effect.kind !== 'robber-move') continue;
      this.retireNode(effect.node);
      this.activeEffects.delete(id);
    }
    this.setRobberMoveActive(false);
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
    const edge = edgeToPixel(id, this.hexSize);
    const sprite = new Sprite(this.textures.road);
    sprite.anchor.set(0.5);
    sprite.position.set(edge.midpoint.x, edge.midpoint.y);
    sprite.width = this.hexSize * ROAD_LENGTH;
    sprite.height = this.hexSize * ROAD_THICKNESS;
    sprite.rotation = edge.angle;
    sprite.tint = color;
    return sprite;
  }

  private buildingNode(
    kind: 'settlement' | 'city',
    style: Pick<BoardAppearance['players'][number], 'color' | 'marker'>,
    point: Point,
  ): Container {
    const size = kind === 'city' ? 14 : 12;
    const node = new Container();
    node.position.set(point.x, point.y);
    const marker = new Graphics();
    markerShape(marker, 0, 0, style.color, style.marker, size + 5);
    const sprite = new Sprite(kind === 'city' ? this.textures.city : this.textures.settlement);
    sprite.anchor.set(0.5);
    sprite.width = size * 2;
    sprite.height = size * 2;
    node.addChild(marker, sprite);
    return node;
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
    this.app.renderer.background.color =
      appearance.theme === 'dark' ? DARK_BOARD_BACKDROP : 0xd1e7e9;
    this.signatures.delete('background');
    this.signatures.delete('roads');
    this.signatures.delete('buildings');
    if (!this.model) return;
    this.drawChanged('background', [appearance.theme]);
    this.drawChanged('roads', [this.model.roads, this.appearance.players]);
    this.drawChanged('buildings', [this.model.buildings, this.appearance.players]);
    this.renderFrame();
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
    this.zoom = Math.max(
      MIN_ZOOM,
      Math.min(
        MAX_ZOOM,
        Math.min((this.app.screen.width - 24) / width, (this.app.screen.height - 24) / height),
      ),
    );
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    this.cameraX = this.app.screen.width / 2 - centerX * this.zoom;
    this.cameraY = this.app.screen.height / 2 - centerY * this.zoom;
    this.clampCamera();
    this.updateCamera();
    this.renderFrame();
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
    for (const { node } of this.activeEffects.values()) node.destroy({ children: true });
    this.activeEffects.clear();
    this.viewChangeListeners.clear();
    this.app.destroy(true, { children: true, texture: false, textureSource: false });
    this.destroyDetachedChildren();
  }

  private drawChanged(name: LayerName, value: unknown): void {
    const signature = JSON.stringify(value);
    if (this.signatures.get(name) === signature) return;
    this.signatures.set(name, signature);
    this.rebuiltLayers += 1;
    const layer = this.layers[name];
    this.detachedChildren.push(...layer.removeChildren());
    const model = this.model;
    if (!model) return;
    if (name === 'background') {
      const color = this.appearance.theme === 'dark' ? DARK_BOARD_BACKDROP : 0xd1e7e9;
      layer.addChild(new Graphics().rect(-8192, -8192, 16384, 16384).fill({ color }));
    } else if (name === 'terrain') {
      for (const center of this.waterCenters())
        this.drawTerrainTile(layer, center, this.textures.terrain.sea);

      for (const hex of model.hexes) {
        const center = hexToPixel(hex.q, hex.r, this.hexSize);
        const textureKey = TERRAIN_TEXTURES[hex.terrain];
        if (textureKey) this.drawTerrainTile(layer, center, this.textures.terrain[textureKey]);
      }
    } else if (name === 'harbors') {
      for (const harbor of model.harbors) this.drawHarbor(layer, harbor.edge, harbor.kind);
    } else if (name === 'tokens') {
      for (const hex of model.hexes) {
        if (hex.token === null) continue;
        const center = hexToPixel(hex.q, hex.r, this.hexSize);
        const token = new Container();
        token.position.set(center.x, center.y);
        const face = new Sprite(this.textures.numberToken);
        face.anchor.set(0.5);
        face.width = this.hexSize * 0.82;
        face.height = this.hexSize * 0.82;
        token.addChild(face);
        const pipColor = hex.token === 6 || hex.token === 8 ? 0xae3329 : 0x49665b;
        const pips = tokenPips(hex.token, this.hexSize);
        if (pips.length > 0) {
          const graphics = new Graphics();
          for (const pip of pips) {
            graphics.circle(pip.x, pip.y, tokenPipRadius(this.hexSize)).fill({ color: pipColor });
          }
          token.addChild(graphics);
        }
        const text = new Text({
          text: String(hex.token),
          style: {
            fontFamily: 'system-ui, sans-serif',
            fontSize: tokenFontSize(this.hexSize),
            fill: hex.token === 6 || hex.token === 8 ? 0xae3329 : 0x18332b,
            fontWeight: '700',
          },
          resolution: this.app.renderer.resolution * MAX_ZOOM,
        });
        text.anchor.set(0.5);
        text.position.set(0, -this.hexSize * 0.06);
        token.addChild(text);
        layer.addChild(token);
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
        if (this.focusPreview && this.focusPreview.piece !== 'road') return;
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
        if (this.focusPreview)
          this.layers.edgeFocus.addChild(this.roadSprite(hit.id, this.focusPreview.color));
        return;
      } else {
        const previewPiece = this.focusPreview?.piece;
        if (previewPiece === 'road') return;
        const point = vertexToPixel(hit.id, this.hexSize);
        if (this.graph?.vertexIndex[hit.id] === undefined) return;
        const existing = model.buildings.find((building) => building.vertex === hit.id);
        if (this.focusPreview && previewPiece) {
          if (existing?.kind === this.focusPreview.piece) return;
          const half = this.hexSize * BRACKET_HALF;
          const corner = this.hexSize * PREVIEW_CORNER;
          const preview = this.buildingNode(
            previewPiece,
            {
              color: this.focusPreview.color,
              marker: this.focusPreview.marker ?? 'circle',
            },
            point,
          );
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
        const node = this.buildingNode(building.kind, style, point);
        node.visible = building.vertex !== this.hiddenBuilding;
        this.buildingNodes.set(building.vertex, node);
        layer.addChild(node);
      }
    } else if (name === 'robber') {
      this.robberSprite = null;
      const hex = model.hexes.find((candidate) => candidate.id === model.robberHex);
      if (hex) {
        const center = hexToPixel(hex.q, hex.r, this.hexSize);
        const sprite = new Sprite(this.textures.robber);
        sprite.anchor.set(0.5);
        sprite.position.set(center.x, center.y);
        sprite.width = this.hexSize * 0.52;
        sprite.height = this.hexSize * 0.52;
        sprite.visible = !this.robberMoveActive;
        layer.addChild(sprite);
        this.robberSprite = sprite;
      }
    }
  }

  private drawHarbor(layer: Container, edgeId: EdgeId, kind: string): void {
    const model = this.model;
    const graph = this.graph;
    const edgeIndex = graph?.edgeIndex[edgeId];
    if (!model || !graph || edgeIndex === undefined) return;
    const endpoints = graph.edgeVertices[edgeIndex];
    if (!endpoints) return;
    const first = vertexToPixel(endpoints[0], this.hexSize);
    const second = vertexToPixel(endpoints[1], this.hexSize);
    const landHexId = graph.edgeHexes[edgeIndex]?.find((id) => {
      const hex = model.hexes.find((candidate) => candidate.id === id);
      return hex !== undefined && hex.terrain !== 'sea';
    });
    const landHex = model.hexes.find((hex) => hex.id === landHexId);
    if (!landHex) return;

    const landCenter = hexToPixel(landHex.q, landHex.r, this.hexSize);
    const layout = harborLayout(first, second, landCenter);
    if (!layout) return;

    const jetty = new Sprite(this.textures.harborJetty);
    jetty.anchor.set(0.5, 104 / 112);
    jetty.position.set(layout.midpoint.x, layout.midpoint.y);
    jetty.width = 128 * layout.scale;
    jetty.height = 112 * layout.scale;
    jetty.scale.y *= layout.verticalFlip;
    jetty.rotation = layout.angle;
    layer.addChild(jetty);

    const badge = new Container();
    badge.position.set(layout.hub.x, layout.hub.y);
    const marker = new Sprite(this.textures.harborMarker);
    marker.anchor.set(0.5);
    marker.position.set(0, 0);
    marker.width = this.hexSize * HARBOR_MARKER_SCALE;
    marker.height = this.hexSize * HARBOR_MARKER_SCALE;
    badge.addChild(marker);

    const resource = HARBOR_RESOURCE[kind];
    if (resource) {
      const icon = new Sprite(this.textures.resources[resource]);
      icon.anchor.set(0.5);
      icon.position.set(0, -this.hexSize * 0.17);
      icon.width = this.hexSize * 0.29;
      icon.height = this.hexSize * 0.29;
      badge.addChild(icon);
    }
    const generic = kind === 'generic';
    const label = new Text({
      text: generic ? '3:1' : resource ? '2:1' : this.harborLabelFormatter(kind),
      style: {
        fontFamily: 'system-ui, sans-serif',
        fontSize: this.hexSize * (generic ? 0.3 : 0.23),
        fill: 0x18332b,
        fontWeight: '700',
      },
      resolution: this.app.renderer.resolution * MAX_ZOOM,
    });
    label.anchor.set(0.5);
    label.position.set(0, this.hexSize * (generic ? -0.06 : 0.1));
    badge.addChild(label);
    layer.addChild(badge);
  }

  private waterCenters(): Point[] {
    if (!this.model) return [];
    const occupied = new Set(this.model.hexes.map((hex) => `${hex.q},${hex.r}`));
    const water = new Map<string, Point>();
    for (const hex of this.model.hexes) {
      for (const offset of HEX_NEIGHBORS) {
        const q = hex.q + offset.q;
        const r = hex.r + offset.r;
        const key = `${q},${r}`;
        if (!occupied.has(key)) water.set(key, hexToPixel(q, r, this.hexSize));
      }
    }
    return [...water.values()];
  }

  private drawTerrainTile(layer: Container, center: Point, texture: Texture): void {
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.position.set(center.x, center.y);
    sprite.width = Math.sqrt(3) * this.hexSize;
    sprite.height = this.hexSize * 2;
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
    else this.renderFrame();
  }

  private clampCamera(): void {
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    const bounds = this.boardPixelBounds();
    if (!bounds) return;
    const margin = 24;
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
    const centers = [
      ...this.model.hexes.map((hex) => hexToPixel(hex.q, hex.r, this.hexSize)),
      ...this.waterCenters(),
    ];
    return {
      minX: Math.min(...centers.map((point) => point.x)) - this.hexSize,
      maxX: Math.max(...centers.map((point) => point.x)) + this.hexSize,
      minY: Math.min(...centers.map((point) => point.y)) - this.hexSize,
      maxY: Math.max(...centers.map((point) => point.y)) + this.hexSize,
    };
  }

  private fitPixelBounds(): {
    readonly minX: number;
    readonly maxX: number;
    readonly minY: number;
    readonly maxY: number;
  } | null {
    if (!this.model?.hexes.length) return null;
    const points: Point[] = [];
    for (const hex of this.model.hexes) {
      if (hex.terrain === 'sea') continue;
      const corners = hexCorners(hexToPixel(hex.q, hex.r, this.hexSize), this.hexSize);
      for (let index = 0; index < corners.length; index += 2) {
        const x = corners[index];
        const y = corners[index + 1];
        if (x !== undefined && y !== undefined) points.push({ x, y });
      }
    }
    if (points.length === 0) return this.boardPixelBounds();
    const badgeRadius = this.hexSize * (HARBOR_MARKER_SCALE / 2);
    for (const harbor of this.model.harbors) {
      const edgeIndex = this.graph?.edgeIndex[harbor.edge];
      const endpoints = edgeIndex === undefined ? undefined : this.graph?.edgeVertices[edgeIndex];
      const landHexId =
        edgeIndex === undefined
          ? undefined
          : this.graph?.edgeHexes[edgeIndex]?.find((id) => {
              const hex = this.model?.hexes.find((candidate) => candidate.id === id);
              return hex !== undefined && hex.terrain !== 'sea';
            });
      const landHex = this.model.hexes.find((hex) => hex.id === landHexId);
      if (!endpoints || !landHex) continue;
      const layout = harborLayout(
        vertexToPixel(endpoints[0], this.hexSize),
        vertexToPixel(endpoints[1], this.hexSize),
        hexToPixel(landHex.q, landHex.r, this.hexSize),
      );
      if (!layout) continue;
      points.push(
        { x: layout.hub.x - badgeRadius, y: layout.hub.y - badgeRadius },
        { x: layout.hub.x + badgeRadius, y: layout.hub.y + badgeRadius },
      );
    }
    const padding = this.hexSize * 0.075;
    return {
      minX: Math.min(...points.map((point) => point.x)) - padding,
      maxX: Math.max(...points.map((point) => point.x)) + padding,
      minY: Math.min(...points.map((point) => point.y)) - padding,
      maxY: Math.max(...points.map((point) => point.y)) + padding,
    };
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

  private destroyDetachedChildren(): void {
    for (const child of this.detachedChildren.splice(0)) child.destroy({ children: true });
  }

  private zoomAt(client: ScreenPoint, factor: number): void {
    const before = this.screenToBoard(client);
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
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
          MIN_ZOOM,
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
