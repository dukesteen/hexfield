export type GameWriterLockManager = Pick<LockManager, 'request'>;

export interface GameWriterLeaseOptions {
  /** Test seam; production uses the same-origin browser Web Locks manager. */
  readonly lockManager?: GameWriterLockManager;
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
  const lockRequest = manager
    .request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      resolveAcquired(lock);
      if (lock) await releaseSignal;
    })
    .catch((error: unknown) => {
      lockRequestError = error;
      resolveAcquired(null);
    });

  const lock = await acquired;
  if (!lock) {
    await lockRequest;
    if (lockRequestError !== undefined) throw lockRequestError;
    return null;
  }

  let accepting = true;
  let queue: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | null = null;
  let lost = false;
  void lockRequest.then(() => {
    if (accepting) lost = true;
    return undefined;
  });

  return {
    lockName: name,
    run<T>(task: () => T | PromiseLike<T>): Promise<T> {
      if (!accepting)
        return Promise.reject(new GameWriterLeaseError('closed', 'Game writer lease is closed'));
      const result = queue.then(async () => {
        if (lost) throw new GameWriterLeaseError('lost', 'Game writer lock ended unexpectedly');
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
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
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
