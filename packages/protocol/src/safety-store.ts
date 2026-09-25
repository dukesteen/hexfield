/** A persisted consensus-safety record with a monotonic revision. */
export interface StoredSafety {
  readonly revision: number;
  readonly bytes: Uint8Array;
}

/**
 * Durable implementations must complete `save` before sending signed messages.
 * A failed compare-and-swap must be followed by reloading and validating the
 * newer record; callers must never overwrite it as a recovery shortcut.
 */
export interface SafetyStore {
  load(): Promise<StoredSafety | null>;
  save(expectedRevision: number | null, bytes: Uint8Array): Promise<boolean>;
}

/**
 * In-memory CAS storage for tests and a single process lifetime. Keep this
 * object alive across consensus-controller restarts to preserve vote safety.
 */
export class MemorySafetyStore implements SafetyStore {
  private record: StoredSafety | null = null;

  async load(): Promise<StoredSafety | null> {
    const current = this.record;
    return current === null ? null : { revision: current.revision, bytes: current.bytes.slice() };
  }

  async save(expectedRevision: number | null, bytes: Uint8Array): Promise<boolean> {
    if (
      (expectedRevision !== null &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) ||
      !(bytes instanceof Uint8Array)
    ) {
      return false;
    }

    const current = this.record;
    if (expectedRevision === null ? current !== null : current?.revision !== expectedRevision) {
      return false;
    }

    const nextRevision = current === null ? 0 : current.revision + 1;
    if (!Number.isSafeInteger(nextRevision)) return false;

    this.record = { revision: nextRevision, bytes: bytes.slice() };
    return true;
  }
}
