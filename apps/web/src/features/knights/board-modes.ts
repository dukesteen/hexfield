import type { BoardHighlights } from '@cp2p/renderer';
import type { PlacementChoice, PlacementKind } from '../actions/availability';
import { KIND_INFO, isKnightsKind } from './placements';
import type { KindInfo, PreviewPiece, TargetKind, TargetStyle } from './placements';

/** The kinds a seat picks at the board while it plays a knight: the build panel's actions. */
export const KNIGHT_ACTION_KINDS: readonly PlacementKind[] = [
  'activate',
  'promote',
  'moveKnight',
  'displaceKnight',
  'chase',
];

/** The knights kinds bought from the build panel. */
export const KNIGHT_BUILD_KINDS: readonly PlacementKind[] = ['knight', 'wall', 'sideways'];

export function kindInfo(kind: PlacementKind | undefined): KindInfo | null {
  return kind !== undefined && isKnightsKind(kind) ? KIND_INFO[kind] : null;
}

/** True for a choice the game asks for and that holds up everything else. */
export function isForcedKind(kind: PlacementKind): boolean {
  return kindInfo(kind)?.forced === true;
}

/** True for a knights kind that takes two picks, such as a knight and where it goes. */
export function isTwoStepKind(kind: PlacementKind | undefined): boolean {
  return kind === 'moveShip' || kindInfo(kind)?.twoStep === true;
}

/** The board target a knights kind is picked at, or null for a base kind. */
export function targetOfKind(kind: PlacementKind): TargetKind | null {
  return kindInfo(kind)?.target ?? null;
}

/** The piece drawn at a chosen target before it is confirmed. */
export function previewOfKind(kind: PlacementKind): PreviewPiece | null {
  return kindInfo(kind)?.preview ?? null;
}

const STYLES: Readonly<Record<TargetStyle, BoardHighlights['style']>> = {
  site: { vertexTarget: 'site' },
  upgrade: { vertexTarget: 'upgrade' },
  piece: { vertexTarget: 'piece' },
  ring: { edgeTarget: 'ring' },
  hex: {},
  lane: {},
};

/** How the marked targets of a knights kind are drawn: the highlight style for one pick. */
export function highlightStyle(kind: PlacementKind, firstPick: boolean): BoardHighlights['style'] {
  const info = kindInfo(kind);
  if (!info) return {};
  return STYLES[firstPick ? (info.firstStyle ?? info.style) : info.style];
}

/** The first picks of a two-pick kind, one target for each distinct thing that can be picked first. */
export function firstPicks(choices: readonly PlacementChoice[]): PlacementChoice[] {
  const seen = new Set<string>();
  const picks: PlacementChoice[] = [];
  for (const choice of choices) {
    if (choice.from === undefined || seen.has(choice.from)) continue;
    seen.add(choice.from);
    // A pick with no second step is complete: choosing it goes straight to the confirmation.
    const only = choices.filter((item) => item.from === choice.from);
    const command = only.length === 1 && only[0]?.finish ? only[0].command : choice.command;
    picks.push({ id: choice.from, type: choice.type, command });
  }
  return picks;
}

/** The second picks after `from`, and the command that ends at the first pick if there is one. */
export function secondPicks(
  choices: readonly PlacementChoice[],
  from: string,
): { targets: PlacementChoice[]; finish: PlacementChoice | undefined } {
  const own = choices.filter((choice) => choice.from === from);
  return {
    targets: own.filter((choice) => !choice.finish),
    finish: own.find((choice) => choice.finish),
  };
}
