import type { CommandShape, Track } from '@cp2p/engine';
import {
  COMMODITIES,
  RESOURCES,
  TRACKS,
  TRACK_COMMODITY,
  isBaseResource,
  knightsExt,
} from '@cp2p/engine';
import { handScore } from '../../eval/index.js';
import type { TurnContext } from '../../policy/context.js';
import { best } from '../../policy/setup.js';
import { commodityIncome, levelOn, paramOf, plainCities, threatOf } from './shared.js';

/** Level-3 abilities: the Aqueduct pays on every dry roll, the others matter less to a bot. */
const ABILITY: Readonly<Record<Track, number>> = { science: 3, trade: 1.5, politics: 1.5 };

/** Science first (its level-3 Aqueduct pays on a dry roll), then trade, then politics. */
const TRACK_PRIORITY: Readonly<Record<string, number>> = { science: 3, trade: 2, politics: 1 };

/** A purchase worth at least this (one point in cards) takes (or locks) a metropolis. */
export function metropolisValue(context: TurnContext): number {
  return context.config.knightsPolicy.vp;
}

function asTrack(value: unknown): Track {
  return TRACKS.find((track) => track === value) ?? 'science';
}

function trackOf(kind: string): Track | undefined {
  return TRACKS.find((track) => TRACK_COMMODITY[track] === kind);
}

/**
 * Whether the track's metropolis can still come to the bot: unclaimed, or held at level 4 by
 * another seat (level 5 takes it), or held by the bot at 4 (level 5 locks it).
 */
export function metropolisOpen(context: TurnContext, track: Track): boolean {
  const { state, seat } = context.view;
  const holder = knightsExt(state).metropolises[track];
  if (!holder) return true;
  const level = levelOn(state, holder.seat, track);
  return level < 5 && levelOn(state, seat, track) < 5;
}

/**
 * The race for a track: how likely the bot reaches the metropolis first, from its level and
 * commodity income against the best rival's level.
 */
export function raceOdds(context: TurnContext, track: Track): number {
  const { state, seat } = context.view;
  if (!metropolisOpen(context, track)) return 0;
  const mine = levelOn(state, seat, track);
  const holder = knightsExt(state).metropolises[track];
  if (holder?.seat === seat) return 0.8;
  const rival = Math.max(
    0,
    ...state.seats
      .filter((item) => item.seat !== seat)
      .map((item) => levelOn(state, item.seat, track)),
  );
  const income = commodityIncome(state, seat, context.info)[track];
  const lead = mine - rival + Math.min(1.5, income * 8) - 0.5;
  return Math.max(0, Math.min(1, 0.5 + lead * 0.25));
}

/** A commodity's worth in resource cards: more while it feeds a metropolis race the bot can win. */
export function commodityWorth(context: TurnContext, kind: string): number {
  const track = trackOf(kind);
  if (!track) return 0.8;
  const level = levelOn(context.view.state, context.view.seat, track);
  if (level >= 5) return 0.5;
  const { commodityBase, commodityRace } = context.config.knightsPolicy;
  return (
    commodityBase +
    raceOdds(context, track) * commodityRace +
    (level < 3 && track === 'science' ? 0.2 : 0)
  );
}

/** The value of buying the next level of a track now. */
export function improvementValue(context: TurnContext, track: Track): number {
  const { state, seat } = context.view;
  const next = levelOn(state, seat, track) + 1;
  const holder = knightsExt(state).metropolises[track];
  const VP = context.config.knightsPolicy.vp;
  let value = 0.6 + (TRACK_PRIORITY[track] ?? 0) * 0.1;
  if (next === 3) value += ABILITY[track];
  if (next === 4 && !holder) value += 2 * VP;
  if (next === 5 && holder && holder.seat !== seat && levelOn(state, holder.seat, track) < 5)
    value += 2 * VP + 2 * VP * 0.4 * threatOf(context, holder.seat);
  if (next === 5 && holder?.seat === seat) value += VP * 0.6;
  return value;
}

/** The track of an improvement purchase or a Crane. */
export function purchaseTrack(command: CommandShape): Track {
  return asTrack(command.type === 'BUILD_IMPROVEMENT' ? command.track : paramOf(command, 'track'));
}

/** The best improvement to buy now, with a Crane when one discounts it. */
export function improvement(context: TurnContext): CommandShape | null {
  const cranes = context.ofType('PLAY_PROGRESS_CARD').filter((command) => command.card === 'crane');
  const options = [...context.ofType('BUILD_IMPROVEMENT'), ...cranes];
  return best(
    options,
    (command) => {
      const track = purchaseTrack(command);
      // A Crane saves a commodity; used on the level that costs the most.
      const crane =
        command.type === 'BUILD_IMPROVEMENT'
          ? 0
          : 0.2 + levelOn(context.view.state, context.view.seat, track) * 0.3;
      return improvementValue(context, track) + crane;
    },
    context,
  );
}

/**
 * A metropolis within a bank trade or two: trade the cards the bot misses least for the missing
 * commodity, when the purchase then takes (or locks) a metropolis this turn.
 */
export function metropolisRush(context: TurnContext): CommandShape | null {
  if (!context.types.has('MARITIME_TRADE')) return null;
  const { state, seat, priv } = context.view;
  const hand = priv.hand;
  const cranes = context
    .ofType('PLAY_PROGRESS_CARD')
    .filter((command) => command.card === 'crane').length;
  for (const track of TRACKS) {
    const next = levelOn(state, seat, track) + 1;
    const holder = knightsExt(state).metropolises[track];
    const wins =
      (next === 4 && !holder) ||
      (next === 5 &&
        holder !== null &&
        holder.seat !== seat &&
        levelOn(state, holder.seat, track) < 5);
    if (!wins || !plainCities(state, seat).length) continue;
    const kind = TRACK_COMMODITY[track];
    const missing = next - (cranes ? 1 : 0) - (hand[kind] ?? 0);
    if (missing <= 0 || missing > context.config.knightsPolicy.rushTrades) continue;
    const trade = cheapestTrade(context, kind, new Set([kind]));
    if (!trade) continue;
    // Every trade the purchase needs must be payable.
    if (tradesPayable(context, kind) < missing) continue;
    return trade;
  }
  return null;
}

function tradesPayable(context: TurnContext, kind: string): number {
  const hand = context.view.priv.hand;
  const rates = context.handContext().rates;
  let trades = 0;
  for (const give of [...RESOURCES, ...COMMODITIES]) {
    if (give === kind) continue;
    const rate = isBaseResource(give) ? rates[give] : 4;
    trades += Math.floor((hand[give] ?? 0) / rate);
  }
  return trades;
}

/** The legal bank trade for one `kind` that hurts the hand least, or null. */
export function cheapestTrade(
  context: TurnContext,
  kind: string,
  keep: ReadonlySet<string>,
): CommandShape | null {
  const { state, priv } = context.view;
  if ((state.bank[kind] ?? 0) < 1) return null;
  const hand = priv.hand;
  const handContext = context.handContext();
  const base = handScore(hand, handContext);
  let top: { command: CommandShape; loss: number } | null = null;
  for (const give of [...RESOURCES, ...COMMODITIES]) {
    if (keep.has(give)) continue;
    for (const rate of [2, 3, 4]) {
      if ((hand[give] ?? 0) < rate) continue;
      const command = { type: 'MARITIME_TRADE', give: { [give]: rate }, get: { [kind]: 1 } };
      if (!context.valid(command)) continue;
      const after = { ...hand, [give]: (hand[give] ?? 0) - rate };
      const worth = COMMODITIES.includes(give) ? commodityWorth(context, give) * rate : 0;
      const loss = base - handScore(after, handContext) + worth;
      if (!top || loss < top.loss) top = { command, loss };
      break;
    }
  }
  return top?.command ?? null;
}
