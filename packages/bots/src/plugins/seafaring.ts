import type { CommandShape } from '@cp2p/engine';
import {
  boardInfo,
  firstRoadsToward,
  handScore,
  openSites,
  roadDistances,
  threatWeight,
  vertexScore,
} from '../eval/index.js';
import type { TurnContext } from '../policy/context.js';
import type { BotPlugin } from '../policy/heuristic-bot.js';
import { best, edgeValue, roadToward } from '../policy/setup.js';

/** Gold: the cards that improve the hand most. */
function chooseGold(context: TurnContext): CommandShape | null {
  const hand = context.view.priv.hand;
  const handContext = context.handContext();
  return best(
    context.ofType('CHOOSE_GOLD'),
    (command) => {
      const resources = command.resources;
      const next: Record<string, number> = { ...hand };
      if (typeof resources === 'object' && resources !== null)
        for (const [kind, count] of Object.entries(resources))
          next[kind] = (next[kind] ?? 0) + (typeof count === 'number' ? count : 0);
      return handScore(next, handContext);
    },
    context,
  );
}

/** The pirate: next to the most threatening opponent ships, never beside the bot's own. */
function pirateHex(context: TurnContext): CommandShape | null {
  const { state, seat } = context.view;
  const { graph } = boardInfo(state);
  const ships = state.board.ships ?? [];
  return best(
    context.ofType('MOVE_PIRATE'),
    (command) => {
      const index = graph.hexIndex[String(command.hex)];
      const edges = new Set<string>(index === undefined ? [] : (graph.hexEdges[index] ?? []));
      let score = 0;
      for (const ship of ships) {
        if (!edges.has(ship.edge)) continue;
        score +=
          ship.seat === seat
            ? -3
            : threatWeight(state, ship.seat, seat, context.target, context.config.robberWeights);
      }
      return score;
    },
    context,
  );
}

/** Setup: a road or a ship, whichever leads to the better next site. */
function setupEdge(context: TurnContext): CommandShape | null {
  const open = openSites(context.view.state, context.info);
  return best(
    [...context.ofType('PLACE_ROAD'), ...context.ofType('PLACE_SETUP_SHIP')],
    (command) => edgeValue(context, String(command.edge), open),
    context,
  );
}

/**
 * Ship expansion: when no land site is within easy reach, sail toward the best open site the
 * seat's ships can reach (new islands pay a bonus, and gold hexes pay any resource).
 */
function shipExpansion(context: TurnContext): CommandShape | null {
  const ships = context.ofType('BUILD_SHIP');
  if (!ships.length) return null;
  const goal = context.goal();
  if (goal?.kind === 'settlement' && (goal.roads ?? 0) <= 1) return null;
  const { state, seat } = context.view;
  const info = context.info;
  const open = openSites(state, info);
  const distances = roadDistances(state, seat, 4, info, 'ship');
  let target: { vertex: string; score: number } | null = null;
  for (const vertex of open) {
    const steps = distances.get(vertex);
    if (steps === undefined || steps === 0) continue;
    const score = vertexScore(state, seat, vertex, {}, info, open) - 2.5 * steps;
    if (!target || score > target.score) target = { vertex, score };
  }
  if (!target) return null;
  const first = firstRoadsToward(state, seat, target.vertex, distances, info);
  return ships.find((command) => first.has(String(command.edge))) ?? null;
}

export const seafaringPlugin: BotPlugin = {
  module: 'seafaring',
  decide(context) {
    const { types } = context;
    if (types.has('CHOOSE_GOLD')) return chooseGold(context);
    if (types.has('MOVE_PIRATE') && !types.has('MOVE_ROBBER')) return pirateHex(context);
    if (types.has('PLACE_SETUP_SHIP')) return setupEdge(context);
    if (types.has('PLACE_FREE_SHIP') && !types.has('PLACE_FREE_ROAD'))
      return roadToward(context, 'PLACE_FREE_SHIP');
    return null;
  },
  mainAction: shipExpansion,
};
