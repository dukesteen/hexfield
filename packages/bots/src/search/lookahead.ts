import type { CommandShape, Engine, Seat } from '@cp2p/engine';
import { createRng } from '@cp2p/engine/rng';
import { openSites, tradeGain } from '../eval/index.js';
import type { TurnContext } from '../policy/context.js';
import { edgeValue, settlementValue } from '../policy/setup.js';
import type { Bot, BotRng } from '../types.js';
import { sampledChance } from './chance.js';
import { determinize } from './determinize.js';
import type { World } from './determinize.js';
import { positionValue } from './leaf.js';
import type { LeafWeights } from './leaf.js';
import { rollout } from './rollout.js';

/** The main-phase lookahead (follow-up B): macro-actions played ahead by the fast policy. */
export interface LookaheadSettings {
  /** Sampled worlds per decision (hidden hands, development draws, steals, dice). */
  samples: number;
  /** Rounds played after the bot's turn: 0 stops at its end, 1 after the bot's next turn. */
  rounds: number;
  /** How much better (victory-point units) an alternative must look to overrule the heuristic. */
  margin: number;
  leaf: LeafWeights;
  /** Which moves compete: every macro-action, or only the builds when the heuristic builds. */
  candidates: 'all' | 'builds';
}

/** The purchases that give points or cards now. */
const BUILDS = new Set(['BUILD_CITY', 'BUILD_SETTLEMENT', 'BUY_DEV_CARD']);

/** Commands that start a macro-action worth comparing in the main phase. */
const MACRO_TYPES = new Set([
  'BUILD_CITY',
  'BUILD_SETTLEMENT',
  'BUILD_ROAD',
  'BUY_DEV_CARD',
  'PLAY_DEV_CARD',
  'MARITIME_TRADE',
  'END_TURN',
]);

function counts(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(Object.entries(value).map(([kind, count]) => [kind, Number(count)]));
}

function bestOf(
  commands: readonly CommandShape[],
  score: (command: CommandShape) => number,
): CommandShape | undefined {
  let top: CommandShape | undefined;
  let topScore = -Infinity;
  for (const command of commands) {
    const value = score(command);
    if (value > topScore) {
      top = command;
      topScore = value;
    }
  }
  return top;
}

function distinct(commands: readonly (CommandShape | null | undefined)[]): CommandShape[] {
  const seen = new Set<string>();
  const result: CommandShape[] = [];
  for (const command of commands) {
    if (!command) continue;
    const key = JSON.stringify(command);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(command);
  }
  return result;
}

/**
 * The macro-actions at a main-phase decision: the heuristic's own move, ending the turn (saving),
 * the best city, settlement and road, a development card, the playable knight and road building,
 * and the two bank trades that help the hand most. Null when the heuristic's move is not one of
 * these (trade settling, module actions) or there is nothing to compare.
 */
export function macroCandidates(
  context: TurnContext,
  heuristic: CommandShape,
  which: LookaheadSettings['candidates'] = 'all',
): CommandShape[] | null {
  if (!MACRO_TYPES.has(heuristic.type) || !context.types.has('END_TURN')) return null;
  if (which === 'builds' && !BUILDS.has(heuristic.type)) return null;
  const { state } = context.view;
  const open = openSites(state, context.info);
  const goal = context.goal();
  const hand = context.view.priv.hand;
  const handContext = context.handContext();
  const trades = context
    .ofType('MARITIME_TRADE')
    .map((command) => ({
      command,
      gain: tradeGain(hand, counts(command.get), counts(command.give), handContext) ?? -Infinity,
    }))
    .filter((item) => item.gain > 0)
    .toSorted((a, b) => b.gain - a.gain)
    .slice(0, 2)
    .map((item) => item.command);
  if (which === 'builds') {
    const builds = distinct([
      heuristic,
      bestOf(context.ofType('BUILD_CITY'), (command) =>
        settlementValue(context, String(command.vertex), open),
      ),
      bestOf(context.ofType('BUILD_SETTLEMENT'), (command) =>
        settlementValue(context, String(command.vertex), open),
      ),
      context.ofType('BUY_DEV_CARD')[0],
    ]);
    return builds.length >= 2 ? builds : null;
  }
  const candidates = distinct([
    heuristic,
    context.ofType('END_TURN')[0],
    bestOf(context.ofType('BUILD_CITY'), (command) =>
      settlementValue(context, String(command.vertex), open),
    ),
    bestOf(context.ofType('BUILD_SETTLEMENT'), (command) =>
      settlementValue(context, String(command.vertex), open),
    ),
    bestOf(
      context.ofType('BUILD_ROAD'),
      (command) =>
        edgeValue(context, String(command.edge), open) +
        (goal?.firstEdges?.has(String(command.edge)) ? 5 : 0),
    ),
    context.ofType('BUY_DEV_CARD')[0],
    ...context
      .ofType('PLAY_DEV_CARD')
      .filter((command) => command.card === 'knight' || command.card === 'roadBuilding'),
    ...trades,
  ]);
  return candidates.length >= 2 ? candidates : null;
}

function seedFrom(rng: BotRng): Uint8Array {
  return Uint8Array.from({ length: 32 }, () => rng.int(256));
}

/** A copy of a world whose decks a rollout may draw from. */
export function copyWorld(world: World): World {
  return {
    ...world,
    devDeck: [...world.devDeck],
    decks: new Map([...world.decks].map(([id, cards]) => [id, [...cards]])),
  };
}

/**
 * Compare the macro-actions: in each sampled world (the same world and random stream for every
 * candidate), play the candidate and let the fast policy finish the bot's turn, then score the
 * position with `positionValue`. The heuristic's move is kept unless another is ahead by more
 * than the margin. `late` stops the search between rollouts; a partial sample is dropped.
 */
export function lookahead(
  context: TurnContext,
  candidates: readonly CommandShape[],
  settings: LookaheadSettings,
  policy: (seat: Seat, engine: Engine) => Bot,
  late: () => boolean,
): CommandShape {
  const { view, engine, rng } = context;
  const totals = candidates.map(() => 0);
  let samples = 0;
  for (let sample = 0; sample < settings.samples && !late(); sample++) {
    const world = determinize(view, engine, rng, true);
    const seeds = [seedFrom(rng), seedFrom(rng), seedFrom(rng)];
    const turns = 1 + settings.rounds * view.state.seats.length;
    const values: number[] = [];
    for (const candidate of candidates) {
      if (late()) break;
      const sampled = copyWorld(world);
      // Separate streams, so every candidate sees the same dice in the same order.
      const [policySeed, diceSeed, drawSeed] = seeds;
      if (!policySeed || !diceSeed || !drawSeed) break;
      const end = rollout(
        engine,
        sampled,
        view.seat,
        candidate,
        (seat) => policy(seat, engine),
        createRng(policySeed),
        turns,
        late,
        sampledChance(sampled, createRng(diceSeed), createRng(drawSeed)),
      );
      if (end === 'timeout') break;
      values.push(
        end
          ? positionValue(
              engine,
              end.state,
              end.privates,
              view.seat,
              context.config.plan,
              settings.leaf,
            )
          : -10,
      );
    }
    if (values.length < candidates.length) break;
    values.forEach((value, index) => {
      totals[index] = (totals[index] ?? 0) + value;
    });
    samples++;
  }
  const heuristic = candidates[0];
  if (!heuristic) throw new Error('Lookahead needs the heuristic move');
  if (!samples) return heuristic;
  let chosen = 0;
  for (let index = 1; index < candidates.length; index++)
    if ((totals[index] ?? 0) > (totals[chosen] ?? 0)) chosen = index;
  const pick =
    ((totals[chosen] ?? 0) - (totals[0] ?? 0)) / samples > settings.margin
      ? (candidates[chosen] ?? heuristic)
      : heuristic;
  return pick;
}
