import type { CommandShape } from '@cp2p/engine';

/**
 * Board choices the knights module adds. Each is a kind of tap on the board (a vertex, a hex or an
 * edge) that the engine answers with one command. The first group buys or moves knights, the
 * second answers a request the game makes, the third is the board part of a progress card.
 */
export type KnightsPlacementKind =
  | 'knight'
  | 'wall'
  | 'activate'
  | 'promote'
  | 'moveKnight'
  | 'displaceKnight'
  | 'chase'
  | 'sideways'
  | 'relocate'
  | 'pillage'
  | 'metropolis'
  | 'deserterRemove'
  | 'deserterPlace'
  | 'cardWall'
  | 'cardCity'
  | 'cardIntrigue'
  | 'cardMerchant'
  | 'cardBishop'
  | 'cardInventor'
  | 'cardDiplomat'
  | 'cardSmith';

export const KNIGHTS_PLACEMENT_KINDS: readonly KnightsPlacementKind[] = [
  'relocate',
  'pillage',
  'metropolis',
  'deserterRemove',
  'deserterPlace',
  'knight',
  'wall',
  'sideways',
  'activate',
  'promote',
  'moveKnight',
  'displaceKnight',
  'chase',
  'cardWall',
  'cardCity',
  'cardIntrigue',
  'cardMerchant',
  'cardBishop',
  'cardInventor',
  'cardDiplomat',
  'cardSmith',
];

/** What kind of board location a placement is picked at. */
export type TargetKind = 'vertex' | 'hex' | 'edge';

/** How the marked targets are drawn on the board. */
export type TargetStyle = 'site' | 'upgrade' | 'piece' | 'lane' | 'ring' | 'hex';

/** The piece shown at a chosen target before it is confirmed. */
export type PreviewPiece = 'knight' | 'wall' | 'city' | 'mark';

export interface KindInfo {
  readonly target: TargetKind;
  /** Drawing style of the marked targets (the second pick of a two-step kind, else the only pick). */
  readonly style: TargetStyle;
  /** The style of the first pick of a two-step kind. */
  readonly firstStyle?: TargetStyle;
  /** The game asks for this choice and nothing else can be done until it is made. */
  readonly forced: boolean;
  /** Two picks: the piece or target to act on, then where it goes. */
  readonly twoStep: boolean;
  readonly preview: PreviewPiece;
  /** A card's board part: chosen from the card, not from the build panel. */
  readonly card: boolean;
}

const one = (
  target: TargetKind,
  style: TargetStyle,
  preview: PreviewPiece,
  extra: Partial<KindInfo> = {},
): KindInfo => ({ target, style, forced: false, twoStep: false, preview, card: false, ...extra });

export const KIND_INFO: Readonly<Record<KnightsPlacementKind, KindInfo>> = {
  knight: one('vertex', 'site', 'knight'),
  wall: one('vertex', 'upgrade', 'wall'),
  activate: one('vertex', 'piece', 'mark'),
  promote: one('vertex', 'piece', 'mark'),
  moveKnight: one('vertex', 'site', 'knight', { twoStep: true, firstStyle: 'piece' }),
  displaceKnight: one('vertex', 'piece', 'knight', { twoStep: true, firstStyle: 'piece' }),
  chase: one('vertex', 'piece', 'mark'),
  sideways: one('vertex', 'upgrade', 'city'),
  relocate: one('vertex', 'site', 'knight', { forced: true }),
  pillage: one('vertex', 'upgrade', 'mark', { forced: true }),
  metropolis: one('vertex', 'upgrade', 'mark', { forced: true }),
  deserterRemove: one('vertex', 'piece', 'mark', { forced: true }),
  deserterPlace: one('vertex', 'site', 'knight', { forced: true }),
  cardWall: one('vertex', 'upgrade', 'wall', { card: true }),
  cardCity: one('vertex', 'upgrade', 'city', { card: true }),
  cardIntrigue: one('vertex', 'piece', 'mark', { card: true }),
  cardMerchant: one('hex', 'hex', 'mark', { card: true }),
  cardBishop: one('hex', 'hex', 'mark', { card: true }),
  cardInventor: one('hex', 'hex', 'mark', { card: true, twoStep: true, firstStyle: 'hex' }),
  cardDiplomat: one('edge', 'lane', 'mark', { card: true, twoStep: true, firstStyle: 'ring' }),
  cardSmith: one('vertex', 'piece', 'mark', { card: true, twoStep: true, firstStyle: 'piece' }),
};

export function isKnightsKind(kind: string): kind is KnightsPlacementKind {
  return Object.hasOwn(KIND_INFO, kind);
}

/** The board part of each progress card: the card and its placement kind. */
export const CARD_KINDS: Readonly<Record<string, KnightsPlacementKind>> = {
  engineer: 'cardWall',
  medicine: 'cardCity',
  intrigue: 'cardIntrigue',
  merchant: 'cardMerchant',
  bishop: 'cardBishop',
  inventor: 'cardInventor',
  diplomat: 'cardDiplomat',
  smith: 'cardSmith',
};

/** One tap the engine has a command for: the target's id and, for two picks, the first pick. */
export interface ParsedPlacement {
  readonly kind: KnightsPlacementKind;
  readonly id: string;
  readonly from?: string;
  /** This command needs no second pick: it finishes at the first one. */
  readonly finish?: boolean;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function params(command: CommandShape): Record<string, unknown> {
  const value: unknown = command.params;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function vertexOnly(kind: KnightsPlacementKind, p: Record<string, unknown>): ParsedPlacement[] {
  const vertex = str(p.vertex);
  return vertex === null ? [] : [{ kind, id: vertex }];
}

function hexOnly(kind: KnightsPlacementKind, p: Record<string, unknown>): ParsedPlacement[] {
  const hex = str(p.hex);
  return hex === null ? [] : [{ kind, id: hex }];
}

function cardPlacements(command: CommandShape): ParsedPlacement[] {
  const kind = typeof command.card === 'string' ? CARD_KINDS[command.card] : undefined;
  if (kind === undefined) return [];
  const p = params(command);
  if (kind === 'cardWall' || kind === 'cardCity' || kind === 'cardIntrigue')
    return vertexOnly(kind, p);
  if (kind === 'cardMerchant' || kind === 'cardBishop') return hexOnly(kind, p);
  if (kind === 'cardInventor') return swaps(kind, p.hexes);
  if (kind === 'cardDiplomat') {
    const edge = str(p.edge);
    if (edge === null) return [];
    const build = str(p.build);
    return build === null
      ? [{ kind, id: edge, from: edge, finish: true }]
      : [{ kind, id: build, from: edge }];
  }
  if (kind === 'cardSmith') {
    const vertices = Array.isArray(p.vertices) ? p.vertices.map(str) : [];
    const [a] = vertices;
    if (typeof a !== 'string') return [];
    if (vertices.length === 1) return [{ kind, id: a, from: a, finish: true }];
    return swaps(kind, vertices);
  }
  return [];
}

/** Two picks in either order: each of the pair may be chosen first. */
function swaps(kind: KnightsPlacementKind, list: unknown): ParsedPlacement[] {
  const items = Array.isArray(list) ? list.map(str) : [];
  const [a, b] = items;
  return typeof a === 'string' && typeof b === 'string' && items.length === 2
    ? [
        { kind, id: b, from: a },
        { kind, id: a, from: b },
      ]
    : [];
}

/** The board taps a legal knights command stands for (a card can stand for several), or none. */
export function knightsPlacements(command: CommandShape): ParsedPlacement[] {
  switch (command.type) {
    case 'BUILD_KNIGHT': {
      const vertex = str(command.vertex);
      return vertex === null ? [] : [{ kind: 'knight', id: vertex }];
    }
    case 'BUILD_CITY_WALL': {
      const vertex = str(command.vertex);
      return vertex === null ? [] : [{ kind: 'wall', id: vertex }];
    }
    case 'ACTIVATE_KNIGHT': {
      const vertex = str(command.vertex);
      return vertex === null ? [] : [{ kind: 'activate', id: vertex }];
    }
    case 'PROMOTE_KNIGHT': {
      const vertex = str(command.vertex);
      return vertex === null ? [] : [{ kind: 'promote', id: vertex }];
    }
    case 'UPGRADE_SIDEWAYS_CITY': {
      const vertex = str(command.vertex);
      return vertex === null ? [] : [{ kind: 'sideways', id: vertex }];
    }
    case 'CHASE_ROBBER': {
      const vertex = str(command.vertex);
      return vertex === null ? [] : [{ kind: 'chase', id: vertex }];
    }
    case 'MOVE_KNIGHT':
    case 'DISPLACE_KNIGHT': {
      const from = str(command.from);
      const to = str(command.to);
      return from === null || to === null
        ? []
        : [
            {
              kind: command.type === 'MOVE_KNIGHT' ? 'moveKnight' : 'displaceKnight',
              id: to,
              from,
            },
          ];
    }
    case 'RELOCATE_KNIGHT': {
      const to = str(command.to);
      return to === null ? [] : [{ kind: 'relocate', id: to }];
    }
    case 'CHOOSE_PILLAGE': {
      const vertex = str(command.vertex);
      return vertex === null ? [] : [{ kind: 'pillage', id: vertex }];
    }
    case 'PLACE_METROPOLIS': {
      const vertex = str(command.vertex);
      return vertex === null ? [] : [{ kind: 'metropolis', id: vertex }];
    }
    case 'DESERTER_REMOVE': {
      const vertex = str(command.vertex);
      return vertex === null ? [] : [{ kind: 'deserterRemove', id: vertex }];
    }
    case 'DESERTER_PLACE': {
      const vertex = str(command.vertex);
      return vertex === null ? [] : [{ kind: 'deserterPlace', id: vertex }];
    }
    case 'PLAY_PROGRESS_CARD':
      return cardPlacements(command);
    default:
      return [];
  }
}
