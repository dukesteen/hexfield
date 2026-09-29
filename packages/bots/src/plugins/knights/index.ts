import type { CommandShape } from '@cp2p/engine';
import { RESOURCES, knightsOf } from '@cp2p/engine';
import { openSites } from '../../eval/index.js';
import type { Cost } from '../../eval/index.js';
import { openOffers } from '../../offers.js';
import type { TurnContext } from '../../policy/context.js';
import type { BotPlugin } from '../../policy/heuristic-bot.js';
import { discard } from '../../policy/reactions.js';
import { best, settlementValue } from '../../policy/setup.js';
import * as v1 from '../knights-v1.js';
import { defenseNeeds, prepareDefense, recruitSite, urgentDefense } from './barbarians.js';
import {
  METROPOLIS_VALUE,
  improvement,
  improvementValue,
  metropolisRush,
  purchaseTrack,
} from './improvements.js';
import {
  alchemist,
  harborOffer,
  harborReply,
  progressDiscard,
  progressPlay,
  salvagePlay,
} from './progress.js';
import { citiesOf, paramOf } from './shared.js';

function addCost(cost: Cost, extra: Readonly<Record<string, number>>): Cost {
  const next = { ...cost };
  for (const resource of RESOURCES) next[resource] += extra[resource] ?? 0;
  return next;
}

/** Keep at least one knight per city on the board (the next attack, chasing the robber). */
function utilityKnight(context: TurnContext): CommandShape | null {
  const { state, seat } = context.view;
  const knights = knightsOf(state, seat).length;
  if (knights >= Math.max(1, citiesOf(state, seat).length)) return null;
  return recruitSite(context);
}

/** Medicine makes any city cheaper: played on the best settlement the hand can upgrade with it. */
function medicine(context: TurnContext): CommandShape | null {
  const open = openSites(context.view.state, context.info);
  return best(
    context.ofType('PLAY_PROGRESS_CARD').filter((command) => command.card === 'medicine'),
    (command) => settlementValue(context, String(paramOf(command, 'vertex')), open),
    context,
  );
}

/**
 * The knights policy of Normal and Hard: a policy per progress card, knights planned against the
 * barbarians' estimated arrival, and the metropolis race. The choices it shares with the stage 16
 * policy (decks, the Aqueduct, metropolis and pillage cities, the Deserter, relocation, walls)
 * come from that frozen policy.
 */
export const knightsPlugin: BotPlugin = {
  module: 'knights',
  decide(context) {
    const { types } = context;
    if (types.has('CLAIM_VICTORY')) return null;
    if (types.has('ROLL_DICE')) return alchemist(context);
    if (types.has('CHOOSE_PROGRESS_DECK')) return v1.progressDeck(context);
    if (types.has('CHOOSE_AQUEDUCT')) return v1.aqueduct(context);
    if (types.has('PLACE_METROPOLIS')) return v1.byCityValue(context, 'PLACE_METROPOLIS', 1);
    if (types.has('CHOOSE_PILLAGE')) return v1.byCityValue(context, 'CHOOSE_PILLAGE', -1);
    if (types.has('DESERTER_REMOVE') || types.has('DESERTER_PLACE') || types.has('DESERTER_SKIP'))
      return v1.deserter(context);
    if (types.has('RELOCATE_KNIGHT')) return v1.relocate(context);
    if (types.has('WEDDING_GIVE')) return discard(context, 'WEDDING_GIVE');
    if (types.has('SABOTEUR_DISCARD')) return discard(context, 'SABOTEUR_DISCARD');
    // Over the progress-card limit a turn cannot end until a card is played or discarded.
    if (types.has('DISCARD_PROGRESS') && !types.has('END_TURN'))
      return salvagePlay(context) ?? progressDiscard(context);
    // A free-road frame with no road left to place.
    if (types.has('SKIP') && types.size === 1) return context.ofType('SKIP')[0] ?? null;
    if (types.has('HARBOR_REPLY')) return harborReply(context);
    if (!types.has('END_TURN')) return null;
    const { state, seat } = context.view;
    if (openOffers(state).some((offer) => offer.proposer === seat || offer.to.includes(seat)))
      return null;
    // Main phase, before the base builds: the attack, the cards, a metropolis within reach.
    const early =
      urgentDefense(context) ?? progressPlay(context) ?? harborOffer(context) ?? medicine(context);
    if (early) return early;
    const taken = improvement(context);
    if (taken && improvementValue(context, purchaseTrack(taken)) >= METROPOLIS_VALUE) return taken;
    return metropolisRush(context);
  },
  mainAction(context) {
    const sideways = context.ofType('UPGRADE_SIDEWAYS_CITY')[0];
    if (sideways) return sideways;
    const built = improvement(context) ?? prepareDefense(context) ?? utilityKnight(context);
    if (built) return built;
    // A ready knight the attack does not need drives the robber away and steals.
    const chase = context.ofType('CHASE_ROBBER')[0];
    if (chase && urgentDefense(context) === null) return chase;
    return v1.wall(context);
  },
  handContext(context, base) {
    const needs = defenseNeeds(context);
    return needs ? { ...base, cost: addCost(base.cost, needs) } : base;
  },
};
