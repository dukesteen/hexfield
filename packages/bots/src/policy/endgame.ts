import type { CommandShape, Seat } from '@cp2p/engine';
import { baseLongestRoadLength } from '@cp2p/engine';
import { estimatedPoints, publicPoints } from '../eval/index.js';
import type { PointsOf, RobberWeights } from '../eval/index.js';
import type { TurnContext } from './context.js';

/**
 * Endgame awareness (follow-up B). With it on, the bot reads every seat's points as public points
 * plus the likely hidden victory cards (from public information only), puts the robber and its
 * steals on a rival close to winning, refuses that rival's trades and leaves it out of its own
 * offers, and takes the road a rival needs for a longest road that would win the game.
 */

/** Every seat's points as this bot reads them. */
export function pointsFor(context: TurnContext): PointsOf {
  const { state, priv } = context.view;
  return context.config.endgame ? estimatedPoints(state, priv) : publicPoints(state);
}

/** Opponents whose estimated points are within `margin` (default: the endgame's) of the target. */
export function closeRivals(context: TurnContext, margin?: number): Seat[] {
  const endgame = context.config.endgame;
  if (!endgame) return [];
  const points = context.points();
  const within = margin ?? endgame.margin;
  return context.view.state.seats
    .filter((holder) => holder.seat !== context.view.seat)
    .filter((holder) => points(holder.seat) >= context.target - within)
    .map((holder) => holder.seat);
}

/** The robber weights, with the extra focus on a close rival when endgame awareness is on. */
export function robberWeightsFor(context: TurnContext): RobberWeights {
  const weights = context.config.robberWeights;
  const endgame = context.config.endgame;
  if (!endgame) return weights;
  return { ...weights, near: weights.near + endgame.focus, nearMargin: endgame.margin };
}

/** Whether the bot refuses any trade with this partner, however good for itself. */
export function refusesPartner(context: TurnContext, partner: Seat): boolean {
  const endgame = context.config.endgame;
  return endgame !== null && closeRivals(context, endgame.refuseMargin).includes(partner);
}

/** The seats a trade offer goes to: everyone but a rival close to winning (null: everyone). */
export function offerRecipients(context: TurnContext): Seat[] | null {
  const endgame = context.config.endgame;
  if (!endgame) return null;
  const excluded = closeRivals(context, endgame.refuseMargin);
  if (!excluded.length) return null;
  return context.view.state.seats
    .map((holder) => holder.seat)
    .filter((seat) => seat !== context.view.seat && !excluded.includes(seat));
}

/**
 * A road that blocks a close rival from the longest road that would win it the game: the award's
 * two points would reach the target, and one more road at the end of the rival's network would
 * take the award. Only when at most two edges would do it (one road then blocks half or all).
 */
export function blockRoad(context: TurnContext): CommandShape | null {
  const endgame = context.config.endgame;
  if (!endgame?.blockRoads) return null;
  const roads = context.ofType('BUILD_ROAD');
  if (!roads.length) return null;
  const { state } = context.view;
  const { graph } = context.info;
  const points = context.points();
  const holder = state.awards.longestRoad;
  const held = holder === null || holder === undefined ? 4 : baseLongestRoadLength(state, holder);
  for (const rival of closeRivals(context, 2)) {
    if (holder === rival || points(rival) + 2 < context.target) continue;
    if (baseLongestRoadLength(state, rival) + 1 <= held) continue;
    const taken = new Set(state.board.roads.map((road) => road.edge));
    const ends = new Set(
      state.board.roads
        .filter((road) => road.seat === rival)
        .flatMap((road) => {
          const index = graph.edgeIndex[road.edge];
          return index === undefined ? [] : [...(graph.edgeVertices[index] ?? [])];
        }),
    );
    const winning: string[] = [];
    for (const vertex of ends) {
      const index = graph.vertexIndex[vertex];
      const blocked = state.board.buildings.some(
        (piece) => piece.vertex === vertex && piece.seat !== rival,
      );
      if (index === undefined || blocked) continue;
      for (const edge of graph.vertexEdges[index] ?? []) {
        if (taken.has(edge) || winning.includes(edge)) continue;
        const board = { ...state.board, roads: [...state.board.roads, { edge, seat: rival }] };
        if (baseLongestRoadLength({ ...state, board }, rival) > held) winning.push(edge);
      }
    }
    if (!winning.length || winning.length > 2) continue;
    const block = roads.find((command) => winning.includes(String(command.edge)));
    if (block) return block;
  }
  return null;
}
