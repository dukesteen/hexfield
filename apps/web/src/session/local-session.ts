import { createBotRng, RandomBot } from '@cp2p/bots';
import type { BotRng } from '@cp2p/bots';
import { fromBase64Url, toBase64Url } from '@cp2p/codec';
import { createBaseEngine, ENGINE_VERSION, failure, LocalGame, success } from '@cp2p/engine';
import type {
  CommandShape,
  Engine,
  GameConfig,
  GameEvent,
  GameState,
  Input,
  LegalCommandSet,
  Pending,
  PrivateState,
  Result,
  Seat,
} from '@cp2p/engine';
import { browserEntropy, createBrowserRandomSource, randomIndex, randomSeed } from './random.js';
import type { BrowserRandomSource, Entropy } from './random.js';
import { chooseBotPending, timerKey } from './scheduling.js';
import { owned, parseSave, ReplayRandomSource, sameCanonical, stateHash } from './save.js';
import type {
  GameSession,
  LocalSaveBatch,
  LocalSessionSave,
  SessionScheduler,
  SessionStatus,
  SessionTimer,
  SessionUpdate,
  SubmitOptions,
  Unsubscribe,
} from './types.js';

export interface LocalSessionRuntime {
  entropy?: Entropy;
  scheduler?: SessionScheduler;
  /** Use zero only for deterministic tests; normal bots wait 300–800 ms. */
  botDelayMs?: number | { min: number; max: number };
}

export interface LocalSessionCreate extends LocalSessionRuntime {
  config: GameConfig;
  humanSeats: readonly Seat[];
  botSeats: readonly Seat[];
  genesisSeed?: Uint8Array;
}

const wallClock: SessionScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => {
    if (typeof handle === 'number') globalThis.clearTimeout(handle);
  },
};

interface TimerRecord {
  key: string;
  seat: Seat;
  phase: string;
  remainingMs: number;
  expiresAt: number | null;
  handle: unknown;
}

function roleSeats(config: GameConfig, humans: readonly Seat[], bots: readonly Seat[]): void {
  const given = [...humans, ...bots];
  if (
    given.length !== config.seats.length ||
    new Set(given).size !== given.length ||
    config.seats.some((seat) => !given.includes(seat))
  )
    throw new Error('Every game seat needs exactly one human or bot role');
}

function botDelay(value: LocalSessionRuntime['botDelayMs']): { min: number; max: number } {
  const range =
    typeof value === 'number' ? { min: value, max: value } : (value ?? { min: 300, max: 800 });
  if (
    !Number.isSafeInteger(range.min) ||
    !Number.isSafeInteger(range.max) ||
    range.min < 0 ||
    range.max < range.min
  )
    throw new Error('Bot delay must be a nonnegative millisecond range');
  return range;
}

/** Browser-local game authority. Public updates contain no other seat's secret state. */
export class LocalSession implements GameSession<LocalSessionSave> {
  readonly mode = 'local' as const;
  private readonly engine: Engine;
  private readonly bots = new Map<Seat, { bot: RandomBot; rng: BotRng }>();
  private readonly listeners = new Set<(update: SessionUpdate) => void>();
  private readonly notifications: SessionUpdate[] = [];
  private readonly timers = new Map<string, TimerRecord>();
  private readonly batches: LocalSaveBatch[] = [];
  private readonly scheduler: SessionScheduler;
  private readonly entropy: Entropy;
  private readonly delay: { min: number; max: number };
  private readonly humans: Set<Seat>;
  private readonly botSeats: Set<Seat>;
  private readonly genesis: Input[];
  private readonly config: GameConfig;
  private readonly seed: Uint8Array;
  private readonly source: BrowserRandomSource;
  private status: SessionStatus = { kind: 'running' };
  private paused = false;
  private delivering = false;
  private botHandle: unknown = null;
  private botRevision = -1;

  private constructor(
    private readonly game: LocalGame,
    engine: Engine,
    source: BrowserRandomSource,
    config: GameConfig,
    seed: Uint8Array,
    humans: readonly Seat[],
    botSeats: readonly Seat[],
    genesis: readonly Input[],
    runtime: LocalSessionRuntime,
  ) {
    this.engine = engine;
    this.source = source;
    this.config = owned(config);
    this.seed = seed.slice();
    this.humans = new Set(humans);
    this.botSeats = new Set(botSeats);
    this.genesis = owned([...genesis]);
    this.entropy = runtime.entropy ?? browserEntropy;
    this.scheduler = runtime.scheduler ?? wallClock;
    this.delay = botDelay(runtime.botDelayMs);
    for (const seat of botSeats)
      this.bots.set(seat, {
        bot: new RandomBot(engine),
        rng: createBotRng(randomSeed(this.entropy)),
      });
    if (game.state.result) this.status = { kind: 'complete' };
  }

  static create(options: LocalSessionCreate): Result<LocalSession> {
    try {
      roleSeats(options.config, options.humanSeats, options.botSeats);
      const engine = createBaseEngine();
      const entropy = options.entropy ?? browserEntropy;
      const seed = options.genesisSeed?.slice() ?? randomSeed(entropy);
      if (seed.length !== 32) throw new Error('Genesis seed must be 32 bytes');
      const source = createBrowserRandomSource(entropy);
      const made = LocalGame.create(engine, options.config, seed, source);
      if (!made.ok) return made;
      const session = new LocalSession(
        made.value,
        engine,
        source,
        made.value.state.config,
        seed,
        options.humanSeats,
        options.botSeats,
        made.value.log,
        options,
      );
      session.reconcile();
      return success(session);
    } catch (error) {
      return failure('local-session-create', String(error));
    }
  }

  /** Validate an untrusted save by replaying its batches and comparing the full log and hash. */
  static restore(raw: unknown, runtime: LocalSessionRuntime = {}): Result<LocalSession> {
    try {
      const save = parseSave(raw);
      if (save.engineVersion !== ENGINE_VERSION) throw new Error('Save engine version differs');
      roleSeats(save.config, save.roles.humanSeats, save.roles.botSeats);
      const engine = createBaseEngine();
      const source = createBrowserRandomSource(runtime.entropy ?? browserEntropy);
      const replay = new ReplayRandomSource(source);
      replay.begin(save.genesis);
      const seed = fromBase64Url(save.genesisSeed);
      const made = LocalGame.create(engine, save.config, seed, replay);
      if (!made.ok) throw new Error(`${made.error.code}: ${made.error.message}`);
      replay.end();
      if (!sameCanonical(made.value.log, save.genesis))
        throw new Error('Saved genesis differs from replay');
      for (const batch of save.batches) {
        if (
          batch.submitted.kind !== 'command' &&
          !(batch.submitted.kind === 'system' && batch.submitted.type === 'TIMEOUT')
        )
          throw new Error('Saved batch has an invalid submitted input');
        replay.begin(batch.generated);
        const valid = engine.validate(made.value.state, batch.submitted);
        if (!valid.ok) throw new Error(`${valid.error.code}: ${valid.error.message}`);
        const step = made.value.submit(batch.submitted);
        if (!step.ok) throw new Error(`${step.error.code}: ${step.error.message}`);
        replay.end();
        if (!sameCanonical(step.value.inputs, [batch.submitted, ...batch.generated]))
          throw new Error('Saved generated inputs differ from replay');
      }
      const flattened = [
        ...save.genesis,
        ...save.batches.flatMap((batch) => [batch.submitted, ...batch.generated]),
      ];
      if (!sameCanonical(made.value.log, flattened))
        throw new Error('Saved input log differs from replay');
      if (stateHash(made.value.state) !== save.finalHash)
        throw new Error('Saved final hash differs');
      replay.goLive();
      const session = new LocalSession(
        made.value,
        engine,
        source,
        made.value.state.config,
        seed,
        save.roles.humanSeats,
        save.roles.botSeats,
        save.genesis,
        runtime,
      );
      session.batches.push(...owned(save.batches));
      session.reconcile();
      return success(session);
    } catch (error) {
      return failure('local-session-restore', String(error));
    }
  }

  getState(): GameState {
    return this.game.state;
  }
  getPrivate(seat: Seat): PrivateState | null {
    return this.status.kind === 'disposed' ? null : (this.game.privateState(seat) ?? null);
  }
  getPending(): readonly Pending[] {
    return this.status.kind === 'disposed' ? [] : this.game.getPending();
  }
  getEvents(): readonly GameEvent[] {
    return this.game.events;
  }
  controllableSeats(): Seat[] {
    return [...this.humans].toSorted((a, b) => a - b);
  }
  getLegalCommands(seat: Seat): LegalCommandSet {
    if (this.status.kind !== 'running' || !this.humans.has(seat))
      return { commands: [], templates: [] };
    return this.engine.getLegalCommands(this.game.state, seat, this.game.privateView(seat));
  }
  validate(seat: Seat, command: CommandShape): Result<void> {
    if (this.paused) return failure('session-paused', 'Local game is paused');
    if (this.status.kind !== 'running')
      return failure('session-inactive', 'Local session is not running');
    if (!this.humans.has(seat))
      return failure('seat-not-controllable', 'This seat is not human-controlled');
    return this.engine.validate(this.game.state, { kind: 'command', seat, command });
  }

  async submit(
    seat: Seat,
    command: CommandShape,
    options: SubmitOptions = {},
  ): Promise<Result<void>> {
    if (this.paused) return failure('session-paused', 'Local game is paused');
    if (options.expectedRevision !== undefined && options.expectedRevision !== this.game.log.length)
      return failure('stale-revision', 'The game changed before this command');
    const valid = this.validate(seat, command);
    if (!valid.ok) return valid;
    return this.accept({ kind: 'command', seat, command });
  }

  /** Development-only one-shot dice control; balanced mode remains untouched. */
  forceDice(dice: readonly [number, number]): Result<void> {
    if (!import.meta.env.DEV) return failure('unavailable', 'Dice control is development-only');
    if (this.status.kind !== 'running')
      return failure('session-inactive', 'Local session is not running');
    const base = this.game.state.config.options.base;
    if (typeof base === 'object' && base !== null && Reflect.get(base, 'diceMode') === 'balanced')
      return failure('balanced-dice', 'Balanced dice cannot be forced');
    try {
      this.source.forceNextDice(dice);
      return success(undefined);
    } catch (error) {
      return failure('invalid-dice', String(error));
    }
  }

  subscribe(listener: (update: SessionUpdate) => void): Unsubscribe {
    if (this.status.kind === 'disposed') return () => {};
    this.listeners.add(listener);
    listener(this.update([]));
    return () => {
      this.listeners.delete(listener);
    };
  }

  exportSave(): LocalSessionSave {
    if (this.status.kind === 'disposed') throw new Error('Disposed sessions cannot be saved');
    return owned({
      v: 1,
      mode: 'local',
      engineVersion: ENGINE_VERSION,
      config: this.config,
      genesisSeed: toBase64Url(this.seed),
      roles: {
        humanSeats: this.controllableSeats(),
        botSeats: [...this.botSeats].toSorted((a, b) => a - b),
      },
      genesis: this.genesis,
      batches: this.batches,
      finalHash: stateHash(this.game.state),
    } satisfies LocalSessionSave);
  }

  getTimers(): readonly SessionTimer[] {
    const now = this.scheduler.now();
    return [...this.timers.values()].map((timer) => ({
      key: timer.key,
      seat: timer.seat,
      phase: timer.phase,
      remainingMs:
        timer.expiresAt === null ? timer.remainingMs : Math.max(0, timer.expiresAt - now),
      expiresAt: timer.expiresAt,
      paused: timer.expiresAt === null,
    }));
  }

  setPaused(paused: boolean): void {
    if (this.status.kind !== 'running' || this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      for (const timer of this.timers.values()) this.pauseTimer(timer);
      this.cancelBot();
    } else this.reconcile();
    this.emit([]);
  }

  dispose(): void {
    if (this.status.kind === 'disposed') return;
    this.status = { kind: 'disposed' };
    this.source.clearForcedDice();
    this.clearTasks();
    this.emit([]);
    this.listeners.clear();
  }

  private accept(input: Input): Result<void> {
    const step = this.game.submit(input);
    if (!step.ok) {
      this.status = { kind: 'error', message: `${step.error.code}: ${step.error.message}` };
      this.clearTasks();
      this.emit([]);
      return step;
    }
    const [submitted, ...generated] = step.value.inputs;
    if (!submitted) throw new Error('Successful local step has no input');
    this.batches.push(owned({ submitted, generated }));
    if (step.value.state.result) this.status = { kind: 'complete' };
    this.reconcile();
    this.emit(step.value.events);
    return success(undefined);
  }

  private update(events: readonly GameEvent[]): SessionUpdate {
    return {
      revision: this.game.log.length,
      state: this.game.state,
      events: [...events],
      pending: this.getPending(),
      timers: this.getTimers(),
      status: { ...this.status },
    };
  }

  private emit(events: readonly GameEvent[]): void {
    this.notifications.push(this.update(events));
    if (this.delivering) return;
    this.delivering = true;
    try {
      while (this.notifications.length) {
        const update = this.notifications.shift();
        if (!update) break;
        for (const listener of Array.from(this.listeners))
          if (this.listeners.has(listener)) listener(update);
      }
    } finally {
      this.delivering = false;
    }
  }

  private clearTasks(): void {
    for (const timer of this.timers.values())
      if (timer.handle !== null) this.scheduler.clearTimeout(timer.handle);
    this.timers.clear();
    this.cancelBot();
  }

  private pauseTimer(timer: TimerRecord): void {
    if (timer.expiresAt === null) return;
    timer.remainingMs = Math.max(0, timer.expiresAt - this.scheduler.now());
    if (timer.handle !== null) this.scheduler.clearTimeout(timer.handle);
    timer.handle = null;
    timer.expiresAt = null;
  }

  private startTimer(timer: TimerRecord): void {
    if (timer.expiresAt !== null || this.paused || this.status.kind !== 'running') return;
    timer.expiresAt = this.scheduler.now() + timer.remainingMs;
    timer.handle = this.scheduler.setTimeout(() => {
      timer.handle = null;
      const current = this.game
        .getPending()
        .find(
          (item) =>
            item.kind === 'player' &&
            item.seat === timer.seat &&
            timerKey(this.game.state, item) === timer.key,
        );
      if (this.status.kind !== 'running' || this.paused || !current || current.kind !== 'player')
        return;
      const phase = this.game.state.turn.phase.at(-1)?.id;
      if (!phase) return;
      const input: Input = { kind: 'system', type: 'TIMEOUT', seat: timer.seat, phase };
      const valid = this.engine.validate(this.game.state, input);
      if (valid.ok) this.accept(input);
      else this.fail(`Timer produced ${valid.error.code}: ${valid.error.message}`);
    }, timer.remainingMs);
  }

  private reconcile(): void {
    if (this.status.kind !== 'running') {
      this.clearTasks();
      return;
    }
    const state = this.game.state;
    const pending = this.game.getPending();
    const current = new Map<string, Extract<Pending, { kind: 'player' }>>();
    for (const item of pending)
      if (item.kind === 'player') {
        const key = timerKey(state, item);
        if (key && item.deadline) current.set(key, item);
      }
    for (const [key, timer] of this.timers) {
      if (!current.has(key)) {
        this.pauseTimer(timer);
        const [turn, seat, stack] = key.split('|');
        const nested =
          state.turn.number === Number(turn) &&
          seat === String(state.turn.activeSeat) &&
          !!stack &&
          this.game.state.turn.phase.length > stack.split('>').length &&
          this.game.state.turn.phase
            .slice(0, stack.split('>').length)
            .map((frame) => `${frame.module}/${frame.id}`)
            .join('>') === stack;
        if (!nested) this.timers.delete(key);
      }
    }
    for (const [key, item] of current) {
      let timer = this.timers.get(key);
      if (!timer && item.deadline) {
        timer = {
          key,
          seat: item.seat,
          phase: item.deadline.phase,
          remainingMs: item.deadline.seconds * 1000,
          expiresAt: null,
          handle: null,
        };
        this.timers.set(key, timer);
      }
      if (timer) this.startTimer(timer);
    }
    this.scheduleBot(chooseBotPending(state, pending, this.botSeats));
  }

  private cancelBot(): void {
    if (this.botHandle !== null) this.scheduler.clearTimeout(this.botHandle);
    this.botHandle = null;
    this.botRevision = -1;
  }

  private scheduleBot(pending: Extract<Pending, { kind: 'player' }> | null): void {
    if (this.paused || !pending) {
      this.cancelBot();
      return;
    }
    const revision = this.game.log.length;
    if (this.botHandle !== null && this.botRevision === revision) return;
    this.cancelBot();
    const delay = this.delay.min + randomIndex(this.entropy, this.delay.max - this.delay.min + 1);
    this.botRevision = revision;
    this.botHandle = this.scheduler.setTimeout(() => {
      this.botHandle = null;
      if (this.status.kind !== 'running' || this.paused || this.game.log.length !== revision)
        return;
      const selected = chooseBotPending(this.game.state, this.game.getPending(), this.botSeats);
      if (!selected) return;
      const actor = this.bots.get(selected.seat);
      const priv = this.game.privateView(selected.seat);
      if (!actor || !priv) {
        this.fail('Bot has no private state');
        return;
      }
      try {
        const command = actor.bot.decide(
          { state: this.game.state, seat: selected.seat, priv },
          selected,
          actor.rng,
        );
        const input: Input = { kind: 'command', seat: selected.seat, command };
        const valid = this.engine.validate(this.game.state, input);
        if (!valid.ok) {
          this.fail(`Bot produced ${valid.error.code}: ${valid.error.message}`);
          return;
        }
        this.accept(input);
      } catch (error) {
        this.fail(`Bot decision failed: ${String(error)}`);
      }
    }, delay);
  }

  private fail(message: string): void {
    this.status = { kind: 'error', message };
    this.clearTasks();
    this.emit([]);
  }
}
