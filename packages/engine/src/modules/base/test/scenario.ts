import type { GameConfig } from '../../../core/state/types.js';
import type { CommandShape, Input } from '../../../core/pipeline/types.js';
import type { Engine, LocalRandomAnswer, LocalRandomSource } from '../../../core/pipeline/index.js';
import { LocalGame } from '../../../core/pipeline/index.js';
import type { Seat, Result } from '../../../core/types/index.js';
import type { GameState } from '../../../core/state/types.js';

export interface SetupPlacement {
  settlement: string;
  road: string;
}

type Step = (game: LocalGame, engine: Engine) => Result<unknown>;
type SettlementChooser = (
  state: Readonly<GameState>,
  seat: Seat,
  index: number,
  legalVertices: readonly string[],
) => string;
type ScenarioScript = (game: LocalGame, engine: Engine) => Result<unknown>;

/** Fluent, deterministic harness for replaying base-game scenarios through LocalGame. */
export class BaseScenario {
  private genesisSeed = new Uint8Array(32);
  private readonly steps: Step[] = [];
  private readonly randomAnswers: LocalRandomAnswer[] = [];

  constructor(
    private readonly engine: Engine,
    private readonly config: GameConfig,
    private readonly fallbackRandom: LocalRandomSource,
  ) {}

  /** Set the genesis seed used by board setup. */
  seed(value: Uint8Array): this {
    this.genesisSeed = value.slice();
    return this;
  }

  /** Add setup settlement-road pairs, or choose each settlement from currently legal vertices. */
  setup(placements?: readonly SetupPlacement[] | SettlementChooser): this {
    this.steps.push((game, engine) => {
      const fixed = Array.isArray(placements) ? placements : undefined;
      const chooseSettlement = typeof placements === 'function' ? placements : undefined;
      const limit = fixed?.length ?? this.config.seats.length * 2;
      for (let index = 0; index < limit; index += 1) {
        const settlement = game.getPending().find((item) => item.kind === 'player');
        if (settlement?.kind !== 'player' || !settlement.allowed.includes('PLACE_SETTLEMENT')) {
          if (!fixed) return { ok: true, value: undefined };
          return {
            ok: false,
            error: { code: 'scenario-phase', message: 'Settlement setup is not pending.' },
          };
        }
        const settlementChoices = engine
          .getLegalCommands(game.snapshot(), settlement.seat)
          .commands.filter((item) => item.type === 'PLACE_SETTLEMENT')
          .flatMap((item) => (typeof item.vertex === 'string' ? [item.vertex] : []));
        const vertex =
          fixed?.[index]?.settlement ??
          chooseSettlement?.(game.state, settlement.seat, index, settlementChoices) ??
          settlementChoices[0];
        if (!vertex) {
          return {
            ok: false,
            error: { code: 'scenario-setup', message: 'No legal setup settlement was available.' },
          };
        }
        const placed = game.submit(command(settlement.seat, 'PLACE_SETTLEMENT', { vertex }));
        if (!placed.ok) return placed;

        const road = game.getPending().find((item) => item.kind === 'player');
        if (road?.kind !== 'player' || !road.allowed.includes('PLACE_ROAD')) {
          return {
            ok: false,
            error: { code: 'scenario-phase', message: 'Road setup is not pending.' },
          };
        }
        const roadChoices = engine
          .getLegalCommands(game.snapshot(), road.seat)
          .commands.filter((item) => item.type === 'PLACE_ROAD')
          .flatMap((item) => (typeof item.edge === 'string' ? [item.edge] : []));
        const edge = fixed?.[index]?.road ?? roadChoices[0];
        if (!edge) {
          return {
            ok: false,
            error: { code: 'scenario-setup', message: 'No legal setup road was available.' },
          };
        }
        const connected = game.submit(command(road.seat, 'PLACE_ROAD', { edge }));
        if (!connected.ok) return connected;
      }
      return { ok: true, value: undefined };
    });
    return this;
  }

  /** Queue the local answer consumed by the next matching random/reveal request. */
  answer(answer: LocalRandomAnswer): this {
    this.randomAnswers.push(answer);
    return this;
  }

  /** Roll by submitting ROLL_DICE and answering its external dice request. */
  roll(first: number, second: number, seat?: Seat): this {
    this.steps.push((game) => {
      const activeSeat = seat ?? game.state.turn.activeSeat;
      this.randomAnswers.push({
        input: { kind: 'system', type: 'DICE_RESULT', dice: [first, second] },
      });
      return game.submit(command(activeSeat, 'ROLL_DICE'));
    });
    return this;
  }

  /** Submit a command for an explicit seat. */
  command(seat: Seat, value: CommandShape): this {
    this.steps.push((game) => game.submit({ kind: 'command', seat, command: value }));
    return this;
  }

  /** Build at a board location using the matching base-game command. */
  build(kind: 'road' | 'settlement' | 'city', location: string, seat?: Seat): this {
    const key = kind === 'road' ? 'edge' : 'vertex';
    const type = `BUILD_${kind.toUpperCase()}`;
    this.steps.push((game) =>
      game.submit(command(seat ?? game.state.turn.activeSeat, type, { [key]: location })),
    );
    return this;
  }

  /** Run an adaptive scripted sequence against the live state. */
  script(run: ScenarioScript): this {
    this.steps.push(run);
    return this;
  }

  /** Resolve genesis, run the recorded steps, and return the final LocalGame. */
  run(): Result<LocalGame> {
    const answers = this.randomAnswers;
    const queuedSource: LocalRandomSource = {
      resolve: (pending, state, privates) => {
        const answerIndex = answers.findIndex((answer) => answer.input.type === pending.systemType);
        if (answerIndex !== -1) {
          const answer = answers[answerIndex];
          if (!answer) throw new Error('Missing queued random answer');
          answers.splice(answerIndex, 1);
          return answer;
        }
        if (pending.kind === 'random' && pending.systemType === 'START_SEAT') {
          return {
            input: { kind: 'system', type: 'START_SEAT', seat: this.config.seats[0] ?? 0 },
          };
        }
        return this.fallbackRandom.resolve(pending, state, privates);
      },
    };
    const created = LocalGame.create(this.engine, this.config, this.genesisSeed, queuedSource);
    if (!created.ok) return created;
    for (const step of this.steps) {
      const result = step(created.value, this.engine);
      if (!result.ok) return result;
    }
    return created;
  }
}

/** Start a fluent LocalGame scenario for a configured engine and deterministic source. */
export function scenario(
  engine: Engine,
  config: GameConfig,
  random: LocalRandomSource,
): BaseScenario {
  return new BaseScenario(engine, config, random);
}

function command(seat: Seat, type: string, args: Record<string, unknown> = {}): Input {
  return { kind: 'command', seat, command: { type, ...args } };
}
