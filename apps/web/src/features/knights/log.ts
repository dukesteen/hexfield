import type { TFunction } from 'i18next';
import type { GameEvent, GameState, Seat } from '@cp2p/engine';
import {
  getBarbarianShipUrl,
  getCommodityIconUrl,
  getDefenderIconUrl,
  getKnightIconUrl,
  getMerchantIconUrl,
  getMetropolisIconUrl,
  getProgressBackUrl,
  getTrackIconUrl,
  getWallIconUrl,
} from '@cp2p/renderer';
import { isCommodity, knightsState, TRACKS } from './state';
import type { Track } from './state';

/** Events whose `seat` is the seat that acted, so the log can show its badge. */
export const KNIGHTS_ACTOR_EVENTS: ReadonlySet<string> = new Set([
  'improvementBuilt',
  'metropolisPlaced',
  'aqueductChosen',
  'knightBuilt',
  'knightActivated',
  'knightsActivated',
  'knightPromoted',
  'knightMoved',
  'knightDisplaced',
  'knightRelocated',
  'knightRemoved',
  'robberChased',
  'cityWallBuilt',
  'cityPillaged',
  'progressCardPlayed',
  'victoryCardShown',
  'cardDealt',
  'progressDiscarded',
  'diceSet',
  'tokensSwapped',
  'merchantPlaced',
  'fleetNamed',
  'monopolyPlayed',
  'harvested',
  'harborOpened',
  'harborOffered',
  'harborSwapped',
  'harborReturned',
  'masterMerchantPlayed',
  'cardsTaken',
  'spyPlayed',
  'progressCardTaken',
  'spyTookNothing',
  'deserterPlayed',
  'saboteurPlayed',
  'sabotageDiscard',
  'weddingPlayed',
  'weddingGift',
  'roadRemoved',
  'roadBuildingPlayed',
]);

function trackOf(value: unknown): Track | null {
  return TRACKS.find((track) => track === value) ?? null;
}

function seatOf(value: unknown): Seat | null {
  return ([0, 1, 2, 3, 4, 5] as const).find((seat) => seat === value) ?? null;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** The name of a card kind: a resource or a commodity. */
function kind(t: TFunction, value: unknown): string {
  if (typeof value !== 'string') return '';
  return isCommodity(value) ? t(`knights:commodity.${value}`) : t(`game:${value}`);
}

/**
 * The log line for a Cities & Knights event, or null for an event this module does not own. Only
 * public fields are read: private looks and takes are logged by the counts they change.
 */
export function formatKnightsEvent(
  event: GameEvent,
  t: TFunction,
  name: (seat: number) => string,
): string | null {
  const f: Record<string, unknown> = Object.fromEntries(Object.entries(event));
  const player = typeof f.seat === 'number' ? name(f.seat) : '';
  const other = (key: string) => (typeof f[key] === 'number' ? name(num(f[key])) : '');
  switch (event.type) {
    case 'improvementBuilt': {
      const track = trackOf(f.track);
      return track
        ? t('log:improvementBuilt', {
            player,
            track: t(`knights:track.${track}`),
            level: num(f.level),
          })
        : null;
    }
    case 'metropolisPlaced': {
      const track = trackOf(f.track);
      if (!track) return null;
      const label = t(`knights:track.${track}`);
      return typeof f.from === 'number'
        ? t('log:metropolisTaken', { player, track: label, other: other('from') })
        : t('log:metropolisPlaced', { player, track: label });
    }
    case 'aqueductChosen':
      return t('log:aqueductChosen', { player, resource: kind(t, f.resource) });
    case 'knightBuilt':
      return t(f.deserted === true ? 'log:knightBuiltDeserter' : 'log:knightBuilt', { player });
    case 'knightActivated':
    case 'knightsActivated':
    case 'knightMoved':
    case 'knightRelocated':
    case 'robberChased':
    case 'cityWallBuilt':
    case 'tokensSwapped':
    case 'merchantPlaced':
    case 'harborOpened':
    case 'saboteurPlayed':
    case 'weddingPlayed':
    case 'roadBuildingPlayed':
    case 'spyTookNothing':
      return t(`log:${event.type}`, { player });
    case 'knightPromoted':
      return t('log:knightPromoted', {
        player,
        level: t(`log:level.${Math.min(3, Math.max(1, num(f.level)))}`),
      });
    case 'knightDisplaced':
      return t('log:knightDisplaced', { player, other: other('displaced') });
    case 'knightRemoved':
      return t('log:knightRemoved', { player });
    case 'cityPillaged':
      return t(f.sideways === true ? 'log:cityPillagedSideways' : 'log:cityPillaged', {
        player,
      });
    case 'progressCardPlayed':
      return typeof f.card === 'string'
        ? t('log:progressCardPlayed', { player, card: t(`knights:cards.${f.card}.name`) })
        : null;
    case 'victoryCardShown':
      return typeof f.card === 'string'
        ? t('log:victoryCardShown', { player, card: t(`knights:cards.${f.card}.name`) })
        : null;
    case 'cardDealt': {
      const deck = typeof f.deck === 'string' ? f.deck.replace('progress-', '') : '';
      const track = trackOf(deck);
      return track && typeof f.seat === 'number'
        ? t('log:cardDealt', { player, track: t(`knights:track.${track}`) })
        : null;
    }
    case 'progressDiscarded':
      return t('log:progressDiscarded', { player, count: num(f.count) });
    case 'diceSet': {
      const dice = Array.isArray(f.dice) ? f.dice : [];
      return t('log:diceSet', { player, first: num(dice[0]), second: num(dice[1]) });
    }
    case 'fleetNamed':
      return t('log:fleetNamed', { player, kind: kind(t, f.kind) });
    case 'monopolyPlayed':
      return t('log:monopolyPlayed', { player, kind: kind(t, f.kind) });
    case 'harvested':
      return t('log:harvested', {
        player,
        count: num(f.count),
        resource: kind(t, f.resource),
      });
    case 'harborOffered':
      return t('log:harborOffered', { player, other: other('to') });
    case 'harborSwapped':
      return t('log:harborSwapped', { player, other: other('with') });
    case 'harborReturned':
      return t('log:harborReturned', { player, other: other('from') });
    case 'masterMerchantPlayed':
    case 'spyPlayed':
    case 'deserterPlayed':
      return t(`log:${event.type}`, { player, other: other('target') });
    case 'cardsTaken':
      return t('log:cardsTaken', { player, other: other('from'), count: num(f.count) });
    case 'progressCardTaken':
      return t('log:progressCardTaken', { player, other: other('from') });
    case 'sabotageDiscard':
      return t('log:sabotageDiscard', { player, count: num(f.count) });
    case 'weddingGift':
      return t('log:weddingGift', { player, other: other('to'), count: num(f.count) });
    case 'roadRemoved':
      return t('log:roadRemoved', { player, by: other('by') });
    case 'barbarianSail':
      return t('log:barbarianSail', { step: num(f.step), steps: num(f.steps) });
    case 'barbarianAttack': {
      const strength = num(f.strength);
      const defense = num(f.defense);
      const defender = seatOf(f.defender);
      const tied = Array.isArray(f.tied) ? f.tied.length : 0;
      const parts =
        f.outcome === 'defended'
          ? [
              t('log:barbarianDefended', { strength, defense }),
              ...(defender === null
                ? []
                : [t('log:barbarianDefender', { player: name(defender) })]),
              ...(tied > 1 ? [t('log:barbarianTied')] : []),
            ]
          : [t('log:barbarianPillaged', { strength, defense })];
      const lost = Array.isArray(f.pillaged)
        ? f.pillaged.flatMap((piece: unknown) => {
            const seat =
              typeof piece === 'object' && piece !== null
                ? seatOf(Reflect.get(piece, 'seat'))
                : null;
            return seat === null ? [] : [t('log:cityPillaged', { player: name(seat) })];
          })
        : [];
      return [...parts, ...lost].join(' ');
    }
    default:
      return null;
  }
}

/** Icons for a knights event in the log, or null to use the default. */
export function knightsEventArt(event: GameEvent, color: string | undefined): string[] | null {
  const seat = color ?? 'blue';
  const f: Record<string, unknown> = Object.fromEntries(Object.entries(event));
  switch (event.type) {
    case 'barbarianSail':
    case 'barbarianAttack':
      return [getBarbarianShipUrl()];
    case 'improvementBuilt':
    case 'metropolisPlaced': {
      const track = trackOf(f.track);
      return track
        ? [
            event.type === 'metropolisPlaced'
              ? getMetropolisIconUrl(track, seat)
              : getTrackIconUrl(track),
          ]
        : null;
    }
    case 'knightBuilt':
    case 'knightActivated':
    case 'knightsActivated':
    case 'knightMoved':
    case 'knightDisplaced':
    case 'knightRelocated':
    case 'knightRemoved':
    case 'robberChased':
      return [getKnightIconUrl(seat, 2, event.type !== 'knightRemoved')];
    case 'knightPromoted':
      return [getKnightIconUrl(seat, Math.min(3, Math.max(1, num(f.level))), true)];
    case 'cityWallBuilt':
      return [getWallIconUrl(seat)];
    case 'cityPillaged':
      return [getDefenderIconUrl()];
    case 'merchantPlaced':
      return [getMerchantIconUrl(seat)];
    case 'cardDealt': {
      const track = trackOf(typeof f.deck === 'string' ? f.deck.replace('progress-', '') : '');
      return track ? [getProgressBackUrl(track)] : null;
    }
    case 'aqueductChosen':
      return [getTrackIconUrl('science')];
    case 'fleetNamed':
    case 'monopolyPlayed':
      return typeof f.kind === 'string' && isCommodity(f.kind)
        ? [getCommodityIconUrl(f.kind)]
        : null;
    default:
      return typeof event.type === 'string' && KNIGHTS_ACTOR_EVENTS.has(event.type)
        ? [getProgressBackUrl('trade')]
        : null;
  }
}

/** An event the screen derives from a change in state, with where it goes among the new events. */
export interface DerivedEvent {
  /** Insert after this many of the update's events. */
  readonly after: number;
  readonly event: GameEvent;
}

/**
 * Log lines the engine does not emit: the barbarian ship's steps and an attack's outcome, read
 * from the change in the module's state across one update.
 */
export function derivedKnightsEvents(
  before: Readonly<GameState>,
  after: Readonly<GameState>,
  events: readonly GameEvent[],
): DerivedEvent[] {
  const was = knightsState(before);
  const now = knightsState(after);
  if (!was || !now) return [];
  const rolled = events.findIndex((event) => event.type === 'diceRolled');
  const position = rolled >= 0 ? rolled + 1 : events.length;
  if (now.barbarians.step > was.barbarians.step)
    return [
      {
        after: position,
        event: {
          type: 'barbarianSail',
          step: now.barbarians.step,
          steps: 7,
        },
      },
    ];
  if (now.barbarians.step < was.barbarians.step && now.lastAttack) {
    const attack = now.lastAttack;
    return [
      {
        after: position,
        event: {
          type: 'barbarianAttack',
          outcome: attack.outcome,
          strength: attack.strength,
          defense: attack.defense,
          defender: attack.defender,
          tied: attack.tied,
          pillaged: attack.pillaged.map((piece) => ({ seat: piece.seat })),
        },
      },
    ];
  }
  return [];
}
