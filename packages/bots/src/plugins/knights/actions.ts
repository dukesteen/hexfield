import type { CommandShape, GameState, Seat } from '@cp2p/engine';
import { baseLongestRoadLength, knightsExt } from '@cp2p/engine';
import { openSites, pips } from '../../eval/index.js';
import type { TurnContext } from '../../policy/context.js';
import { best, settlementValue } from '../../policy/setup.js';
import { defensePlan } from './barbarians.js';
import { threatOf } from './shared.js';

/** An action is worth taking once it scores this much (in cards). */
const WORTH = 1;

function vertexHexes(context: TurnContext, vertex: string): string[] {
  const index = context.info.graph.vertexIndex[vertex];
  return index === undefined ? [] : [...(context.info.graph.vertexHexes[index] ?? [])];
}

function neighbors(context: TurnContext, vertex: string): string[] {
  const index = context.info.graph.vertexIndex[vertex];
  return index === undefined ? [] : [...(context.info.graph.vertexNeighbors[index] ?? [])];
}

/** Seats other than the bot whose road ends next to the vertex (they could build there soon). */
function contenders(context: TurnContext, vertex: string): Seat[] {
  const { state, seat } = context.view;
  const index = context.info.graph.vertexIndex[vertex];
  const edges = new Set<string>(
    index === undefined ? [] : (context.info.graph.vertexEdges[index] ?? []),
  );
  const seats = new Set<Seat>();
  for (const road of state.board.roads)
    if (road.seat !== seat && edges.has(road.edge)) seats.add(road.seat);
  return [...seats];
}

/** How much a knight on the vertex cuts the Longest Road holder's road, when that is an opponent. */
function roadCut(context: TurnContext, vertex: string): number {
  const { state, seat } = context.view;
  const holder = state.awards.longestRoad;
  if (holder === null || holder === undefined || holder === seat) return 0;
  const before = baseLongestRoadLength(state, holder);
  // A knight blocks an opposing trail like a building: measure with a stand-in settlement.
  const blocked: GameState = {
    ...state,
    board: {
      ...state.board,
      buildings: [...state.board.buildings, { seat, vertex, kind: 'settlement' }],
    },
  };
  const after = baseLongestRoadLength(blocked, holder);
  const rival = Math.max(
    4,
    ...state.seats
      .filter((item) => item.seat !== holder)
      .map((item) => baseLongestRoadLength(state, item.seat)),
  );
  if (after >= before) return 0;
  return after <= rival ? 4 * threatOf(context, holder) : 0.3 * (before - after);
}

/**
 * What a knight standing on the vertex is worth beyond its strength: it keeps a site the bot wants
 * from a rival about to reach it, cuts the leader's Longest Road, and stands by the bot's
 * richest hexes to chase the robber from them.
 */
export function standValue(
  context: TurnContext,
  vertex: string,
  open: ReadonlySet<string>,
): number {
  const { state, seat } = context.view;
  let value = 0;
  if (open.has(vertex)) {
    const rivals = contenders(context, vertex);
    if (rivals.length)
      value +=
        settlementValue(context, vertex, open) *
        0.08 *
        Math.max(...rivals.map((other) => threatOf(context, other)));
  }
  value += roadCut(context, vertex);
  const own = new Set(
    state.board.buildings.filter((piece) => piece.seat === seat).map((piece) => piece.vertex),
  );
  for (const hex of vertexHexes(context, vertex)) {
    const index = context.info.graph.hexIndex[hex];
    const shares = (
      index === undefined ? [] : (context.info.graph.hexVertices[index] ?? [])
    ).filter((item) => own.has(item)).length;
    const token = state.board.hexes.find((item) => item.id === hex)?.token;
    value += shares * pips(token) * 0.04;
  }
  return value;
}

/** Recruit on the vertex worth most to stand on (a contested site, a cut road, the bot's hexes). */
export function recruitSite(context: TurnContext, commands: CommandShape[]): CommandShape | null {
  const open = openSites(context.view.state, context.info);
  return best(commands, (command) => standValue(context, String(command.vertex), open), context);
}

/** Whether a knight of this level can leave the defense (it becomes inactive when it acts). */
function spare(context: TurnContext, level: number): boolean {
  const plan = defensePlan(context);
  if (plan.chance < 0.1) return true;
  const grain = context.view.priv.hand.grain ?? 0;
  return plan.active - level >= plan.target || grain >= 1;
}

function levelAt(state: GameState, vertex: unknown): number {
  return knightsExt(state).knights.find((knight) => knight.vertex === vertex)?.level ?? 0;
}

/**
 * A knight action worth its knight's readiness: chase the robber off the bot's hexes, displace a
 * knight that blocks a site the bot wants, or step onto a contested site or the leader's road.
 */
export function knightAction(context: TurnContext): CommandShape | null {
  const { state, seat } = context.view;
  const open = openSites(state, context.info);
  const scored: { command: CommandShape; value: number }[] = [];
  const robber = state.board.robberHex;
  for (const command of context.ofType('CHASE_ROBBER')) {
    if (!spare(context, levelAt(state, command.vertex))) continue;
    let value = 0.8;
    if (robber) {
      const index = context.info.graph.hexIndex[robber];
      const token = state.board.hexes.find((item) => item.id === robber)?.token;
      for (const piece of state.board.buildings)
        if (
          piece.seat === seat &&
          index !== undefined &&
          (context.info.graph.hexVertices[index] ?? []).some((vertex) => vertex === piece.vertex)
        )
          value += pips(token) * (piece.kind === 'city' ? 2 : 1) * 0.3;
    }
    scored.push({ command, value });
  }
  const goal = context.goal();
  const wanted = new Set<string>();
  if (goal?.kind === 'settlement' && goal.vertex) wanted.add(goal.vertex);
  for (const command of context.ofType('DISPLACE_KNIGHT')) {
    const from = String(command.from);
    const to = String(command.to);
    if (!spare(context, levelAt(state, from))) continue;
    const victim = knightsExt(state).knights.find((knight) => knight.vertex === to);
    let value = standValue(context, to, open) - standValue(context, from, open);
    if (wanted.has(to) || neighbors(context, to).some((vertex) => wanted.has(vertex))) value += 2;
    if (victim?.active) value += victim.level * 0.5 * threatOf(context, victim.seat);
    scored.push({ command, value });
  }
  for (const command of context.ofType('MOVE_KNIGHT')) {
    const from = String(command.from);
    const to = String(command.to);
    if (!spare(context, levelAt(state, from))) continue;
    // A knight on the bot's own planned site would block its settlement.
    if (wanted.has(to)) continue;
    const value = standValue(context, to, open) - standValue(context, from, open) - 0.5;
    scored.push({ command, value });
  }
  const top = best(scored, (item) => item.value, context);
  return top && top.value >= WORTH ? top.command : null;
}
