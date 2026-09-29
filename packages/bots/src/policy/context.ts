import type { CommandShape, Engine, GameState, LegalCommandSet, Pending, Seat } from '@cp2p/engine';
import { boardInfo, incomePerTurn, planGoals, tradeRates } from '../eval/index.js';
import type { BoardInfo, Goal, HandContext } from '../eval/index.js';
import type { BotRng, BotView } from '../types.js';
import type { LevelConfig } from './config.js';

/** Everything one decision reads, computed once and shared by the policy and its plugins. */
export interface TurnContext {
  view: BotView;
  engine: Engine;
  pending: Extract<Pending, { kind: 'player' }>;
  config: LevelConfig;
  rng: BotRng;
  info: BoardInfo;
  /** Legal concrete commands allowed by the pending request. */
  commands: readonly CommandShape[];
  /** Legal command templates (discards, trades, choices) allowed by the pending request. */
  templates: LegalCommandSet['templates'];
  /** Command types available now, concrete or templated. */
  types: ReadonlySet<string>;
  /** Victory points needed to win. */
  target: number;
  /** Lazily computed plan: every build goal, best first. */
  goals(): readonly Goal[];
  /** The goal the seat saves for, or null when nothing is left to build. */
  goal(): Goal | null;
  /** How the seat values a hand, toward its current goal. */
  handContext(): HandContext;
  /** True when the engine accepts the command from this seat now. */
  valid(command: CommandShape): boolean;
  /** The concrete legal commands of one type. */
  ofType(type: string): CommandShape[];
}

function victoryTarget(engine: Engine, state: GameState): number {
  const base = state.config.options.base;
  const configured =
    typeof base === 'object' &&
    base !== null &&
    'vpTarget' in base &&
    typeof base.vpTarget === 'number'
      ? base.vpTarget
      : 10;
  return engine.hooks.vpTarget(state.config, configured);
}

export function publicVp(state: GameState, seat: Seat): number {
  return state.seats.find((item) => item.seat === seat)?.publicVp ?? 0;
}

export function createTurnContext(
  view: BotView,
  engine: Engine,
  pending: Extract<Pending, { kind: 'player' }>,
  config: LevelConfig,
  rng: BotRng,
): TurnContext {
  const { state, seat, priv } = view;
  const info = boardInfo(state);
  const legal = engine.getLegalCommands(state, seat, priv);
  const allowed = new Set(pending.allowed);
  const commands = legal.commands.filter((command) => allowed.has(command.type));
  const templates = legal.templates.filter((template) => allowed.has(template.type));
  const types = new Set([...commands, ...templates].map((item) => item.type));
  let goals: Goal[] | null = null;
  let handContext: HandContext | null = null;
  const context: TurnContext = {
    view,
    engine,
    pending,
    config,
    rng,
    info,
    commands,
    templates,
    types,
    target: victoryTarget(engine, state),
    goals() {
      goals ??= planGoals(state, seat, priv.hand, config.plan, info);
      return goals;
    },
    goal() {
      return context.goals()[0] ?? null;
    },
    handContext() {
      if (!handContext) {
        const goal = context.goal();
        handContext = {
          cost: goal?.cost ?? { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 },
          income: incomePerTurn(state, seat, info),
          rates: tradeRates(state, seat, info),
          otherKind: config.commodityValue,
        };
      }
      return handContext;
    },
    valid(command) {
      return (
        allowed.has(command.type) && engine.validate(state, { kind: 'command', seat, command }).ok
      );
    },
    ofType(type) {
      return commands.filter((command) => command.type === type);
    },
  };
  return context;
}
