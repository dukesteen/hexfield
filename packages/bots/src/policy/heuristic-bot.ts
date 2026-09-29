import { engineForConfig } from '@cp2p/engine';
import type { CommandShape, Engine, Pending, Seat } from '@cp2p/engine';
import { RandomBot } from '../random-bot.js';
import type { Bot, BotRng, BotView, DecideContext } from '../types.js';
import type { LevelConfig } from './config.js';
import { createTurnContext } from './context.js';
import type { TurnContext } from './context.js';
import { knightBeforeRoll, mainTurn } from './main.js';
import type { TurnMemory } from './main.js';
import { discard, respondToOffer, robberHex, stealVictim, wantsTradeWith } from './reactions.js';
import { roadToward, setupSettlement } from './setup.js';

/** Per-module policy: decisions its module adds, and optional main-phase actions. */
export interface BotPlugin {
  module: string;
  /** A decision for the current request, or null to let the base policy decide. */
  decide?(context: TurnContext): CommandShape | null;
  /** A module action worth taking in the main phase after the base builds, or null. */
  mainAction?(context: TurnContext): CommandShape | null;
}

type PlayerPending = Extract<Pending, { kind: 'player' }>;

/**
 * A heuristic player. Every decision is scored over the seat's legal commands (or built from a
 * legal template and validated), so it never submits an illegal command. A request no policy
 * covers falls back to the random policy, reported through `context.warn`.
 */
export class HeuristicBot implements Bot {
  readonly id: string;
  private readonly fallback: RandomBot;
  private memory: TurnMemory = { turn: -1, offers: 0 };

  constructor(
    readonly config: LevelConfig,
    private readonly plugins: readonly BotPlugin[] = [],
    private readonly fixedEngine?: Engine,
  ) {
    this.id = config.id;
    this.fallback = new RandomBot(fixedEngine);
  }

  protected engineFor(view: BotView): Engine {
    return this.fixedEngine ?? engineForConfig(view.state.config);
  }

  protected contextFor(view: BotView, pending: PlayerPending, rng: BotRng): TurnContext {
    return createTurnContext(view, this.engineFor(view), pending, this.config, rng);
  }

  wantsTrade(
    view: BotView,
    gets: Readonly<Record<string, number>>,
    gives: Readonly<Record<string, number>>,
    partner: Seat,
  ): boolean {
    const pending: PlayerPending = { kind: 'player', seat: view.seat, allowed: [] };
    const context = this.contextFor(view, pending, { int: () => 0 });
    return wantsTradeWith(context, gets, gives, partner);
  }

  decide(view: BotView, pending: Pending, rng: BotRng, options: DecideContext = {}): CommandShape {
    if (view.priv.seat !== view.seat || pending.kind !== 'player' || pending.seat !== view.seat)
      throw new Error('Bot decision requires its own player pending');
    // Memory lasts one turn; turn numbers (not state identity, which a worker's copies lack) say
    // when a turn, or a game, changes.
    if (this.memory.turn !== view.state.turn.number)
      this.memory = { turn: view.state.turn.number, offers: 0 };
    const context = this.contextFor(view, pending, rng);
    const chosen = this.choose(context, options);
    if (chosen && context.valid(chosen)) return chosen;
    options.warn?.(
      `${this.id} bot has no policy for ${[...context.types].toSorted().join(', ') || 'this request'}; playing a random legal move`,
    );
    return this.fallback.decide(view, pending, rng);
  }

  /** The policy's choice, or null when it has none. Subclasses (the searching bot) extend this. */
  protected choose(context: TurnContext, _options: DecideContext): CommandShape | null {
    const active = new Set(context.view.state.config.modules.map((module) => module.id));
    for (const plugin of this.plugins) {
      if (!active.has(plugin.module)) continue;
      const decided = plugin.decide?.(context);
      if (decided) return decided;
    }
    return this.baseChoice(context);
  }

  protected baseChoice(context: TurnContext): CommandShape | null {
    const { types } = context;
    if (types.has('PLACE_SETTLEMENT')) return setupSettlement(context);
    if (types.has('PLACE_ROAD')) return roadToward(context, 'PLACE_ROAD');
    if (types.has('DISCARD')) return discard(context);
    if (types.has('MOVE_ROBBER')) return robberHex(context);
    if (types.has('STEAL')) return stealVictim(context);
    if (types.has('PLACE_FREE_ROAD')) return roadToward(context, 'PLACE_FREE_ROAD');
    if (types.has('ROLL_DICE'))
      return knightBeforeRoll(context) ?? context.ofType('ROLL_DICE')[0] ?? null;
    if (types.has('END_TURN') || types.has('END_SBP'))
      return mainTurn(context, this.memory, () => this.mainAction(context));
    if (types.has('RESPOND_TRADE')) return respondToOffer(context);
    if (types.has('CLAIM_VICTORY')) return context.ofType('CLAIM_VICTORY')[0] ?? null;
    // A lone optional trade request off-turn (a counter-offer template) needs no answer.
    return null;
  }

  private mainAction(context: TurnContext): CommandShape | null {
    const active = new Set(context.view.state.config.modules.map((module) => module.id));
    for (const plugin of this.plugins) {
      if (!active.has(plugin.module)) continue;
      const action = plugin.mainAction?.(context);
      if (action) return action;
    }
    return null;
  }
}
