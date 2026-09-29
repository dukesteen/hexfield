import type { CommandShape, GameState, Seat } from '@cp2p/engine';
import { BARBARIAN_STEPS, knightsExt } from '@cp2p/engine';
import { handScore, rawPips } from '../eval/index.js';
import type { TurnContext } from '../policy/context.js';
import type { BotPlugin } from '../policy/heuristic-bot.js';
import { discard } from '../policy/reactions.js';
import { best } from '../policy/setup.js';

/** Science first (its level-3 Aqueduct pays on a dry roll), then trade, then politics. */
const TRACK_PRIORITY: Readonly<Record<string, number>> = { science: 3, trade: 2, politics: 1 };

function levelOn(levels: object | undefined, track: string): number {
  const level: unknown = levels ? Reflect.get(levels, track) : 0;
  return typeof level === 'number' ? level : 0;
}

function cities(state: GameState, seat?: Seat): number {
  return state.board.buildings.filter(
    (piece) => piece.kind === 'city' && (seat === undefined || piece.seat === seat),
  ).length;
}

/** Active knight strength per seat, and the total. */
function defense(state: GameState): { total: number; bySeat: Map<Seat, number> } {
  const bySeat = new Map<Seat, number>();
  let total = 0;
  for (const knight of knightsExt(state).knights) {
    if (!knight.active) continue;
    bySeat.set(knight.seat, (bySeat.get(knight.seat) ?? 0) + knight.level);
    total += knight.level;
  }
  return { total, bySeat };
}

/**
 * Whether the bot should put knights on the board now: the barbarians are within three ship
 * faces (about a dozen rolls), the island's defense is below their strength, or the bot's own
 * knights are the weakest while it has a city to lose.
 */
function underThreat(context: TurnContext): boolean {
  const { state, seat } = context.view;
  const ext = knightsExt(state);
  const stepsLeft = BARBARIAN_STEPS - ext.barbarians.step;
  const { total, bySeat } = defense(state);
  const mine = bySeat.get(seat) ?? 0;
  const weakest = Math.min(...state.seats.map((holder) => bySeat.get(holder.seat) ?? 0));
  const own = cities(state, seat);
  if (own === 0) return false;
  return stepsLeft <= 3 && (total < cities(state) || mine <= weakest || mine < own);
}

function improvement(context: TurnContext): CommandShape | null {
  const { state, seat } = context.view;
  const levels = knightsExt(state).improvements[seat];
  return best(
    context.ofType('BUILD_IMPROVEMENT'),
    (command) => {
      const track = String(command.track);
      const level = levelOn(levels, track);
      // Cheap early levels first, science's aqueduct at 3 most of all.
      return (
        (TRACK_PRIORITY[track] ?? 0) - level * 0.8 + (track === 'science' && level < 3 ? 1 : 0)
      );
    },
    context,
  );
}

function knightMove(context: TurnContext): CommandShape | null {
  const threat = underThreat(context);
  const activate = context.ofType('ACTIVATE_KNIGHT')[0];
  if (activate && threat) return activate;
  const build = context.ofType('BUILD_KNIGHT');
  const { state, seat } = context.view;
  const mine = defense(state).bySeat.get(seat) ?? 0;
  const knights = knightsExt(state).knights.filter((knight) => knight.seat === seat).length;
  if (build.length && (threat || knights < Math.max(1, cities(state, seat))))
    return best(build, (command) => rawPips(state, String(command.vertex), context.info), context);
  if (activate && knights > 0 && mine < cities(state, seat)) return activate;
  // A ready knight drives the robber off the bot's own production.
  const chase = context.ofType('CHASE_ROBBER')[0];
  if (chase && !threat) return chase;
  return null;
}

function wall(context: TurnContext): CommandShape | null {
  const cards = Object.values(context.view.priv.hand).reduce((sum, count) => sum + count, 0);
  return cards >= 7 ? (context.ofType('BUILD_CITY_WALL')[0] ?? null) : null;
}

/** Progress cards: play a fully specified one now and then (a seat may hold only four). */
function progressCard(context: TurnContext): CommandShape | null {
  const plays = context.ofType('PLAY_PROGRESS_CARD');
  if (!plays.length) return null;
  const held =
    context.view.state.seats
      .find((holder) => holder.seat === context.view.seat)
      ?.cardSlots.filter((slot) => slot.deck.startsWith('progress') && !slot.revealed).length ?? 0;
  if (held < 3 && context.rng.int(3) !== 0) return null;
  return plays[context.rng.int(plays.length)] ?? null;
}

/** The deck of the bot's strongest track: its draws there are likeliest to be good. */
function progressDeck(context: TurnContext): CommandShape | null {
  const { state, seat } = context.view;
  const levels = knightsExt(state).improvements[seat];
  return best(
    context.ofType('CHOOSE_PROGRESS_DECK'),
    (command) => {
      const deck = String(command.deck).replace('progress-', '');
      return levelOn(levels, deck) + (TRACK_PRIORITY[deck] ?? 0) * 0.1;
    },
    context,
  );
}

function aqueduct(context: TurnContext): CommandShape | null {
  const hand = context.view.priv.hand;
  const handContext = context.handContext();
  return best(
    context.ofType('CHOOSE_AQUEDUCT'),
    (command) => {
      const resource = String(command.resource);
      return handScore({ ...hand, [resource]: (hand[resource] ?? 0) + 1 }, handContext);
    },
    context,
  );
}

/** Metropolis on the richest city; a pillaged city is the poorest one. */
function byCityValue(context: TurnContext, type: string, sign: 1 | -1): CommandShape | null {
  return best(
    context.ofType(type),
    (command) => sign * rawPips(context.view.state, String(command.vertex), context.info),
    context,
  );
}

/** The Deserter: give up the weakest knight; place a gained knight as strong and rich as allowed. */
function deserter(context: TurnContext): CommandShape | null {
  const { state } = context.view;
  const levelAt = (vertex: unknown): number =>
    knightsExt(state).knights.find((knight) => knight.vertex === vertex)?.level ?? 0;
  const removes = context.ofType('DESERTER_REMOVE');
  if (removes.length) return best(removes, (command) => -levelAt(command.vertex), context);
  const places = context.ofType('DESERTER_PLACE');
  if (places.length)
    return best(
      places,
      (command) =>
        Number(command.level) * 100 + rawPips(state, String(command.vertex), context.info),
      context,
    );
  return context.ofType('DESERTER_SKIP')[0] ?? null;
}

/** A displaced knight moves to the richest free spot it may take. */
function relocate(context: TurnContext): CommandShape | null {
  return best(
    context.ofType('RELOCATE_KNIGHT'),
    (command) => rawPips(context.view.state, String(command.to), context.info),
    context,
  );
}

export const knightsPlugin: BotPlugin = {
  module: 'knights',
  decide(context) {
    const { types } = context;
    if (types.has('CHOOSE_PROGRESS_DECK')) return progressDeck(context);
    if (types.has('CHOOSE_AQUEDUCT')) return aqueduct(context);
    if (types.has('PLACE_METROPOLIS')) return byCityValue(context, 'PLACE_METROPOLIS', 1);
    if (types.has('CHOOSE_PILLAGE')) return byCityValue(context, 'CHOOSE_PILLAGE', -1);
    if (types.has('DESERTER_REMOVE') || types.has('DESERTER_PLACE') || types.has('DESERTER_SKIP'))
      return deserter(context);
    if (types.has('RELOCATE_KNIGHT')) return relocate(context);
    if (types.has('WEDDING_GIVE')) return discard(context, 'WEDDING_GIVE');
    if (types.has('SABOTEUR_DISCARD')) return discard(context, 'SABOTEUR_DISCARD');
    // Over the progress-card limit a turn cannot end until one is discarded.
    if (types.has('DISCARD_PROGRESS') && !types.has('END_TURN')) {
      const discards = context.ofType('DISCARD_PROGRESS');
      return discards[context.rng.int(discards.length)] ?? null;
    }
    if (types.has('HARBOR_REPLY')) {
      const replies = context.ofType('HARBOR_REPLY');
      return replies.find((command) => command.commodity !== 'none') ?? replies[0] ?? null;
    }
    return null;
  },
  mainAction(context) {
    const sideways = context.ofType('UPGRADE_SIDEWAYS_CITY')[0];
    if (sideways) return sideways;
    const played = progressCard(context);
    if (played) return played;
    return improvement(context) ?? knightMove(context) ?? wall(context);
  },
};
