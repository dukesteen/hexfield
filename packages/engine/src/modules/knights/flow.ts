import type { HandlerContext } from '../../core/modules/index.js';
import type { CommandShape, LegalCommandSet, Pending } from '../../core/pipeline/index.js';
import type { GameState, PrivateState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { verticesForHex } from '../base/board/index.js';
import { TRACKS } from './config.js';
import { chaseProblem, displaceProblem, moveProblem } from './actions.js';
import { improvementLegal, improvementProblem, privateCanImprove } from './improvements.js';
import { knightReach, knightsOf, recruitSites } from './pieces.js';
import { privateCanPay, purchaseCost, purchaseProblem } from './recruit.js';
import { FLOWS } from './progress/cards.js';
import { discardOptions } from './progress/draw.js';
import { handCount, surplus } from './progress/hand.js';
import { playCommands } from './progress/play.js';
import { slotOf } from './slot.js';
import { knightsExt } from './types.js';

/** What a knights seat may do in its main phase; a special build phase gets the first group only. */
const BUILD_COMMANDS = [
  'BUILD_IMPROVEMENT',
  'BUILD_KNIGHT',
  'ACTIVATE_KNIGHT',
  'PROMOTE_KNIGHT',
  'BUILD_CITY_WALL',
  'UPGRADE_SIDEWAYS_CITY',
];
const ACTION_COMMANDS = ['MOVE_KNIGHT', 'DISPLACE_KNIGHT', 'CHASE_ROBBER'];

/**
 * The `pending` hook: let the building seat buy and act in the main and special build phases,
 * play and discard progress cards in the main phase (the Alchemist before the roll), and hold
 * `END_TURN` back while the seat is over the progress card limit.
 */
export function addKnightsPending(state: GameState, acc: readonly Pending[]): readonly Pending[] {
  const top = state.turn.phase.at(-1);
  if (top?.module === 'base' && top.id === 'preRoll') {
    const seat = state.turn.activeSeat;
    return handCount(state, seat) > 0
      ? acc.map((item) =>
          item.kind === 'player' && item.seat === seat && item.allowed.includes('ROLL_DICE')
            ? { ...item, allowed: [...item.allowed, 'PLAY_PROGRESS_CARD'] }
            : item,
        )
      : acc;
  }
  const where = slotOf(state);
  if (where === null) return acc;
  const cards =
    where.slot === 'main'
      ? [
          ...(handCount(state, where.seat) > 0 ? ['PLAY_PROGRESS_CARD'] : []),
          ...(surplus(state, where.seat) > 0 ? ['DISCARD_PROGRESS'] : []),
          ...FLOWS.flatMap((flow) => flow.mainCommands?.(state, where.seat) ?? []),
        ]
      : [];
  const added =
    where.slot === 'sbp' ? BUILD_COMMANDS : [...BUILD_COMMANDS, ...ACTION_COMMANDS, ...cards];
  const blocked = where.slot === 'main' && surplus(state, where.seat) > 0;
  return acc.map((item) =>
    item.kind === 'player' &&
    item.seat === where.seat &&
    (where.slot === 'sbp' || item.allowed.includes('END_TURN'))
      ? {
          ...item,
          allowed: [...item.allowed.filter((type) => !(blocked && type === 'END_TURN')), ...added],
        }
      : item,
  );
}

/** Whether the seat can pay for a purchase now: by its own hand if known, else by public bounds. */
function payable(
  state: GameState,
  seat: Seat,
  type: string,
  priv: PrivateState | undefined,
  ctx: HandlerContext,
): boolean {
  const cost = purchaseCost(state, type, ctx);
  if (!cost.ok) return false;
  return priv ? privateCanPay(priv, cost.value) : true;
}

function purchases(
  state: GameState,
  seat: Seat,
  priv: PrivateState | undefined,
  ctx: HandlerContext,
): CommandShape[] {
  const knights = knightsOf(state, seat);
  const ext = knightsExt(state);
  const candidates: { type: string; vertices: string[] }[] = [
    { type: 'BUILD_KNIGHT', vertices: recruitSites(state, seat) },
    {
      type: 'ACTIVATE_KNIGHT',
      vertices: knights.filter((knight) => !knight.active).map((knight) => knight.vertex),
    },
    { type: 'PROMOTE_KNIGHT', vertices: knights.map((knight) => knight.vertex) },
    {
      type: 'BUILD_CITY_WALL',
      vertices: state.board.buildings
        .filter((piece) => piece.seat === seat && piece.kind === 'city')
        .map((piece) => piece.vertex)
        .toSorted(),
    },
    {
      type: 'UPGRADE_SIDEWAYS_CITY',
      vertices: ext.sideways.filter((piece) => piece.seat === seat).map((piece) => piece.vertex),
    },
  ];
  return candidates.flatMap(({ type, vertices }) =>
    vertices.length > 0 && payable(state, seat, type, priv, ctx)
      ? vertices
          .filter((vertex) => purchaseProblem(state, seat, type, vertex).ok)
          .map((vertex) => ({ type, vertex }))
      : [],
  );
}

function actions(state: GameState, seat: Seat, ctx: HandlerContext): CommandShape[] {
  const ready = knightsOf(state, seat).filter((knight) => knight.active && knight.ready);
  const commands: CommandShape[] = [];
  for (const knight of ready) {
    const reach = knightReach(state, seat, knight.vertex);
    for (const to of reach.empty)
      if (moveProblem(state, seat, knight.vertex, to).ok)
        commands.push({ type: 'MOVE_KNIGHT', from: knight.vertex, to });
    for (const to of reach.foes)
      if (displaceProblem(state, seat, knight.vertex, to).ok)
        commands.push({ type: 'DISPLACE_KNIGHT', from: knight.vertex, to });
  }
  const hex = state.board.robberHex;
  if (hex !== null && !knightsExt(state).robberLocked)
    for (const vertex of verticesForHex(state, hex).toSorted())
      if (chaseProblem(state, seat, vertex, ctx).ok)
        commands.push({ type: 'CHASE_ROBBER', vertex });
  return commands;
}

/** The `legalCommands` hook: improvements, knight purchases, walls and (in the main phase) actions. */
export function addKnightsCommands(
  state: GameState,
  seat: Seat,
  priv: PrivateState | undefined,
  acc: LegalCommandSet,
  ctx?: HandlerContext,
): LegalCommandSet {
  const top = state.turn.phase.at(-1);
  if (top?.module === 'base' && top.id === 'preRoll' && seat === state.turn.activeSeat && ctx) {
    const plays = playCommands(state, seat, priv, ctx, 'preRoll');
    return plays.commands.length || plays.templates.length
      ? {
          commands: [...acc.commands, ...plays.commands],
          templates: [...acc.templates, ...plays.templates],
        }
      : acc;
  }
  const where = slotOf(state);
  if (where === null || where.seat !== seat) return acc;
  const improvements = TRACKS.filter((track) =>
    priv
      ? improvementProblem(state, seat, track).ok && privateCanImprove(state, seat, track, priv)
      : improvementLegal(state, seat, track).ok,
  ).map((track) => ({ type: 'BUILD_IMPROVEMENT', track }));
  const commands: CommandShape[] = [...improvements];
  const templates: LegalCommandSet['templates'] = [];
  if (ctx) {
    commands.push(...purchases(state, seat, priv, ctx));
    if (where.slot === 'main') {
      commands.push(...actions(state, seat, ctx));
      const plays = playCommands(state, seat, priv, ctx, 'main');
      commands.push(...plays.commands);
      templates.push(...plays.templates);
      if (surplus(state, seat) > 0) {
        const discards = discardOptions(state, seat, priv, 1, surplus(state, seat));
        commands.push(...discards.commands);
        templates.push(...discards.templates);
      }
      for (const flow of FLOWS) {
        const extra = flow.legal?.(state, seat, priv, ctx);
        commands.push(...(extra?.commands ?? []));
        templates.push(...(extra?.templates ?? []));
      }
    }
  }
  return commands.length || templates.length
    ? { commands: [...acc.commands, ...commands], templates: [...acc.templates, ...templates] }
    : acc;
}
