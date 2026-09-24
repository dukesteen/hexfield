import type { GameEvent } from '../events/index.js';
import { cloneJson } from '../state/json.js';
import type { GameConfig, GameState, PrivateState } from '../state/types.js';
import { RESOURCES, failure, success } from '../types/index.js';
import type { Result, Seat } from '../types/index.js';
import type { Engine } from './engine.js';
import type { Input, Pending, PrivateInputData, SystemInput } from './types.js';

type SystemPending = Extract<Pending, { kind: 'random' | 'reveal' }>;

export interface LocalRandomAnswer {
  input: SystemInput;
  privateData?: Partial<Record<Seat, PrivateInputData>>;
}

/** Supplies random and reveal inputs outside the pure engine. The source may own secret decks. */
export interface LocalRandomSource {
  resolve(
    pending: SystemPending,
    state: Readonly<GameState>,
    privates: ReadonlyMap<Seat, PrivateState>,
  ): LocalRandomAnswer;
}

export interface LocalStep {
  state: Readonly<GameState>;
  inputs: readonly Input[];
  events: readonly GameEvent[];
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function checkTrueHands(state: GameState, privates: ReadonlyMap<Seat, PrivateState>): Result<void> {
  for (const seat of state.seats) {
    const privateState = privates.get(seat.seat);
    if (!privateState)
      return failure('missing-private-state', `Missing private state for seat ${seat.seat}`);
    let total = 0;
    for (const resource of RESOURCES) {
      const count = privateState.hand[resource];
      const min = seat.resources.min[resource];
      const max = seat.resources.max[resource];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < min || count > max) {
        return failure(
          'private-hand-outside-bounds',
          `Seat ${seat.seat} ${resource} is outside public bounds`,
        );
      }
      total += count;
    }
    if (total !== seat.resources.total) {
      return failure(
        'private-hand-total-mismatch',
        `Seat ${seat.seat} hand total differs from public total`,
      );
    }
  }
  return success(undefined);
}

/** Omniscient local driver. Every generated input is recorded for replay. */
export class LocalGame {
  private current: GameState;
  private privateBySeat: Map<Seat, PrivateState>;
  private readonly entries: Input[] = [];
  private readonly emitted: GameEvent[] = [];
  private terminalError: string | null = null;

  private constructor(
    private readonly engine: Engine,
    config: GameConfig,
    genesisSeed: Uint8Array,
    private readonly randomSource: LocalRandomSource,
  ) {
    this.current = freezeTree(engine.createGame(config, genesisSeed));
    this.privateBySeat = new Map(
      this.current.config.seats.map((seat) => [seat, freezeTree(engine.createPrivateState(seat))]),
    );
  }

  static create(
    engine: Engine,
    config: GameConfig,
    genesisSeed: Uint8Array,
    randomSource: LocalRandomSource,
  ): Result<LocalGame> {
    try {
      const game = new LocalGame(engine, config, genesisSeed, randomSource);
      const initialized = game.run();
      return initialized.ok ? success(game) : initialized;
    } catch (error) {
      return failure('genesis-failed', String(error));
    }
  }

  /** Deeply frozen borrowed view for simulation; call snapshot() for an owned copy. */
  get state(): Readonly<GameState> {
    return this.current;
  }

  /** Copy of the replay log with deeply frozen input records. */
  get log(): readonly Input[] {
    return this.entries.slice();
  }

  /** Copy of the event history with deeply frozen event records. */
  get events(): readonly GameEvent[] {
    return this.emitted.slice();
  }

  /** Return an owned copy of the current public state. */
  snapshot(): GameState {
    return cloneJson(this.current);
  }

  /** Return an owned copy of one seat's secret state. */
  privateState(seat: Seat): PrivateState | undefined {
    const value = this.privateBySeat.get(seat);
    return value ? cloneJson(value) : undefined;
  }

  getPending(): Pending[] {
    return this.engine.getPending(this.current);
  }

  /** Commit the input and all generated inputs as one batch. Source failure is terminal after rollback. */
  submit(input: Input, privateData?: Partial<Record<Seat, PrivateInputData>>): Result<LocalStep> {
    if (this.terminalError) return failure('driver-terminal', this.terminalError);
    return this.run(input, privateData);
  }

  private run(
    initial?: Input,
    initialPrivateData?: Partial<Record<Seat, PrivateInputData>>,
  ): Result<LocalStep> {
    let state = this.current;
    let privates = new Map(this.privateBySeat);
    const inputs: Input[] = [];
    const events: GameEvent[] = [];
    try {
      const initialBounds = checkTrueHands(state, privates);
      if (!initialBounds.ok) return initialBounds;
      const applyOne = (
        input: Input,
        privateData?: Partial<Record<Seat, PrivateInputData>>,
      ): Result<void> => {
        const before = state;
        const applied = this.engine.apply(before, input);
        if (!applied.ok) return applied;
        const nextPrivates = new Map<Seat, PrivateState>();
        for (const seat of before.config.seats) {
          const previous = privates.get(seat);
          if (!previous)
            return failure('missing-private-state', `Missing private state for seat ${seat}`);
          const next = this.engine.applyPrivate(previous, before, input, privateData?.[seat]);
          if (!next.ok) return next;
          if (next.value.seat !== seat)
            return failure(
              'private-seat-changed',
              `Private state for seat ${seat} changed ownership`,
            );
          nextPrivates.set(seat, freezeTree(next.value));
        }
        const checked = checkTrueHands(applied.value.state, nextPrivates);
        if (!checked.ok) return checked;
        state = freezeTree(applied.value.state);
        privates = nextPrivates;
        inputs.push(freezeTree(cloneJson(input)));
        events.push(...applied.value.events.map((event) => freezeTree(cloneJson(event))));
        return success(undefined);
      };

      if (initial) {
        const applied = applyOne(initial, initialPrivateData);
        if (!applied.ok) return applied;
      }
      let settled = false;
      for (let step = 0; step < 10_000; step++) {
        if (state.result) {
          settled = true;
          break;
        }
        const automatic = this.engine.getAutomaticInput(state, new Map(privates));
        if (automatic) {
          const applied = applyOne(automatic);
          if (!applied.ok) return this.terminate(applied);
          continue;
        }
        const system = this.engine
          .getPending(state)
          .find((item) => item.kind === 'random' || item.kind === 'reveal');
        if (system?.kind === 'random' || system?.kind === 'reveal') {
          let answer: LocalRandomAnswer;
          try {
            answer = this.randomSource.resolve(system, state, new Map(privates));
          } catch (error) {
            return this.terminate(failure('system-source-error', String(error)));
          }
          const applied = applyOne(answer.input, answer.privateData);
          if (!applied.ok) return this.terminate(applied);
          continue;
        }
        settled = true;
        break;
      }
      if (!settled)
        return this.terminate(failure('automatic-input-loop', 'Automatic inputs did not settle'));
      this.current = state;
      this.privateBySeat = privates;
      this.entries.push(...inputs);
      this.emitted.push(...events);
      return success({ state, inputs, events });
    } catch (error) {
      return this.terminate(failure('driver-error', String(error)));
    }
  }

  private terminate<T>(result: Result<T>): Result<T> {
    if (!result.ok) this.terminalError = `${result.error.code}: ${result.error.message}`;
    return result;
  }
}
