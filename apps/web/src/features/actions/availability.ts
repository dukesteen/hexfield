import type { CommandShape, LegalCommandSet, Pending, Seat } from '@cp2p/engine';

type CommandTemplate = LegalCommandSet['templates'][number];

export type PlacementKind = 'road' | 'settlement' | 'city' | 'freeRoad' | 'robber';

export interface PlacementChoice {
  /** Canonical board id used by BoardView highlights and hit selection. */
  id: string;
  type: string;
  command: CommandShape;
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
  /** Concrete steal choices for the target dialog. */
  stealTargets: readonly { seat: Seat; command: CommandShape }[];
}

const placementTypes: Readonly<Record<string, { kind: PlacementKind; field: string }>> = {
  PLACE_ROAD: { kind: 'road', field: 'edge' },
  BUILD_ROAD: { kind: 'road', field: 'edge' },
  PLACE_SETTLEMENT: { kind: 'settlement', field: 'vertex' },
  BUILD_SETTLEMENT: { kind: 'settlement', field: 'vertex' },
  BUILD_CITY: { kind: 'city', field: 'vertex' },
  PLACE_FREE_ROAD: { kind: 'freeRoad', field: 'edge' },
  MOVE_ROBBER: { kind: 'robber', field: 'hex' },
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
  };
  const primaryCommands: CommandShape[] = [];
  const primaryTemplates: CommandTemplate[] = [];
  const cards = new Map<
    string,
    { slotId: string; card: string | null; commands: CommandShape[]; templates: CommandTemplate[] }
  >();
  const stealTargets: { seat: Seat; command: CommandShape }[] = [];

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
  for (const template of templates) if (!addCard(template, true)) primaryTemplates.push(template);

  return {
    allowedTypes,
    availableTypes: groupByType(commands, templates).map((group) => group.type),
    primary: groupByType(primaryCommands, primaryTemplates),
    placements,
    templates: groupByType([], templates),
    cardPlays: [...cards.values()],
    stealTargets,
  };
}
