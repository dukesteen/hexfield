export type GameWriterLockManager = Pick<LockManager, 'request'>;

export interface GameWriterLeaseOptions {
  /** Test seam; production uses the same-origin browser Web Locks manager. */
  readonly lockManager?: GameWriterLockManager;
  /** Called synchronously once if the held lock ends before normal release. */
  readonly onLost?: (error: GameWriterLeaseError) => void;
}

export interface GameWriterLease {
  readonly lockName: string;
  /** Run session work in order while retaining the exclusive lock. */
  run<T>(task: () => T | PromiseLike<T>): Promise<T>;
  /** Stop accepting work, drain accepted work, then release the lock. */
  close(): Promise<void>;
}

export class GameWriterLeaseError extends Error {
  constructor(
    readonly code: 'unavailable' | 'closed' | 'lost',
    message: string,
  ) {
    super(message);
    this.name = 'GameWriterLeaseError';
  }
}

/** Acquire one per-game, per-voter browser writer lease without waiting or stealing. */
export async function acquireGameWriterLease(
  gameId: string,
  voterIdentity: string,
  options: GameWriterLeaseOptions = {},
): Promise<GameWriterLease | null> {
  const name = writerLockName(gameId, voterIdentity);
  const manager = options.lockManager ?? browserLockManager();
  let releaseLock!: () => void;
  const releaseSignal = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  let resolveAcquired!: (lock: Lock | null) => void;
  const acquired = new Promise<Lock | null>((resolve) => {
    resolveAcquired = resolve;
  });
  let lockRequestError: unknown;
  let leaseActive = false;
  let accepting = true;
  let expectedRelease = false;
  let lostError: GameWriterLeaseError | null = null;
  const notifyLost = () => {
    if (!leaseActive || expectedRelease || lostError) return;
    lostError = new GameWriterLeaseError('lost', 'Game writer lock ended unexpectedly');
    try {
      options.onLost?.(lostError);
    } catch {
      // A notification is advisory cleanup; it must not create an unhandled lock rejection.
    }
  };
  const lockRequest = manager
    .request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (lock) leaseActive = true;
      resolveAcquired(lock);
      if (lock) await releaseSignal;
    })
    .then(
      () => {
        notifyLost();
        return undefined;
      },
      (error: unknown) => {
        lockRequestError = error;
        if (leaseActive) notifyLost();
        else resolveAcquired(null);
      },
    );

  const lock = await acquired;
  if (!lock) {
    await lockRequest;
    if (lockRequestError !== undefined) throw lockRequestError;
    return null;
  }

  let queue: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | null = null;

  return {
    lockName: name,
    run<T>(task: () => T | PromiseLike<T>): Promise<T> {
      if (!accepting)
        return Promise.reject(new GameWriterLeaseError('closed', 'Game writer lease is closed'));
      if (lostError) return Promise.reject(lostError);
      const result = queue.then(async () => {
        if (lostError) throw lostError;
        return task();
      });
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      accepting = false;
      closePromise = (async () => {
        await queue;
        expectedRelease = true;
        releaseLock();
        await lockRequest;
        if (lockRequestError !== undefined) throw lockRequestError;
      })();
      return closePromise;
    },
  };
}

function writerLockName(gameId: string, voterIdentity: string): string {
  validateId(gameId, 'gameId');
  validateId(voterIdentity, 'voterIdentity');
  return `cp2p/game-writer/${gameId.length}:${gameId}/${voterIdentity.length}:${voterIdentity}`;
}

function validateId(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-][A-Za-z0-9._:-]*$/.test(value)
  )
    throw new TypeError(`${label} must be a nonempty bounded identifier`);
}

function browserLockManager(): GameWriterLockManager {
  if (typeof navigator === 'undefined' || !navigator.locks)
    throw new GameWriterLeaseError(
      'unavailable',
      'Web Locks are unavailable; game writer coordination cannot proceed safely',
    );
  return navigator.locks;
}
