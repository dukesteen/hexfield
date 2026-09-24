import { Application, Container, Graphics, Text } from 'pixi.js';
import { buildBoardGraph, edgeToPixel, hexToPixel, vertexToPixel } from '@cp2p/engine/geometry';
import type { BoardGraph, EdgeId, HexId, Point, VertexId } from '@cp2p/engine/geometry';
import { hitTestBoard } from './input/hitTest.js';
import { clampCameraAxis } from './input/camera.js';
import type {
  BoardAppearance,
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
const LAYER_NAMES = [
  'background',
  'terrain',
  'harbors',
  'tokens',
  'roads',
  'buildings',
  'robber',
  'highlights',
  'effects',
] as const;
type LayerName = (typeof LAYER_NAMES)[number];

const TERRAIN_COLORS: Readonly<Record<string, number>> = {
  forest: 0x80b09a,
  hills: 0xcb9176,
  pasture: 0xb7d197,
  fields: 0xe8cb78,
  mountains: 0x94a8b1,
  desert: 0xddcda7,
  sea: 0xd1e7e9,
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

function tokenPips(token: number): readonly Point[] {
  const count = Math.max(0, 6 - Math.abs(7 - token));
  if (count === 1) return [{ x: 0, y: 10 }];
  if (count === 2)
    return [
      { x: -4, y: 9 },
      { x: 4, y: 9 },
    ];
  if (count === 3)
    return [
      { x: -4, y: 7 },
      { x: 0, y: 11 },
      { x: 4, y: 7 },
    ];
  if (count === 4)
    return [
      { x: -4, y: 7 },
      { x: 4, y: 7 },
      { x: -4, y: 11 },
      { x: 4, y: 11 },
    ];
  if (count === 5)
    return [
      { x: -4, y: 7 },
      { x: 4, y: 7 },
      { x: 0, y: 9 },
      { x: -4, y: 12 },
      { x: 4, y: 12 },
    ];
  return [];
}

function clearLayer(layer: Container): void {
  for (const child of layer.removeChildren()) child.destroy({ children: true });
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
  private readonly hexSize: number;
  private readonly camera: Container;
  private readonly layers: Record<LayerName, Container>;
  private readonly signatures = new Map<LayerName, string>();
  private readonly onSelect?: BoardRendererOptions['onSelect'];
  private readonly onHover?: BoardRendererOptions['onHover'];
  private readonly onReady?: BoardRendererOptions['onReady'];
  private readonly forceReducedMotion: boolean;
  private harborLabelFormatter: (kind: string) => string;
  private readonly resizeObserver: ResizeObserver;
  private graph: BoardGraph | null = null;
  private model: RenderModel | null = null;
  private highlights: BoardHighlights = {};
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

  private constructor(host: HTMLElement, app: Application, options: BoardRendererOptions) {
    this.app = app;
    this.hexSize = options.hexSize ?? HEX_SIZE;
    this.onSelect = options.onSelect;
    this.onHover = options.onHover;
    this.onReady = options.onReady;
    this.forceReducedMotion = options.reducedMotion ?? false;
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
      buildings: new Container(),
      robber: new Container(),
      highlights: new Container(),
      effects: new Container(),
    };
    app.stage.addChild(this.camera);
    for (const name of LAYER_NAMES) this.camera.addChild(this.layers[name]);

    app.canvas.style.display = 'block';
    app.canvas.style.width = '100%';
    app.canvas.style.height = '100%';
    app.canvas.style.touchAction = 'none';
    app.canvas.setAttribute('aria-label', options.accessibleLabel ?? 'Game board canvas');
    host.append(app.canvas);
    this.resizeObserver = new ResizeObserver(() => this.resizeAndClamp());
    this.resizeObserver.observe(host);
    app.renderer.on('resize', () => this.resizeAndClamp());
    this.bindInput();
    app.ticker.add(this.tickHighlights);
  }

  static async create(
    host: HTMLElement,
    options: BoardRendererOptions = {},
  ): Promise<PixiBoardRenderer> {
    await import('pixi.js/unsafe-eval');
    const app = new Application();
    await app.init({
      resizeTo: host,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, options.maxPixelRatio ?? 2),
      antialias: true,
      backgroundColor: options.appearance?.theme === 'dark' ? 0x15231f : 0xd1e7e9,
      preference: 'webgl',
    });
    return new PixiBoardRenderer(host, app, options);
  }

  render(model: RenderModel): void {
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
    if (firstRender) this.fitToBoard();
    else {
      this.clampCamera();
      this.updateCamera();
    }
    if (!this.readyNotified) {
      this.readyNotified = true;
      this.onReady?.(this);
    }
  }

  setHighlights(highlights: BoardHighlights): void {
    const previous = this.highlights;
    this.highlights = highlights;
    const signature = JSON.stringify(highlights);
    if (this.signatures.get('highlights') === signature) return;
    this.signatures.set('highlights', signature);
    const layer = this.layers.highlights;
    clearLayer(layer);
    const style = highlights.style ?? {};
    const color = style.color ?? 0x086b52;
    const graphics = new Graphics();
    for (const id of highlights.hexes ?? []) {
      const hex = this.model?.hexes.find((candidate) => candidate.id === id);
      if (hex)
        graphics
          .poly(hexCorners(hexToPixel(hex.q, hex.r, this.hexSize), this.hexSize), true)
          .fill({ color, alpha: 0.2 })
          .stroke({ color, width: 3 });
    }
    for (const id of highlights.edges ?? []) {
      const index = this.graph?.edgeIndex[id];
      const endpoints = index === undefined ? undefined : this.graph?.edgeVertices[index];
      if (!endpoints) continue;
      const first = vertexToPixel(endpoints[0], this.hexSize);
      const second = vertexToPixel(endpoints[1], this.hexSize);
      graphics
        .moveTo(first.x, first.y)
        .lineTo(second.x, second.y)
        .stroke({ color, width: 9, alpha: 0.8 });
    }
    for (const id of highlights.vertices ?? []) {
      const point = vertexToPixel(id, this.hexSize);
      graphics
        .circle(point.x, point.y, this.hexSize * 0.25)
        .fill({ color, alpha: 0.5 })
        .stroke({ color, width: 3 });
    }
    layer.addChild(graphics);
    if (style.pulse) this.app.ticker.start();
    if (previous !== highlights) this.app.render();
  }

  private get reducedMotion(): boolean {
    return this.forceReducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private readonly tickHighlights = (): void => {
    if (!this.highlights.style?.pulse || this.destroyed) {
      this.layers.highlights.alpha = 1;
      return;
    }
    if (this.reducedMotion) return;
    const phase = (Math.sin(performance.now() / 360) + 1) / 2;
    this.layers.highlights.alpha = 0.76 + phase * 0.24;
  };

  setAppearance(appearance: BoardAppearance): void {
    this.appearance = appearance;
    this.app.renderer.background.color = appearance.theme === 'dark' ? 0x15231f : 0xd1e7e9;
    this.signatures.delete('background');
    this.signatures.delete('roads');
    this.signatures.delete('buildings');
    if (this.model) {
      this.drawChanged('background', [appearance.theme]);
      this.drawChanged('roads', [this.model.roads, this.appearance.players]);
      this.drawChanged('buildings', [this.model.buildings, this.appearance.players]);
    }
  }

  setHarborLabelFormatter(formatter: (kind: string) => string): void {
    this.harborLabelFormatter = formatter;
    this.signatures.delete('harbors');
    if (this.model) this.drawChanged('harbors', this.model.harbors);
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
    if (!this.model?.hexes.length) return;
    const xs = this.model.hexes.map((hex) => hexToPixel(hex.q, hex.r, this.hexSize).x);
    const ys = this.model.hexes.map((hex) => hexToPixel(hex.q, hex.r, this.hexSize).y);
    const width = Math.max(...xs) - Math.min(...xs) + this.hexSize * 2;
    const height = Math.max(...ys) - Math.min(...ys) + this.hexSize * 2;
    this.zoom = Math.max(
      MIN_ZOOM,
      Math.min(
        MAX_ZOOM,
        Math.min((this.app.screen.width - 48) / width, (this.app.screen.height - 48) / height),
      ),
    );
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
    this.cameraX = this.app.screen.width / 2 - centerX * this.zoom;
    this.cameraY = this.app.screen.height / 2 - centerY * this.zoom;
    this.clampCamera();
    this.updateCamera();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.unbindInput();
    this.app.ticker.remove(this.tickHighlights);
    this.app.destroy(true, { children: true, texture: false, textureSource: false });
  }

  private drawChanged(name: LayerName, value: unknown): void {
    const signature = JSON.stringify(value);
    if (this.signatures.get(name) === signature) return;
    this.signatures.set(name, signature);
    const layer = this.layers[name];
    clearLayer(layer);
    const model = this.model;
    if (!model) return;
    if (name === 'background') {
      const color = this.appearance.theme === 'dark' ? 0x15231f : 0xd1e7e9;
      layer.addChild(new Graphics().rect(-8192, -8192, 16384, 16384).fill({ color }));
    } else if (name === 'terrain') {
      for (const hex of model.hexes) {
        const center = hexToPixel(hex.q, hex.r, this.hexSize);
        layer.addChild(
          new Graphics()
            .poly(hexCorners(center, this.hexSize), true)
            .fill({ color: TERRAIN_COLORS[hex.terrain] ?? 0x9aa9a3 })
            .stroke({ color: 0xf5f8f5, width: 2 }),
        );
      }
    } else if (name === 'harbors') {
      for (const harbor of model.harbors) {
        const edge = edgeToPixel(harbor.edge, this.hexSize);
        const label = new Text({
          text: this.harborLabelFormatter(harbor.kind),
          style: {
            fontFamily: 'system-ui, sans-serif',
            fontSize: 11,
            fill: 0x18332b,
            fontWeight: '600',
          },
        });
        label.anchor.set(0.5);
        label.position.set(edge.midpoint.x, edge.midpoint.y);
        layer.addChild(label);
      }
    } else if (name === 'tokens') {
      for (const hex of model.hexes) {
        if (hex.token === null) continue;
        const center = hexToPixel(hex.q, hex.r, this.hexSize);
        layer.addChild(
          new Graphics()
            .circle(center.x, center.y, this.hexSize * 0.29)
            .fill({ color: 0xfcfdfc })
            .stroke({ color: 0x49665b, width: 2 }),
        );
        const pipColor = hex.token === 6 || hex.token === 8 ? 0xae3329 : 0x49665b;
        const pips = new Graphics();
        for (const pip of tokenPips(hex.token)) {
          pips.circle(center.x + pip.x, center.y + pip.y, 1.5).fill({ color: pipColor });
        }
        layer.addChild(pips);
        const text = new Text({
          text: String(hex.token),
          style: {
            fontFamily: 'system-ui, sans-serif',
            fontSize: 16,
            fill: hex.token === 6 || hex.token === 8 ? 0xae3329 : 0x18332b,
            fontWeight: '700',
          },
        });
        text.anchor.set(0.5);
        text.position.set(center.x, center.y - 3);
        layer.addChild(text);
      }
    } else if (name === 'roads') {
      const styles = this.playerStyleMap();
      for (const road of model.roads) {
        const edge = edgeToPixel(road.edge, this.hexSize);
        const length = this.hexSize * 0.62;
        const dx = (Math.cos(edge.angle) * length) / 2;
        const dy = (Math.sin(edge.angle) * length) / 2;
        const graphics = new Graphics()
          .moveTo(edge.midpoint.x - dx, edge.midpoint.y - dy)
          .lineTo(edge.midpoint.x + dx, edge.midpoint.y + dy);
        graphics.stroke({
          color: styles.get(road.seat)?.color ?? 0x49665b,
          width: 9,
          cap: 'round',
        });
        layer.addChild(graphics);
      }
    } else if (name === 'buildings') {
      const styles = this.playerStyleMap();
      for (const building of model.buildings) {
        const point = vertexToPixel(building.vertex, this.hexSize);
        const style = styles.get(building.seat) ?? DEFAULT_PLAYER_STYLE;
        const size = building.kind === 'city' ? 12 : 9;
        const graphics = new Graphics();
        markerShape(graphics, point.x, point.y, style.color, style.marker, size);
        layer.addChild(graphics);
      }
    } else if (name === 'robber') {
      const hex = model.hexes.find((candidate) => candidate.id === model.robberHex);
      if (hex) {
        const center = hexToPixel(hex.q, hex.r, this.hexSize);
        layer.addChild(
          new Graphics()
            .circle(center.x, center.y, 13)
            .fill({ color: 0x49665b })
            .stroke({ color: 0xfcfdfc, width: 2 }),
        );
      }
    }
  }

  private playerStyleMap(): Map<number, BoardAppearance['players'][number]> {
    return new Map(this.appearance.players.map((style) => [style.seat, style]));
  }

  private resizeAndClamp(): void {
    if (this.model) this.fitToBoard();
  }

  private clampCamera(): void {
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    const points = this.model?.hexes.map((hex) => hexToPixel(hex.q, hex.r, this.hexSize)) ?? [];
    if (!points.length) return;
    const minX = Math.min(...points.map((p) => p.x)) - this.hexSize;
    const maxX = Math.max(...points.map((p) => p.x)) + this.hexSize;
    const minY = Math.min(...points.map((p) => p.y)) - this.hexSize;
    const maxY = Math.max(...points.map((p) => p.y)) + this.hexSize;
    const margin = 24;
    this.cameraX = clampCameraAxis(this.cameraX, minX, maxX, width, this.zoom, margin);
    this.cameraY = clampCameraAxis(this.cameraY, minY, maxY, height, this.zoom, margin);
  }

  private updateCamera(): void {
    this.camera.position.set(this.cameraX, this.cameraY);
    this.camera.scale.set(this.zoom);
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
    const old = this.pointers.get(event.pointerId);
    if (old) this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pinch && this.pointers.size >= 2) {
      const [first, second] = [...this.pointers.values()];
      if (first && second) {
        const nextDistance = Math.hypot(second.x - first.x, second.y - first.y);
        const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
        this.zoomAt(center, nextDistance / Math.max(1, this.pinch.distance));
        this.cameraX += center.x - this.pinch.x;
        this.cameraY += center.y - this.pinch.y;
        this.pinch = { distance: nextDistance, zoom: this.zoom, ...center };
        this.clampCamera();
        this.updateCamera();
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
      }
    }
    const hit = this.hitTest({ x: event.clientX, y: event.clientY });
    if (!sameHit(hit, this.lastHit)) {
      this.lastHit = hit;
      this.onHover?.(hit);
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    this.pointers.delete(event.pointerId);
    if (this.app.canvas.hasPointerCapture(event.pointerId))
      this.app.canvas.releasePointerCapture(event.pointerId);
    if (drag?.pointerId === event.pointerId && !drag.moved && this.pointers.size === 0) {
      const point = { x: event.clientX, y: event.clientY };
      const hit = this.hitTest(point);
      if (hit) {
        this.lastTap = null;
        this.onSelect?.(hit);
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
    this.pointers.delete(event.pointerId);
    this.drag = null;
    this.pinch = null;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.zoomAt({ x: event.clientX, y: event.clientY }, Math.exp(-event.deltaY * 0.001));
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    event.preventDefault();
    if (!this.hitTest({ x: event.clientX, y: event.clientY })) this.fitToBoard();
  };
}

export async function createBoardRenderer(
  host: HTMLElement,
  options?: BoardRendererOptions,
): Promise<BoardRenderer> {
  return PixiBoardRenderer.create(host, options);
}

export type { EdgeId, HexId, VertexId };
