import * as v from 'valibot';
import { browserStorage, type KeyValueStorage } from './storage';

const SAVE_PREFIX = 'hexfield:save:v1:';

const playerSchema = v.strictObject({
  seat: v.picklist([0, 1, 2, 3]),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
  color: v.picklist(['blue', 'orange', 'green', 'magenta']),
  shape: v.picklist(['circle', 'triangle', 'square', 'diamond']),
});

const presentationSchema = v.strictObject({
  players: v.pipe(v.array(playerSchema), v.minLength(2), v.maxLength(4)),
  botDelayMs: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(60_000)),
});

const savedGameSchema = v.strictObject({
  v: v.literal(1),
  id: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,128}$/)),
  revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  updatedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  presentation: presentationSchema,
  save: v.unknown(),
});

export type GamePresentation = v.InferOutput<typeof presentationSchema>;
export type SavedGameRecord = v.InferOutput<typeof savedGameSchema>;
export type SavedGameSummary = Omit<SavedGameRecord, 'save'>;
export type SaveInput = Pick<SavedGameRecord, 'id' | 'revision' | 'presentation' | 'save'>;

export class SaveConflictError extends Error {
  constructor(
    readonly id: string,
    message: string,
  ) {
    super(message);
    this.name = 'SaveConflictError';
  }
}

export interface SavedGameRepository {
  get(id: string): Promise<SavedGameRecord | null>;
  list(): Promise<SavedGameSummary[]>;
  save(input: SaveInput): Promise<SavedGameRecord>;
  flushSync(input: SaveInput): SavedGameRecord;
  remove(id: string, expectedRevision: number): Promise<void>;
  subscribeExternal(listener: (id: string) => void): () => void;
}

export type LockRunner = <T>(name: string, callback: () => T | Promise<T>) => Promise<T>;

async function browserLock<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(name, callback);
  }
  return callback();
}

function parsedRecord(raw: string | null): SavedGameRecord | null {
  return raw === null ? null : v.parse(savedGameSchema, JSON.parse(raw) as unknown);
}

function readRecord(storage: KeyValueStorage, id: string): SavedGameRecord | null {
  const record = parsedRecord(storage.getItem(saveKey(id)));
  if (record && record.id !== id) throw new Error(`Saved game key does not match its id: ${id}`);
  return record;
}

function saveKey(id: string): string {
  v.parse(savedGameSchema.entries.id, id);
  return `${SAVE_PREFIX}${id}`;
}

/**
 * localStorage is the Stage 05 adapter. Each game occupies one atomic storage key;
 * async writes are serialized locally and with Web Locks when the browser supports them.
 */
export class LocalSavedGameRepository implements SavedGameRepository {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(id: string) => void>();
  private readonly externallyChanged = new Set<string>();

  constructor(
    private readonly storage: () => KeyValueStorage = browserStorage,
    private readonly lock: LockRunner = browserLock,
  ) {
    if (typeof window !== 'undefined') window.addEventListener('storage', this.onStorage);
  }

  dispose(): void {
    if (typeof window !== 'undefined') window.removeEventListener('storage', this.onStorage);
    this.listeners.clear();
  }

  private readonly onStorage = (event: StorageEvent): void => {
    if (!event.key?.startsWith(SAVE_PREFIX)) return;
    const id = event.key.slice(SAVE_PREFIX.length);
    this.externallyChanged.add(id);
    for (const listener of this.listeners) listener(id);
  };

  subscribeExternal(listener: (id: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async get(id: string): Promise<SavedGameRecord | null> {
    return readRecord(this.storage(), id);
  }

  async list(): Promise<SavedGameSummary[]> {
    const summaries: SavedGameSummary[] = [];
    const storage = this.storage();
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(SAVE_PREFIX)) continue;
      const record = parsedRecord(storage.getItem(key));
      if (!record) continue;
      if (record.id !== key.slice(SAVE_PREFIX.length)) {
        throw new Error(`Saved game key does not match its id: ${key}`);
      }
      const { save: _save, ...summary } = record;
      summaries.push(summary);
    }
    return summaries.toSorted((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  private write(input: SaveInput): SavedGameRecord {
    if (input.save === undefined) throw new Error('Saved game payload is missing.');
    const key = saveKey(input.id);
    const storage = this.storage();
    const current = readRecord(storage, input.id);
    if (this.externallyChanged.has(input.id)) {
      throw new SaveConflictError(
        input.id,
        'This game changed in another tab. Reload before saving.',
      );
    }
    if (current && input.revision < current.revision) {
      throw new SaveConflictError(input.id, 'A newer revision is already saved.');
    }
    if (current && input.revision === current.revision) {
      if (
        JSON.stringify(current.save) !== JSON.stringify(input.save) ||
        JSON.stringify(current.presentation) !== JSON.stringify(input.presentation)
      ) {
        throw new SaveConflictError(input.id, 'This revision differs from the saved game.');
      }
      return current;
    }
    const record = v.parse(savedGameSchema, {
      v: 1,
      ...input,
      updatedAt: Date.now(),
    });
    storage.setItem(key, JSON.stringify(record));
    return record;
  }

  /** Used by pagehide before any asynchronous work can be scheduled. */
  flushSync(input: SaveInput): SavedGameRecord {
    return this.write(input);
  }

  private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const work = previous.then(task);
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id);
      return undefined;
    });
    return work;
  }

  save(input: SaveInput): Promise<SavedGameRecord> {
    return this.enqueue(input.id, () => this.lock(saveKey(input.id), () => this.write(input)));
  }

  remove(id: string, expectedRevision: number): Promise<void> {
    return this.enqueue(id, () =>
      this.lock(saveKey(id), () => {
        const storage = this.storage();
        const current = readRecord(storage, id);
        if (!current) return;
        if (current.revision !== expectedRevision || this.externallyChanged.has(id)) {
          throw new SaveConflictError(id, 'The saved game changed before deletion.');
        }
        storage.removeItem(saveKey(id));
      }),
    );
  }
}
