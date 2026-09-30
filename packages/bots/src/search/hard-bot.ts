import type { CommandShape, Engine, Seat } from '@cp2p/engine';
import { createRng } from '@cp2p/engine/rng';
import { openSites, robberHexScore } from '../eval/index.js';
import { HARD } from '../policy/config.js';
import type { LevelConfig } from '../policy/config.js';
import type { TurnContext } from '../policy/context.js';
import { HeuristicBot } from '../policy/heuristic-bot.js';
import type { BotPlugin } from '../policy/heuristic-bot.js';
import { edgeValue, settlementValue } from '../policy/setup.js';
import type { Bot, BotRng, DecideContext } from '../types.js';
import { determinize } from './determinize.js';
import { leafValue } from './leaf.js';
import { sampledChance } from './chance.js';
import { copyWorld, lookahead, macroCandidates } from './lookahead.js';
import type { LookaheadSettings } from './lookahead.js';
import { rollout } from './rollout.js';

/** Modules whose chance events the search can sample; other games play the heuristic alone. */
const SEARCHABLE = new Set(['base', 'five-six']);

export interface SearchSettings {
  /** Rollouts per decision when no budget is given. */
  iterations: number;
  /** Turns a rollout plays after the searched move, by decision kind. */
  horizon: { setup: number; main: number; robber: number };
  /** How much better (in victory-point units) an alternative must look to overrule the heuristic. */
  margin: number;
  /** Most candidates searched at one decision. */
  width: number;
  /** Which decisions are searched. */
  searched: { setup: boolean; main: boolean; robber: boolean };
  /**
   * The main-phase lookahead over macro-actions to the end of the bot's turn, scored by a static
   * evaluation (follow-up B); absent or null: off. It replaces the `main` rollouts.
   */
  lookahead?: LookaheadSettings | null;
  /**
   * Sample every module's chance events (event die, progress and fog decks, opponents' progress
   * cards) on separate dice and draw streams, so the search also runs in expansion games
   * (follow-up B). Off: the stage 16 base sampler, and expansion games play the heuristic alone.
   */
  expansions?: boolean;
}

/**
 * About what 300 ms buys on a desktop (a rollout of the opening costs about 10 ms). Searching
 * build decisions in the main phase measured weaker than the heuristic at these budgets, so only
 * the opening settlements and the robber are searched (docs/verification/stage16).
 */
export const DEFAULT_SEARCH: SearchSettings = {
  iterations: 6,
  horizon: { setup: 24, main: 8, robber: 8 },
  margin: 0.08,
  width: 5,
  searched: { setup: true, main: false, robber: true },
};

/** The search the current Hard level plays. */
export const HARD_SEARCH: SearchSettings = DEFAULT_SEARCH;

/** Share of the time budget the search may use before it stops starting work. */
const SEARCH_SHARE = 0.85;

function now(): number {
  return typeof performance === 'undefined' ? 0 : performance.now();
}

function seedFrom(rng: BotRng): Uint8Array {
  return Uint8Array.from({ length: 32 }, () => rng.int(256));
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

function top<T>(items: readonly T[], score: (item: T) => number, count: number): T[] {
  return items
    .map((item) => ({ item, value: score(item) }))
    .toSorted((a, b) => b.value - a.value)
    .slice(0, count)
    .map((entry) => entry.item);
}

/**
 * The Hard bot: the heuristic, plus a determinized Monte Carlo search at the decisions that matter
 * most — opening settlements, robber placement, and what to build (a macro-action per build kind,
 * or saving). Each iteration samples one world consistent with the bot's view (see
 * `determinize`), plays every candidate in that same world with the same dice (paired
 * comparison), rolls out a few turns with the fast heuristic, and scores the leaf. The heuristic's
 * own choice is kept unless an alternative is clearly better. Trades use the heuristic only.
 */
export class HardBot extends HeuristicBot {
  private readonly rolloutBots = new Map<Seat, Bot>();
  /** The rollout policy: the bot's heuristic without trade offers, which rollouts cannot answer. */
  private readonly rolloutConfig: LevelConfig;

  constructor(
    plugins: readonly BotPlugin[],
    engine?: Engine,
    private readonly settings: SearchSettings = DEFAULT_SEARCH,
    config: LevelConfig = HARD,
  ) {
    super(config, plugins, engine);
    this.rolloutConfig = { ...config, offers: false };
  }

  private readonly policyFor = (seat: Seat, engine: Engine): Bot =>
    this.rolloutPolicy(seat, engine);

  private rolloutPolicy(seat: Seat, engine: Engine): Bot {
    let bot = this.rolloutBots.get(seat);
    if (!bot) {
      bot = new HeuristicBot(this.rolloutConfig, this.plugins, engine);
      this.rolloutBots.set(seat, bot);
    }
    return bot;
  }

  protected override choose(context: TurnContext, options: DecideContext): CommandShape | null {
    // The budget covers the whole decision, the heuristic's own work included. The search stops at
    // 85% of it: a rollout step already under way (one fast-policy move) still has to finish.
    const deadline =
      options.timeBudgetMs === undefined ? null : now() + options.timeBudgetMs * SEARCH_SHARE;
    const heuristic = super.choose(context, options);
    if (!heuristic) return heuristic;
    const modules = context.view.state.config.modules;
    if (!this.settings.expansions && !modules.every((module) => SEARCHABLE.has(module.id)))
      return heuristic;
    const macro = this.settings.lookahead;
    if (macro) {
      const candidates = macroCandidates(context, heuristic, macro.candidates);
      if (candidates)
        return lookahead(context, candidates, macro, this.policyFor, () =>
          deadline === null ? false : now() >= deadline,
        );
    }
    const plan = this.candidates(context, heuristic);
    if (!plan || plan.candidates.length < 2) return heuristic;
    return this.search(context, heuristic, plan.candidates, plan.horizon, options, deadline);
  }

  /** The moves worth comparing at this decision, the heuristic's own among them. */
  private candidates(
    context: TurnContext,
    heuristic: CommandShape,
  ): { candidates: CommandShape[]; horizon: number } | null {
    const { width, horizon } = this.settings;
    const { state, seat } = context.view;
    const { searched } = this.settings;
    if (heuristic.type === 'PLACE_SETTLEMENT') {
      if (!searched.setup) return null;
      const open = openSites(state, context.info);
      const options = top(
        context.ofType('PLACE_SETTLEMENT'),
        (command) => settlementValue(context, String(command.vertex), open),
        width,
      );
      return { candidates: distinct([heuristic, ...options]), horizon: horizon.setup };
    }
    if (heuristic.type === 'MOVE_ROBBER') {
      if (!searched.robber) return null;
      const options = top(
        context.ofType('MOVE_ROBBER'),
        (command) =>
          robberHexScore(
            state,
            seat,
            String(command.hex),
            context.target,
            context.config.robberWeights,
          ),
        width - 1,
      );
      return { candidates: distinct([heuristic, ...options]), horizon: horizon.robber };
    }
    const building = new Set([
      'BUILD_CITY',
      'BUILD_SETTLEMENT',
      'BUILD_ROAD',
      'BUY_DEV_CARD',
      'PLAY_DEV_CARD',
      'END_TURN',
    ]);
    if (!searched.main || !building.has(heuristic.type) || !context.types.has('END_TURN'))
      return null;
    const open = openSites(state, context.info);
    const best = (
      type: string,
      score: (command: CommandShape) => number,
    ): CommandShape | undefined => top(context.ofType(type), score, 1)[0];
    const goal = context.goal();
    const options = [
      heuristic,
      best('BUILD_CITY', (command) => settlementValue(context, String(command.vertex), open)),
      best('BUILD_SETTLEMENT', (command) => settlementValue(context, String(command.vertex), open)),
      best(
        'BUILD_ROAD',
        (command) =>
          edgeValue(context, String(command.edge), open) +
          (goal?.firstEdges?.has(String(command.edge)) ? 5 : 0),
      ),
      context.ofType('BUY_DEV_CARD')[0],
      ...context
        .ofType('PLAY_DEV_CARD')
        .filter((command) => command.card === 'knight' || command.card === 'roadBuilding'),
      context.ofType('END_TURN')[0],
    ];
    return { candidates: distinct(options).slice(0, width + 1), horizon: horizon.main };
  }

  private search(
    context: TurnContext,
    heuristic: CommandShape,
    candidates: readonly CommandShape[],
    horizon: number,
    options: DecideContext,
    deadline: number | null,
  ): CommandShape {
    const { view, engine, rng } = context;
    const totals = candidates.map(() => 0);
    const counts = candidates.map(() => 0);
    const iterations =
      options.iterationBudget ?? (deadline === null ? this.settings.iterations : Infinity);
    // Rollout cost so far, so no rollout (or iteration) starts that would end past the deadline.
    let spent = 0;
    let rollouts = 0;
    const average = (): number => (rollouts ? spent / rollouts : 0);
    const late = (work: number): boolean => deadline !== null && now() + work >= deadline;
    for (
      let iteration = 0;
      iteration < iterations && !late(average() * candidates.length);
      iteration++
    ) {
      // One sampled world and one dice stream per iteration, shared by every candidate.
      const sampled = this.settings.expansions === true;
      const world = determinize(view, engine, rng, sampled);
      const seed = seedFrom(rng);
      const streams = sampled ? [seedFrom(rng), seedFrom(rng)] : [];
      const values: number[] = [];
      for (const candidate of candidates) {
        // Out of time mid-iteration: drop the partial iteration, so every candidate keeps the
        // same samples (a paired comparison).
        if (late(average())) break;
        const started = now();
        const copy = copyWorld(world);
        const [diceSeed, drawSeed] = streams;
        const end = rollout(
          engine,
          copy,
          view.seat,
          candidate,
          (seat) => this.rolloutPolicy(seat, engine),
          createRng(seed),
          horizon,
          () => late(0),
          diceSeed && drawSeed
            ? sampledChance(copy, createRng(diceSeed), createRng(drawSeed))
            : undefined,
        );
        if (end === 'timeout') break;
        values.push(end ? leafValue(engine, end.state, end.privates, view.seat) : -10);
        spent += now() - started;
        rollouts++;
      }
      if (values.length < candidates.length) break;
      values.forEach((value, index) => {
        totals[index] = (totals[index] ?? 0) + value;
        counts[index] = (counts[index] ?? 0) + 1;
      });
    }
    // Not one full iteration fitted in the budget: the heuristic decides alone.
    if (!counts[0]) return heuristic;
    const mean = (index: number): number => (totals[index] ?? 0) / Math.max(1, counts[index] ?? 0);
    let chosen = 0;
    for (let index = 1; index < candidates.length; index++)
      if (mean(index) > mean(chosen)) chosen = index;
    // Candidate 0 is the heuristic's choice: keep it unless another is clearly better.
    return mean(chosen) - mean(0) > this.settings.margin
      ? (candidates[chosen] ?? heuristic)
      : heuristic;
  }
}
