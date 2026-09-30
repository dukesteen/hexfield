import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import * as v from 'valibot';
import { MAP_STORE, openDatabase } from './database.js';

/** A saved map is small; its canonical JSON is capped by the map format itself. */
export const MAX_SAVED_MAP_BYTES = 128 * 1024;

const savedMapSchema = v.strictObject({
  v: v.literal(1),
  id: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  updatedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** The map's canonical JSON. The app validates it against the `MapDef` schema on read. */
  json: v.pipe(v.string(), v.maxLength(MAX_SAVED_MAP_BYTES)),
});

export type SavedMapRecord = v.InferOutput<typeof savedMapSchema>;

function decode(bytes: Uint8Array): SavedMapRecord | null {
  if (bytes.length > MAX_SAVED_MAP_BYTES * 2) return null;
  try {
    const parsed = v.safeParse(savedMapSchema, canonicalDecode(bytes));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

/**
 * Saved editor maps in the `maps` object store (database version 6). Maps are public boards, so
 * they sit outside the vault; unreadable records are skipped, never thrown.
 */
export class IndexedDbMapStore {
  /** Every readable saved map, newest first. */
  async list(): Promise<SavedMapRecord[]> {
    const database = await openDatabase(
      () => undefined,
      () => undefined,
    );
    try {
      const values = await database.getAll(MAP_STORE);
      return values
        .map(decode)
        .filter((record): record is SavedMapRecord => record !== null)
        .toSorted((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    } finally {
      database.close();
    }
  }

  async get(id: string): Promise<SavedMapRecord | null> {
    const database = await openDatabase(
      () => undefined,
      () => undefined,
    );
    try {
      const bytes = await database.get(MAP_STORE, id);
      const record = bytes ? decode(bytes) : null;
      return record?.id === id ? record : null;
    } finally {
      database.close();
    }
  }

  /** Insert or replace a map by id. */
  async put(record: SavedMapRecord): Promise<SavedMapRecord> {
    const checked = v.parse(savedMapSchema, record);
    const bytes = canonicalEncode(checked);
    const database = await openDatabase(
      () => undefined,
      () => undefined,
    );
    try {
      await database.put(MAP_STORE, bytes, checked.id);
      return checked;
    } finally {
      database.close();
    }
  }

  async delete(id: string): Promise<void> {
    const database = await openDatabase(
      () => undefined,
      () => undefined,
    );
    try {
      await database.delete(MAP_STORE, id);
    } finally {
      database.close();
    }
  }
}
