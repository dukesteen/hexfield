import { failure } from '@cp2p/engine';
import type { CommandShape, Result, Seat } from '@cp2p/engine';
import type { GameSession, SessionUpdate, SubmitOptions } from '@cp2p/protocol';
import { OnlineWorkerClient } from './online-worker-client.js';
import type { OnlineWorkerHead, OnlineWorkerSessionSnapshot } from './online-worker-messages.js';

const emptyLegal = { commands: [], templates: [] };
/** Automatic re-confirmations when a background entry certifies before a player's command. */
// Each retry moves past at least one certified entry; a six-seat deck setup has 12 passes.
const RENEWED_INTENT_RETRIES = 16;
const HEAD_WAIT_STEPS = 120;
const HEAD_WAIT_MS = 25;

function sameHead(left: OnlineWorkerHead, right: OnlineWorkerHead): boolean {
  return left.seq === right.seq && left.hash === right.hash;
}

/** Display cache only. The worker owns every validation, proof and state transition. */
export class OnlineWorkerSession implements GameSession {
  readonly mode = 'p2p';
  private current: OnlineWorkerSessionSnapshot;
  private readonly listeners = new Set<(update: SessionUpdate) => void>();
  private visible = true;
  private visibilityToken = 0;
  private disposed = false;

  constructor(
    private readonly client: OnlineWorkerClient,
    snapshot: OnlineWorkerSessionSnapshot,
    private readonly onDispose: () => void,
  ) {
    this.current = this.sanitize(snapshot);
  }

  private sanitize(snapshot: OnlineWorkerSessionSnapshot): OnlineWorkerSessionSnapshot {
    if (snapshot.controllableSeats.some((seat) => seat !== snapshot.localHumanSeat))
      throw new Error('Worker exposed another seat as locally controllable');
    const showPrivate = this.visible && snapshot.visibilityToken === this.visibilityToken;
    return {
      ...snapshot,
      privateState: showPrivate ? snapshot.privateState : null,
      legal: showPrivate ? snapshot.legal : null,
    };
  }

  accept(snapshot: OnlineWorkerSessionSnapshot): void {
    if (this.disposed) return;
    if (
      snapshot.localHumanSeat !== this.current.localHumanSeat ||
      snapshot.committedHead.seq < this.current.committedHead.seq ||
      (snapshot.committedHead.seq === this.current.committedHead.seq &&
        snapshot.committedHead.hash !== this.current.committedHead.hash)
    )
      throw new Error('Worker snapshot does not belong to the current session');
    this.current = this.sanitize(snapshot);
    this.notify();
  }

  getState() {
    return this.current.update.state;
  }
  getCommittedHead() {
    return { ...this.current.committedHead };
  }
  getPrivate(seat: Seat) {
    return !this.disposed && seat === this.current.localHumanSeat
      ? this.current.privateState
      : null;
  }
  getLegalCommands(seat: Seat) {
    return !this.disposed && seat === this.current.localHumanSeat
      ? (this.current.legal ?? emptyLegal)
      : emptyLegal;
  }
  getPending() {
    return this.current.update.pending;
  }
  getTimers() {
    return this.current.update.timers;
  }
  getEvents() {
    return this.current.events;
  }
  getAudit() {
    return this.current.update.audit ?? { kind: 'not-started' as const };
  }
  getFairness() {
    return this.current.update.fairness ?? null;
  }
  getRecoveryCandidate() {
    return this.current.update.recoveryCandidate ?? null;
  }
  controllableSeats() {
    return this.disposed ? [] : [...this.current.controllableSeats];
  }

  async validate(seat: Seat, command: CommandShape): Promise<Result<void>> {
    if (this.disposed || seat !== this.current.localHumanSeat)
      return failure('session-inactive', 'This peer cannot control the requested seat');
    const head = this.getCommittedHead();
    const token = this.visibilityToken;
    const result = await this.client.request({ kind: 'validate', seat, command, head });
    if (!sameHead(head, this.current.committedHead) || token !== this.visibilityToken)
      return failure('stale-revision', 'Board changed; choose the action again');
    return result;
  }

  async submit(
    seat: Seat,
    command: CommandShape,
    options: SubmitOptions = {},
  ): Promise<Result<void>> {
    if (this.disposed || seat !== this.current.localHumanSeat)
      return failure('session-inactive', 'This peer cannot control the requested seat');
    const head = this.getCommittedHead();
    if (options.expectedRevision !== undefined && options.expectedRevision !== head.seq)
      return failure('stale-revision', 'Board changed; choose the action again');
    return this.submitAt(seat, command, head, RENEWED_INTENT_RETRIES);
  }

  /**
   * Background entries (deck-setup passes during setup) can certify before a player's command.
   * The signed command is bound to its parent, so confirm the same command against the new head
   * and send it again while it is still legal; otherwise report the change to the player.
   */
  private async submitAt(
    seat: Seat,
    command: CommandShape,
    head: OnlineWorkerHead,
    retries: number,
  ): Promise<Result<void>> {
    const result = await this.client.request({ kind: 'submit', seat, command, head });
    if (result.ok || result.error.code !== 'renewed-intent' || retries === 0 || this.disposed)
      return result;
    const next = await this.nextHead(head, HEAD_WAIT_STEPS);
    if (!next) return result;
    const checked = await this.validate(seat, command);
    if (!checked.ok) return failure('stale-revision', 'Board changed; choose the action again');
    return this.submitAt(seat, command, next, retries - 1);
  }

  /** The worker publishes the newly certified head shortly after rejecting an intent. */
  private async nextHead(
    previous: OnlineWorkerHead,
    steps: number,
  ): Promise<OnlineWorkerHead | null> {
    const current = this.getCommittedHead();
    if (!sameHead(current, previous)) return current;
    if (steps === 0 || this.disposed) return null;
    await new Promise((resolve) => setTimeout(resolve, HEAD_WAIT_MS));
    return this.nextHead(previous, steps - 1);
  }

  setPrivateVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.visibilityToken++;
    // Clear immediately; late replies cannot restore a concealed or superseded view.
    this.current = { ...this.current, privateState: null, legal: null };
    void this.client
      .request({ kind: 'setPrivateVisible', visible, visibilityToken: this.visibilityToken })
      .then((result) => {
        if (!result.ok && !this.disposed) this.client.fail(new Error(result.error.message));
        return undefined;
      });
  }

  async exportSave(): Promise<unknown> {
    const result = await this.client.request({ kind: 'exportSave' });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  async retryAudit(): Promise<boolean> {
    const result = await this.client.request({ kind: 'retryAudit' });
    return result.ok && result.value;
  }

  async cancelPending(seat: Seat): Promise<boolean> {
    if (seat !== this.current.localHumanSeat || this.disposed) return false;
    const result = await this.client.request({ kind: 'cancelPending', seat });
    return result.ok && result.value;
  }

  approveRecoveryAuthorization(change: unknown) {
    return this.client.request({ kind: 'approveRecoveryAuthorization', change });
  }

  clearRecoveryApproval(): void {
    void this.client.request({ kind: 'clearRecoveryApproval' });
  }

  canRequestTakeover(departedSeat: Seat) {
    return this.client.request({ kind: 'canRequestTakeover', departedSeat });
  }

  requestTakeover(departedSeat: Seat, botLevel: 'easy' | 'medium' | 'hard') {
    return this.client.request({ kind: 'requestTakeover', departedSeat, botLevel });
  }

  subscribe(listener: (update: SessionUpdate) => void) {
    this.listeners.add(listener);
    listener(this.current.update);
    return () => this.listeners.delete(listener);
  }

  fail(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.current = {
      ...this.current,
      privateState: null,
      legal: null,
      controllableSeats: [],
      update: {
        ...this.current.update,
        pending: [],
        timers: [],
        status: { kind: 'error', message: error.message },
      },
    };
    this.notify();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.current = {
      ...this.current,
      privateState: null,
      legal: null,
      controllableSeats: [],
      update: { ...this.current.update, pending: [], timers: [], status: { kind: 'disposed' } },
    };
    this.onDispose();
    this.notify();
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.current.update);
      } catch {
        /* A view cannot interrupt other subscribers. */
      }
    }
  }
}
