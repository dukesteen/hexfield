import type { CommandShape } from '@cp2p/engine';
import { RESOURCES, knightsOf } from '@cp2p/engine';
import type { Cost } from '../../eval/index.js';
import { incomePerTurn, resourceHand, shortfall } from '../../eval/index.js';
import { openOffers } from '../../offers.js';
import type { TurnContext } from '../../policy/context.js';
import type { BotPlugin } from '../../policy/heuristic-bot.js';
import { discard } from '../../policy/reactions.js';
import { best, settlementValue } from '../../policy/setup.js';
import { openSites } from '../../eval/index.js';
import * as v1 from '../knights-v1.js';
import { defenseNeeds, prepareDefense, recruitSite, urgentDefense } from './barbarians.js';
import {
  improvement,
  improvementV1,
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
import { cardCount, citiesOf, handLimit } from './shared.js';

/** The parts of the knights policy, each measured on its own before it was kept. */
export interface KnightsPolicy {
  /** A policy per progress card (else: played at random now and then). */
  progress: boolean;
  /** Knights planned against the barbarians' estimated arrival. */
  barbarians: boolean;
  /** Improvements and commodities valued by the metropolis race. */
  metropolis: boolean;
  /** City walls by the expected hand size against the limit. */
  walls: boolean;
}

export const KNIGHTS_POLICY: KnightsPolicy = {
  progress: true,
  barbarians: true,
  metropolis: true,
  walls: false,
};

function addCost(cost: Cost, extra: Readonly<Record<string, number>>): Cost {
  const next = { ...cost };
  for (const resource of RESOURCES) next[resource] += extra[resource] ?? 0;
  return next;
}

/**
 * A wall when the hand is expected to top the limit before the bot's next turn (its hand now plus
 * a round of income), and the two bricks do not delay the goal much.
 */
function wallByHand(context: TurnContext): CommandShape | null {
  const walls = context.ofType('BUILD_CITY_WALL');
  if (!walls.length) return null;
  const { state, seat, priv } = context.view;
  const income = Object.values(incomePerTurn(state, seat, context.info)).reduce(
    (sum, value) => sum + value,
    0,
  );
  const expected = cardCount(priv.hand) - 2 + income * state.seats.length * 1.3;
  if (expected <= handLimit(state, seat)) return null;
  const goal = context.goal();
  if (goal) {
    const after = { ...priv.hand, brick: (priv.hand.brick ?? 0) - 2 };
    if (
      shortfall(resourceHand(after), goal.cost) >
      shortfall(resourceHand(priv.hand), goal.cost) + 1
    )
      return null;
  }
  return best(
    walls,
    (command) => settlementValue(context, String(command.vertex), openSites(state, context.info)),
    context,
  );
}

/** Keep at least one knight per city on the board (blocking, chasing, the next attack). */
function utilityKnight(context: TurnContext): CommandShape | null {
  const { state, seat } = context.view;
  const knights = knightsOf(state, seat).length;
  if (knights >= Math.max(1, citiesOf(state, seat).length)) return null;
  return recruitSite(context);
}

function medicine(context: TurnContext): CommandShape | null {
  const plays = context
    .ofType('PLAY_PROGRESS_CARD')
    .filter((command) => command.card === 'medicine');
  if (!plays.length) return null;
  const open = openSites(context.view.state, context.info);
  return best(
    plays,
    (command) => {
      const params = command.params;
      const vertex =
        typeof params === 'object' && params !== null ? String(Reflect.get(params, 'vertex')) : '';
      return settlementValue(context, vertex, open);
    },
    context,
  );
}

/** The knights policy of Normal and Hard; parts switched off play the stage 16 policy. */
export function createKnightsPlugin(policy: KnightsPolicy = KNIGHTS_POLICY): BotPlugin {
  return {
    module: 'knights',
    decide(context) {
      const { types } = context;
      if (types.has('CLAIM_VICTORY')) return null;
      if (types.has('ROLL_DICE')) return policy.progress ? alchemist(context) : null;
      if (types.has('CHOOSE_PROGRESS_DECK')) return v1.progressDeck(context);
      if (types.has('CHOOSE_AQUEDUCT')) return v1.aqueduct(context);
      if (types.has('PLACE_METROPOLIS')) return v1.byCityValue(context, 'PLACE_METROPOLIS', 1);
      if (types.has('CHOOSE_PILLAGE')) return v1.byCityValue(context, 'CHOOSE_PILLAGE', -1);
      if (types.has('DESERTER_REMOVE') || types.has('DESERTER_PLACE') || types.has('DESERTER_SKIP'))
        return v1.deserter(context);
      if (types.has('RELOCATE_KNIGHT')) return v1.relocate(context);
      if (types.has('WEDDING_GIVE')) return discard(context, 'WEDDING_GIVE');
      if (types.has('SABOTEUR_DISCARD')) return discard(context, 'SABOTEUR_DISCARD');
      // Over the progress-card limit a turn cannot end until one is discarded.
      if (types.has('DISCARD_PROGRESS') && !types.has('END_TURN')) {
        if (policy.progress) return salvagePlay(context) ?? progressDiscard(context);
        const discards = context.ofType('DISCARD_PROGRESS');
        return discards[context.rng.int(discards.length)] ?? null;
      }
      // A free-road frame with no road left to place.
      if (types.has('SKIP') && types.size === 1) return context.ofType('SKIP')[0] ?? null;
      if (types.has('HARBOR_REPLY')) {
        if (policy.progress) return harborReply(context);
        const replies = context.ofType('HARBOR_REPLY');
        return replies.find((command) => command.commodity !== 'none') ?? replies[0] ?? null;
      }
      if (!types.has('END_TURN')) return null;
      if (
        openOffers(context.view.state).some(
          (offer) => offer.proposer === context.view.seat || offer.to.includes(context.view.seat),
        )
      )
        return null;
      // Main phase, before the base builds.
      if (policy.barbarians) {
        const defend = urgentDefense(context);
        if (defend) return defend;
      }
      if (policy.progress) {
        const played = progressPlay(context) ?? harborOffer(context) ?? medicine(context);
        if (played) return played;
      }
      if (policy.metropolis) {
        // A metropolis purchase comes before anything else this turn.
        const taken = improvement(context);
        if (taken && improvementValue(context, purchaseTrack(taken)) >= 6) return taken;
        const rush = metropolisRush(context);
        if (rush) return rush;
      }
      return null;
    },
    mainAction(context) {
      const sideways = context.ofType('UPGRADE_SIDEWAYS_CITY')[0];
      if (sideways) return sideways;
      if (!policy.progress) {
        const played = v1.progressCard(context);
        if (played) return played;
      }
      const improved = policy.metropolis ? improvement(context) : improvementV1(context);
      if (improved) return improved;
      if (policy.barbarians) {
        const defended = prepareDefense(context);
        if (defended) return defended;
        const knight = utilityKnight(context);
        if (knight) return knight;
        // A ready knight not needed for the attack drives the robber away and steals.
        const chase = context.ofType('CHASE_ROBBER')[0];
        if (chase && urgentDefense(context) === null) return chase;
      } else {
        const moved = v1.knightMove(context);
        if (moved) return moved;
      }
      return policy.walls ? wallByHand(context) : v1.wall(context);
    },
    handContext(context, base) {
      if (!policy.walls && !policy.barbarians) return base;
      const { state, seat } = context.view;
      const needs = policy.barbarians ? defenseNeeds(context) : null;
      return {
        ...base,
        ...(needs ? { cost: addCost(base.cost, needs) } : {}),
        ...(policy.walls ? { safeCards: handLimit(state, seat) } : {}),
      };
    },
  };
}

export const knightsPlugin: BotPlugin = createKnightsPlugin();
