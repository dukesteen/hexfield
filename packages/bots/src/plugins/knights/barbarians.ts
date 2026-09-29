import type { CommandShape } from '@cp2p/engine';
import { barbarianStrength, knightsExt, knightsOf } from '@cp2p/engine';
import { rawPips } from '../../eval/index.js';
import type { TurnContext } from '../../policy/context.js';
import { best } from '../../policy/setup.js';
import { attackChance, idleStrength, plainCities, rollsToAttack, strengths } from './shared.js';

/** Activate for the attack once it is at least this likely before the bot's next action phase. */
const ACTIVATE_AT = 0.25;

/** What the bot's knights must reach for the coming attack. */
export interface DefensePlan {
  /** Active strength the bot wants when the ship lands. */
  target: number;
  /** Its active strength now. */
  active: number;
  /** Its strength counting inactive knights. */
  potential: number;
  /** Chance of the attack before its next action phase. */
  chance: number;
}

/**
 * The strength the bot needs: enough not to be the weakest eligible seat or for the island to
 * hold (whichever is cheaper; when being out-ranked is cheaper the attack is left to succeed
 * against the others), plus the Defender of Catan point when it costs at most one more strength.
 * Opponents are assumed to activate every knight they have, which is the worst case for ranking.
 */
export function defensePlan(context: TurnContext): DefensePlan {
  const { state, seat } = context.view;
  const bySeat = strengths(state);
  const active = bySeat.get(seat) ?? 0;
  const potential = active + idleStrength(state, seat);
  const cities = barbarianStrength(state);
  let others = 0;
  let strongest = 0;
  let weakestEligible = Infinity;
  for (const holder of state.seats) {
    if (holder.seat === seat) continue;
    const now = bySeat.get(holder.seat) ?? 0;
    const most = now + idleStrength(state, holder.seat);
    others += now;
    strongest = Math.max(strongest, most);
    if (plainCities(state, holder.seat).length) weakestEligible = Math.min(weakestEligible, most);
  }
  const hold = Math.max(0, cities - others);
  const outrank = weakestEligible === Infinity ? Infinity : weakestEligible + 1;
  const safety = plainCities(state, seat).length ? Math.min(hold, outrank) : 0;
  const defender = Math.max(hold, strongest + 1);
  const target = defender - safety <= 1 && defender <= potential + 1 ? defender : safety;
  return { target, active, potential, chance: attackChance(state) };
}

function activation(context: TurnContext): CommandShape | null {
  const { state } = context.view;
  const levelAt = (vertex: unknown): number =>
    knightsExt(state).knights.find((knight) => knight.vertex === vertex)?.level ?? 0;
  return best(context.ofType('ACTIVATE_KNIGHT'), (command) => levelAt(command.vertex), context);
}

/** A promotion of the bot's strongest promotable knight, active ones first. */
function promotion(context: TurnContext, activeOnly: boolean): CommandShape | null {
  const { state } = context.view;
  const knightAt = (vertex: unknown) =>
    knightsExt(state).knights.find((knight) => knight.vertex === vertex);
  return best(
    context
      .ofType('PROMOTE_KNIGHT')
      .filter((command) => !activeOnly || knightAt(command.vertex)?.active),
    (command) =>
      (knightAt(command.vertex)?.active ? 10 : 0) + (knightAt(command.vertex)?.level ?? 0),
    context,
  );
}

/**
 * Before the attack is likely (a turn ahead), activate knights up to the plan's target, and
 * promote an active knight if activations cannot reach it.
 */
export function urgentDefense(context: TurnContext): CommandShape | null {
  const plan = defensePlan(context);
  if (plan.chance < ACTIVATE_AT || plan.active >= plan.target) return null;
  return activation(context) ?? promotion(context, true);
}

/**
 * Within about two rounds of the attack, put enough knight strength on the board (recruits or
 * promotions) that activating it reaches the plan's target.
 */
export function prepareDefense(
  context: TurnContext,
  recruitSite: (commands: CommandShape[]) => CommandShape | null,
): CommandShape | null {
  const { state, seat } = context.view;
  const plan = defensePlan(context);
  if (plan.potential >= plan.target) return null;
  if (rollsToAttack(state) > 2 * state.seats.length + 2) return null;
  const promote = promotion(context, false);
  const recruit = recruitSite(context.ofType('BUILD_KNIGHT'));
  // A promotion needs no grain to activate when the knight is already active.
  const knights = knightsOf(state, seat);
  if (promote && knights.some((knight) => knight.active && knight.vertex === promote.vertex))
    return promote;
  return recruit ?? promote;
}

/** Where to recruit when nothing better is known: the richest vertex. */
export function richestSite(context: TurnContext, commands: CommandShape[]): CommandShape | null {
  return best(
    commands,
    (command) => rawPips(context.view.state, String(command.vertex), context.info),
    context,
  );
}
