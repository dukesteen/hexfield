import type { ProtocolClock } from '../transport.js';

const DEFAULT_OPERATION_LIMIT = 100_000;

interface TimerHandle {
  readonly clock: VirtualClock;
  readonly id: number;
}

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
  cancelled: boolean;
}

/** Options for a deterministic virtual timer queue. */
export interface VirtualClockOptions {
  /** Initial monotonic time in milliseconds. Defaults to zero. */
  readonly startAt?: number;
  /** Maximum callbacks any one advance operation may run. */
  readonly maxOperations?: number;
}

/**
 * A deterministic clock for protocol tests. Timers scheduled for the same
 * time run in insertion order, including timers created by another callback.
 */
export class VirtualClock implements ProtocolClock {
  private time: number;
  private nextId = 0;
  private readonly timers = new Map<number, Timer>();
  private readonly heap: Timer[] = [];
  private readonly maxOperations: number;
  private advancing = false;

  constructor(options: VirtualClockOptions = {}) {
    this.time = options.startAt ?? 0;
    this.maxOperations = options.maxOperations ?? DEFAULT_OPERATION_LIMIT;
    if (!Number.isFinite(this.time)) throw new RangeError('startAt must be finite');
    if (!Number.isSafeInteger(this.maxOperations) || this.maxOperations < 1)
      throw new RangeError('maxOperations must be a positive safe integer');
  }

  now(): number {
    return this.time;
  }

  /** Schedule a callback. Negative delays behave like zero-delay timers. */
  setTimeout(callback: () => void, delayMs: number): unknown {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    if (!Number.isFinite(delayMs)) throw new RangeError('delayMs must be finite');
    const at = this.time + Math.max(0, delayMs);
    if (!Number.isFinite(at)) throw new RangeError('scheduled time must be finite');
    const timer: Timer = {
      id: this.nextId++,
      at,
      callback,
      cancelled: false,
    };
    this.timers.set(timer.id, timer);
    this.push(timer);
    return { clock: this, id: timer.id } satisfies TimerHandle;
  }

  /** Cancel a timer from this clock. Foreign and already-fired handles are ignored. */
  clearTimeout(handle: unknown): void {
    if (typeof handle !== 'object' || handle === null) return;
    const candidate = handle as Partial<TimerHandle>;
    if (candidate.clock !== this || typeof candidate.id !== 'number') return;
    const timer = this.timers.get(candidate.id);
    if (timer) {
      timer.cancelled = true;
      this.timers.delete(timer.id);
    }
  }

  /** Advance by a non-negative duration and run due callbacks in stable order. */
  advanceBy(durationMs: number, maxOperations = this.maxOperations): number {
    if (!Number.isFinite(durationMs) || durationMs < 0)
      throw new RangeError('durationMs must be finite and non-negative');
    return this.advanceTo(this.time + durationMs, maxOperations);
  }

  /** Advance to an absolute time, running every timer due at or before it. */
  advanceTo(targetMs: number, maxOperations = this.maxOperations): number {
    this.assertAdvance(targetMs, maxOperations);
    return this.withAdvance(() => {
      let operations = 0;
      let timer = this.peek();
      while (timer && timer.at <= targetMs) {
        if (operations >= maxOperations) throw new Error('Virtual clock operation limit exceeded');
        this.pop();
        this.time = timer.at;
        this.timers.delete(timer.id);
        timer.callback();
        operations++;
        timer = this.peek();
      }
      this.time = targetMs;
      return operations;
    });
  }

  /** Run exactly the next scheduled callback, if one exists. */
  runNext(): boolean {
    this.assertAdvance(this.time, this.maxOperations);
    return this.withAdvance(() => {
      const timer = this.peek();
      if (!timer) return false;
      this.pop();
      this.time = Math.max(this.time, timer.at);
      this.timers.delete(timer.id);
      timer.callback();
      return true;
    });
  }

  /** Run callbacks until the predicate passes or no timers remain. */
  runUntil(predicate: () => boolean, maxOperations = this.maxOperations): boolean {
    this.assertLimit(maxOperations);
    if (typeof predicate !== 'function') throw new TypeError('predicate must be a function');
    if (this.advancing) throw new Error('Virtual clock cannot be advanced from a timer callback');
    return this.withAdvance(() => {
      let operations = 0;
      while (!predicate()) {
        const timer = this.peek();
        if (!timer) return false;
        if (operations >= maxOperations) throw new Error('Virtual clock operation limit exceeded');
        this.pop();
        this.time = Math.max(this.time, timer.at);
        this.timers.delete(timer.id);
        timer.callback();
        operations++;
      }
      return true;
    });
  }

  /** Number of live, uncancelled timers. */
  pendingTimerCount(): number {
    return this.timers.size;
  }

  private assertAdvance(targetMs: number, maxOperations: number): void {
    if (!Number.isFinite(targetMs) || targetMs < this.time)
      throw new RangeError('target time must be finite and cannot move backwards');
    this.assertLimit(maxOperations);
    if (this.advancing) throw new Error('Virtual clock cannot be advanced from a timer callback');
  }

  private assertLimit(maxOperations: number): void {
    if (!Number.isSafeInteger(maxOperations) || maxOperations < 1)
      throw new RangeError('maxOperations must be a positive safe integer');
  }

  private withAdvance<T>(operation: () => T): T {
    this.advancing = true;
    try {
      return operation();
    } finally {
      this.advancing = false;
    }
  }

  private peek(): Timer | undefined {
    while (this.heap[0]?.cancelled) this.pop();
    return this.heap[0];
  }

  private push(timer: Timer): void {
    this.heap.push(timer);
    let childIndex = this.heap.length - 1;
    while (childIndex > 0) {
      const parentIndex = Math.floor((childIndex - 1) / 2);
      const child = this.heap[childIndex];
      const parent = this.heap[parentIndex];
      if (!child || !parent || compareTimers(parent, child) <= 0) break;
      this.heap[parentIndex] = child;
      this.heap[childIndex] = parent;
      childIndex = parentIndex;
    }
  }

  private pop(): Timer | undefined {
    const first = this.heap[0];
    const last = this.heap.pop();
    if (!first || !last || this.heap.length === 0) return first;
    this.heap[0] = last;
    let parentIndex = 0;
    while (true) {
      const leftIndex = parentIndex * 2 + 1;
      const rightIndex = leftIndex + 1;
      let smallestIndex = parentIndex;
      const parent = this.heap[parentIndex];
      const left = this.heap[leftIndex];
      const right = this.heap[rightIndex];
      if (parent && left && compareTimers(left, parent) < 0) smallestIndex = leftIndex;
      const smallest = this.heap[smallestIndex];
      if (smallest && right && compareTimers(right, smallest) < 0) smallestIndex = rightIndex;
      if (smallestIndex === parentIndex) break;
      const current = this.heap[parentIndex];
      const next = this.heap[smallestIndex];
      if (!current || !next) break;
      this.heap[parentIndex] = next;
      this.heap[smallestIndex] = current;
      parentIndex = smallestIndex;
    }
    return first;
  }
}

function compareTimers(left: Timer, right: Timer): number {
  return left.at - right.at || left.id - right.id;
}
