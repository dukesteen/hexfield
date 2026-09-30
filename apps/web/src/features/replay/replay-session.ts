import { fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import { engineForConfig, failure, success } from '@cp2p/engine';
import type {
  CommandShape,
  Engine,
  GameConfig,
  GameEvent,
  GameState,
  Input,
  LegalCommandSet,
  Pending,
  PrivateInputData,
  PrivateState,
  Result,
  Seat,
} from '@cp2p/engine';
import type { GameSession, SessionTimer, SessionUpdate, Unsubscribe } from '../../session';
import { ReplayAnalyser } from './replay-analysis.js';
import type { ReplayTimeline, ReplayStats } from './replay-analysis.js';

/** Inputs between stored states; seeking replays at most this many minus one. */
export const CHECKPOINT_INTERVAL = 50;

export type ReplayPerspective =
  | { readonly kind: 'public' }
  | { readonly kind: 'omniscient' }
  | { readonly kind: 'seat'; readonly seat: Seat };

/** Everything a replay needs; the caller has already verified where it came from. */
export interface ReplayTranscript<Document = unknown> {
  readonly config: GameConfig;
  readonly genesisSeed: string;
  readonly inputs: readonly Input[];
  /**
   * Null when only public information exists (an unaudited online game). Otherwise every
   * private state can be rebuilt: local inputs carry their own identities, and an audited
   * online game supplies each input's private data (by input index, sparse).
   */
  readonly privateData: readonly (Partial<Record<Seat, PrivateInputData>> | null)[] | null;
  /** Returned by `exportSave`, so the viewer can download what it opened. */
  readonly document: Document;
}

interface Checkpoint {
  readonly state: GameState;
  readonly privates: ReadonlyMap<Seat, PrivateState> | null;
}

const EMPTY_LEGAL: LegalCommandSet = { commands: [], templates: [] };

/**
 * Hand bounds narrowed by local omniscience (a local steal names its card) must not reach a
 * public or single-seat view: keep only each hand's public size.
 */
export function concealHands(state: GameState): GameState {
  return {
    ...state,
    seats: state.seats.map((seat) => {
      const { total } = seat.resources;
      const min = { ...seat.resources.min };
      const max = { ...seat.resources.max };
      for (const kind of Object.keys(max)) {
        Reflect.set(min, kind, 0);
        Reflect.set(max, kind, total);
      }
      return { ...seat, resources: { total, min, max } };
    }),
  };
}

/**
 * A read-only session over a finished or partial game. States are precomputed every
 * `CHECKPOINT_INTERVAL` inputs, so a seek replays a short suffix only.
 */
export class ReplaySession<Document = unknown> implements GameSession<Document> {
  readonly mode = 'replay' as const;
  readonly timeline: ReplayTimeline;
  readonly stats: ReplayStats;
  /** Hash of the full engine state after the last input, to check against its source. */
  readonly finalStateHash: string;
  private readonly listeners = new Set<(update: SessionUpdate) => void>();
  private cursor: number;
  private state: GameState;
  private privates: ReadonlyMap<Seat, PrivateState> | null;
  private view: ReplayPerspective = { kind: 'public' };
  private revision = 0;
  private disposed = false;

  private constructor(
    private readonly engine: Engine,
    private readonly transcript: ReplayTranscript<Document>,
    private readonly checkpoints: readonly Checkpoint[],
    private readonly events: readonly GameEvent[],
    /** `eventOffsets[p]` is the number of events emitted by the first `p` inputs. */
    private readonly eventOffsets: readonly number[],
    analysis: { timeline: ReplayTimeline; stats: ReplayStats },
    final: Checkpoint,
  ) {
    this.timeline = analysis.timeline;
    this.stats = analysis.stats;
    this.cursor = transcript.inputs.length;
    this.state = final.state;
    this.privates = final.privates;
    this.finalStateHash = toHex(hashValue(final.state));
  }

  /** Replays the whole transcript once; any rejected input rejects the replay. */
  static create<Document>(transcript: ReplayTranscript<Document>): Result<ReplaySession<Document>> {
    try {
      const { config, inputs, privateData } = transcript;
      if (privateData && privateData.length > inputs.length)
        return failure('replay-private-data', 'Replay private data exceeds its inputs');
      const engine = engineForConfig(config);
      let state = engine.createGame(config, fromBase64Url(transcript.genesisSeed));
      let privates: ReadonlyMap<Seat, PrivateState> | null = privateData
        ? new Map(config.seats.map((seat) => [seat, engine.createPrivateState(seat, config)]))
        : null;
      const checkpoints: Checkpoint[] = [{ state, privates }];
      const events: GameEvent[] = [];
      const eventOffsets = [0];
      const analyser = new ReplayAnalyser(state);
      for (const [index, input] of inputs.entries()) {
        const applied = engine.apply(state, input);
        if (!applied.ok)
          return failure('replay-input', `Replay input ${index} was rejected`, {
            index,
            code: applied.error.code,
          });
        if (privates) {
          const next = engine.applyAllPrivates(
            privates,
            state,
            input,
            privateData?.[index] ?? undefined,
          );
          if (!next.ok)
            return failure('replay-private', `Replay private input ${index} was rejected`, {
              index,
              code: next.error.code,
            });
          privates = next.value;
        }
        analyser.step(state, applied.value, index + 1);
        state = applied.value.state;
        events.push(...applied.value.events);
        eventOffsets.push(events.length);
        if ((index + 1) % CHECKPOINT_INTERVAL === 0) checkpoints.push({ state, privates });
      }
      return success(
        new ReplaySession(
          engine,
          transcript,
          checkpoints,
          events,
          eventOffsets,
          analyser.finish(state),
          { state, privates },
        ),
      );
    } catch {
      return failure('replay-failed', 'The replay could not be rebuilt');
    }
  }

  /** The number of inputs in the game. */
  get length(): number {
    return this.transcript.inputs.length;
  }

  /** How many inputs have been applied to the shown state. */
  get position(): number {
    return this.cursor;
  }

  /** Whether every hand can be shown: a local game or an audited online one. */
  get fullInformation(): boolean {
    return this.transcript.privateData !== null;
  }

  get perspective(): ReplayPerspective {
    return this.view;
  }

  /** Public is always allowed; the others need full information. */
  setPerspective(perspective: ReplayPerspective): Result<void> {
    if (perspective.kind !== 'public' && !this.fullInformation)
      return failure('replay-perspective', 'This replay has no private information');
    if (perspective.kind === 'seat' && !this.transcript.config.seats.includes(perspective.seat))
      return failure('replay-perspective', 'That seat is not in this game');
    this.view = perspective;
    this.emit();
    return success(undefined);
  }

  /** Show the state after `position` inputs (clamped to the game). */
  seek(position: number): void {
    const target = Math.max(0, Math.min(this.length, Math.trunc(position)));
    if (target === this.cursor) return;
    let state: GameState;
    let privates: ReadonlyMap<Seat, PrivateState> | null;
    let from: number;
    if (target > this.cursor && target - this.cursor < CHECKPOINT_INTERVAL) {
      ({ state, privates } = this);
      from = this.cursor;
    } else {
      const checkpoint = this.checkpoints[Math.floor(target / CHECKPOINT_INTERVAL)];
      if (!checkpoint) throw new Error('Replay checkpoint is missing');
      ({ state, privates } = checkpoint);
      from = Math.floor(target / CHECKPOINT_INTERVAL) * CHECKPOINT_INTERVAL;
    }
    for (let index = from; index < target; index += 1) {
      const input = this.transcript.inputs[index];
      if (!input) throw new Error('Replay input is missing');
      const applied = this.engine.apply(state, input);
      if (!applied.ok) throw new Error('A verified replay input was rejected');
      if (privates) {
        const next = this.engine.applyAllPrivates(
          privates,
          state,
          input,
          this.transcript.privateData?.[index] ?? undefined,
        );
        if (!next.ok) throw new Error('A verified replay private input was rejected');
        privates = next.value;
      }
      state = applied.value.state;
    }
    this.state = state;
    this.privates = privates;
    this.cursor = target;
    this.emit();
  }

  step(delta: number): void {
    this.seek(this.cursor + delta);
  }

  /** Engine state; hands are reduced to their size unless the view is omniscient. */
  getState(): GameState {
    return this.view.kind === 'omniscient' ? this.state : concealHands(this.state);
  }

  /** A seat's hand, only when the perspective shows it. */
  getPrivate(seat: Seat): PrivateState | null {
    if (!this.privates) return null;
    if (this.view.kind === 'public') return null;
    if (this.view.kind === 'seat' && this.view.seat !== seat) return null;
    return this.privates.get(seat) ?? null;
  }

  getPending(): readonly Pending[] {
    return this.engine.getPending(this.state);
  }

  getTimers(): readonly SessionTimer[] {
    return [];
  }

  getLegalCommands(_seat: Seat): LegalCommandSet {
    return EMPTY_LEGAL;
  }

  validate(_seat: Seat, _command: CommandShape): Result<void> {
    return failure('replay-read-only', 'A replay cannot be played');
  }

  /** Events emitted by the inputs applied so far. */
  getEvents(): readonly GameEvent[] {
    return this.events.slice(0, this.eventOffsets[this.cursor] ?? 0);
  }

  /** Events emitted by the input that led to `position`. */
  eventsAt(position: number): readonly GameEvent[] {
    if (position < 1 || position > this.length) return [];
    return this.events.slice(this.eventOffsets[position - 1], this.eventOffsets[position]);
  }

  controllableSeats(): Seat[] {
    return [];
  }

  async submit(): Promise<Result<void>> {
    return failure('replay-read-only', 'A replay cannot be played');
  }

  subscribe(listener: (update: SessionUpdate) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.update([]));
    return () => this.listeners.delete(listener);
  }

  exportSave(): Document {
    return this.transcript.document;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private update(events: readonly GameEvent[]): SessionUpdate {
    return {
      revision: this.revision,
      state: this.getState(),
      events,
      pending: this.getPending(),
      timers: [],
      status: this.state.result ? { kind: 'complete' } : { kind: 'running' },
    };
  }

  private emit(): void {
    if (this.disposed) return;
    this.revision += 1;
    const update = this.update(this.eventsAt(this.cursor));
    for (const listener of this.listeners) listener(update);
  }
}
