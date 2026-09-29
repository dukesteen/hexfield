import type { CommandShape, LegalCommandSet, Pending, Seat } from '@cp2p/engine';
import { knightsPlacements } from '../knights/placements';
import type { KnightsPlacementKind } from '../knights/placements';

type CommandTemplate = LegalCommandSet['templates'][number];

export type BasePlacementKind =
  | 'road'
  | 'settlement'
  | 'city'
  | 'freeRoad'
  | 'robber'
  | 'ship'
  | 'freeShip'
  | 'pirate'
  | 'moveShip';

export type PlacementKind = BasePlacementKind | KnightsPlacementKind;

export interface PlacementChoice {
  /** Canonical board id used by BoardView highlights and hit selection. */
  id: string;
  type: string;
  command: CommandShape;
  /**
   * For a two-pick choice, the first pick: the edge a ship sails from, the vertex a knight moves
   * from, the hex to swap with. `id` is where it goes.
   */
  from?: string;
  /** For a two-pick kind: this command is complete after the first pick, with no second one. */
  finish?: boolean;
}

export interface ActionGroup {
  type: string;
  commands: readonly CommandShape[];
  templates: readonly CommandTemplate[];
}

export interface CardPlayGroup {
  slotId: string;
  card: string | null;
  commands: readonly CommandShape[];
  templates: readonly CommandTemplate[];
}

/** A progress card slot with the plays the engine offers for it. */
export interface ProgressPlayGroup {
  slotId: string;
  card: string | null;
  commands: readonly CommandShape[];
  templates: readonly CommandTemplate[];
}

export interface ActionAvailability {
  /** Types permitted by the seat's current pending request, even if unaffordable. */
  allowedTypes: readonly string[];
  /** Types with an actual legal command or form template. */
  availableTypes: readonly string[];
  /** Action bar and dialog groups, excluding board placements and slotted card plays. */
  primary: readonly ActionGroup[];
  /** Legal board hits. Each choice carries the exact command supplied by the engine. */
  placements: Readonly<Record<PlacementKind, readonly PlacementChoice[]>>;
  /** Template-backed forms, including discard, trade and Year of Plenty. */
  templates: readonly ActionGroup[];
  /** Playable card slots, grouped without interpreting card rules. */
  cardPlays: readonly CardPlayGroup[];
  /** Progress card slots with the plays offered for them (Cities & Knights). */
  progressPlays: readonly ProgressPlayGroup[];
  /** `BUILD_IMPROVEMENT` commands, one per track the seat can buy a level on. */
  improvements: readonly CommandShape[];
  /** Concrete steal choices for the target dialog. */
  stealTargets: readonly { seat: Seat; command: CommandShape }[];
}

/**
 * Commands a knights game answers with its own controls (the improvements board, a hand of
 * progress cards, forced dialogs) and never as buttons in the action bar.
 */
const KNIGHTS_FORM_TYPES: ReadonlySet<string> = new Set([
  'BUILD_IMPROVEMENT',
  'CHOOSE_AQUEDUCT',
  'CHOOSE_PROGRESS_DECK',
  'DISCARD_PROGRESS',
  'WEDDING_GIVE',
  'SABOTEUR_DISCARD',
  'HARBOR_OFFER',
  'HARBOR_REPLY',
]);

const placementTypes: Readonly<Record<string, { kind: PlacementKind; field: string }>> = {
  PLACE_ROAD: { kind: 'road', field: 'edge' },
  BUILD_ROAD: { kind: 'road', field: 'edge' },
  PLACE_SETTLEMENT: { kind: 'settlement', field: 'vertex' },
  BUILD_SETTLEMENT: { kind: 'settlement', field: 'vertex' },
  BUILD_CITY: { kind: 'city', field: 'vertex' },
  PLACE_FREE_ROAD: { kind: 'freeRoad', field: 'edge' },
  MOVE_ROBBER: { kind: 'robber', field: 'hex' },
  BUILD_SHIP: { kind: 'ship', field: 'edge' },
  PLACE_SETUP_SHIP: { kind: 'ship', field: 'edge' },
  PLACE_FREE_SHIP: { kind: 'freeShip', field: 'edge' },
  MOVE_PIRATE: { kind: 'pirate', field: 'hex' },
};

function groupByType(
  commands: readonly CommandShape[],
  templates: readonly CommandTemplate[],
): ActionGroup[] {
  const grouped = new Map<
    string,
    { type: string; commands: CommandShape[]; templates: CommandTemplate[] }
  >();
  for (const command of commands) {
    const group = grouped.get(command.type) ?? { type: command.type, commands: [], templates: [] };
    group.commands.push(command);
    grouped.set(command.type, group);
  }
  for (const template of templates) {
    const group = grouped.get(template.type) ?? {
      type: template.type,
      commands: [],
      templates: [],
    };
    group.templates.push(template);
    grouped.set(template.type, group);
  }
  return [...grouped.values()];
}

/** Group the engine's exact offers for one seat. This function never constructs a command. */
export function deriveActionAvailability(
  legal: LegalCommandSet,
  pending: readonly Pending[],
  seat: Seat,
): ActionAvailability {
  const allowedTypes = [
    ...new Set(
      pending.flatMap((item) => (item.kind === 'player' && item.seat === seat ? item.allowed : [])),
    ),
  ];
  const allowed = new Set(allowedTypes);
  const commands = legal.commands.filter((command) => allowed.has(command.type));
  const templates = legal.templates.filter((template) => allowed.has(template.type));
  const placements: Record<PlacementKind, PlacementChoice[]> = {
    road: [],
    settlement: [],
    city: [],
    freeRoad: [],
    robber: [],
    ship: [],
    freeShip: [],
    pirate: [],
    moveShip: [],
    knight: [],
    wall: [],
    activate: [],
    promote: [],
    moveKnight: [],
    displaceKnight: [],
    chase: [],
    sideways: [],
    relocate: [],
    pillage: [],
    metropolis: [],
    deserterRemove: [],
    deserterPlace: [],
    cardWall: [],
    cardCity: [],
    cardIntrigue: [],
    cardMerchant: [],
    cardBishop: [],
    cardInventor: [],
    cardDiplomat: [],
    cardSmith: [],
  };
  const progress = new Map<
    string,
    { slotId: string; card: string | null; commands: CommandShape[]; templates: CommandTemplate[] }
  >();
  const addProgress = (item: CommandShape, template: boolean): boolean => {
    if (item.type !== 'PLAY_PROGRESS_CARD' || typeof item.slotId !== 'string') return false;
    const prior = progress.get(item.slotId) ?? {
      slotId: item.slotId,
      card: null,
      commands: [],
      templates: [],
    };
    if (typeof item.card === 'string' && item.card !== 'private identity') prior.card = item.card;
    if (template) prior.templates.push(item);
    else prior.commands.push(item);
    progress.set(item.slotId, prior);
    return true;
  };
  const addKnightsChoice = (command: CommandShape): boolean => {
    const taps = knightsPlacements(command);
    for (const tap of taps) {
      const list = placements[tap.kind];
      const seen = list.findIndex(
        (choice) =>
          choice.id === tap.id && choice.from === tap.from && choice.finish === tap.finish,
      );
      const choice: PlacementChoice = {
        id: tap.id,
        type: command.type,
        command,
        ...(tap.from === undefined ? {} : { from: tap.from }),
        ...(tap.finish ? { finish: true } : {}),
      };
      if (seen < 0) list.push(choice);
      // A Deserter may place a lower level; offer the strongest knight for each site.
      else if (
        tap.kind === 'deserterPlace' &&
        Number(command.level) > Number(list[seen]?.command.level)
      )
        list[seen] = choice;
    }
    return taps.length > 0;
  };
  const primaryCommands: CommandShape[] = [];
  const primaryTemplates: CommandTemplate[] = [];
  const cards = new Map<
    string,
    { slotId: string; card: string | null; commands: CommandShape[]; templates: CommandTemplate[] }
  >();
  const stealTargets: { seat: Seat; command: CommandShape }[] = [];
  const improvements: CommandShape[] = [];

  const addCard = (item: CommandShape, template: boolean): boolean => {
    if (item.type !== 'PLAY_DEV_CARD' || typeof item.slotId !== 'string') return false;
    const prior = cards.get(item.slotId) ?? {
      slotId: item.slotId,
      card: null,
      commands: [],
      templates: [],
    };
    if (typeof item.card === 'string' && item.card !== 'private identity') prior.card = item.card;
    if (template) prior.templates.push(item);
    else prior.commands.push(item);
    cards.set(item.slotId, prior);
    return true;
  };

  for (const command of commands) {
    if (
      command.type === 'MOVE_SHIP' &&
      typeof command.from === 'string' &&
      typeof command.to === 'string'
    ) {
      placements.moveShip.push({ id: command.to, from: command.from, type: command.type, command });
      continue;
    }
    if (command.type === 'PLAY_PROGRESS_CARD') {
      // A card stays playable as a whole, and its board part is offered as taps on the board.
      addProgress(command, false);
      addKnightsChoice(command);
      continue;
    }
    if (KNIGHTS_FORM_TYPES.has(command.type)) {
      if (command.type === 'BUILD_IMPROVEMENT') improvements.push(command);
      continue;
    }
    if (addKnightsChoice(command)) continue;
    const placement = Object.hasOwn(placementTypes, command.type)
      ? placementTypes[command.type]
      : undefined;
    const id = placement ? command[placement.field] : undefined;
    if (placement && typeof id === 'string') {
      placements[placement.kind].push({ id, type: command.type, command });
      continue;
    }
    if (addCard(command, false)) continue;
    primaryCommands.push(command);
    if (command.type === 'STEAL') {
      const victim = ([0, 1, 2, 3, 4, 5] as const).find(
        (candidate) => candidate === command.victim,
      );
      if (victim !== undefined) stealTargets.push({ seat: victim, command });
    }
  }
  for (const template of templates)
    if (
      !addCard(template, true) &&
      !addProgress(template, true) &&
      !KNIGHTS_FORM_TYPES.has(template.type)
    )
      primaryTemplates.push(template);

  return {
    allowedTypes,
    availableTypes: groupByType(commands, templates).map((group) => group.type),
    primary: groupByType(primaryCommands, primaryTemplates),
    placements,
    templates: groupByType([], templates),
    cardPlays: [...cards.values()],
    progressPlays: [...progress.values()],
    improvements,
    stealTargets,
  };
}
