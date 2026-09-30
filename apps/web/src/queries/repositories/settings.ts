import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { IndexedDbByteStore } from '@cp2p/storage';
import * as v from 'valibot';
import { DEFAULT_NETWORK_SETTINGS, networkSettingsSchema } from '../network-config';
import { browserStorage, type KeyValueStorage } from './storage';

const LEGACY_SETTINGS_KEY = 'hexfield:settings:v1';
const SETTINGS_RECORD_KEY = 'web/settings/v2';
const STORAGE_PERSISTENCE_MARKER_KEY = 'web/settings/storage-persistence-requested/v1';
const SETTINGS_LOCK_ID = 'web-settings';
const MAX_SETTINGS_BYTES = 64 * 1024;

const legacySettingsSchema = v.strictObject({
  v: v.literal(1),
  language: v.literal('en'),
  theme: v.picklist(['system', 'light', 'dark']),
  hotseatCover: v.boolean(),
  reducedMotion: v.picklist(['system', 'reduce']),
});

const settingsSchema = v.strictObject({
  v: v.literal(2),
  language: v.literal('en'),
  theme: v.picklist(['system', 'light', 'dark']),
  hotseatCover: v.boolean(),
  reducedMotion: v.picklist(['system', 'reduce']),
  /** Pick a face-down card on the steal sheet (cosmetic; absent in older records means on). */
  pickStealCard: v.optional(v.boolean()),
  network: networkSettingsSchema,
});

const settingsPatchSchema = v.partial(
  v.strictObject({
    language: v.literal('en'),
    theme: v.picklist(['system', 'light', 'dark']),
    hotseatCover: v.boolean(),
    reducedMotion: v.picklist(['system', 'reduce']),
    pickStealCard: v.boolean(),
    network: networkSettingsSchema,
  }),
);

export type Settings = v.InferOutput<typeof settingsSchema>;
export type SettingsPatch = v.InferOutput<typeof settingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = {
  v: 2,
  language: 'en',
  theme: 'system',
  hotseatCover: true,
  reducedMotion: 'system',
  pickStealCard: true,
  network: DEFAULT_NETWORK_SETTINGS,
};

export interface SettingsRepository {
  get(): Promise<Settings>;
  update(patch: SettingsPatch): Promise<Settings>;
  /** Atomically claim the one-time browser storage persistence request. */
  claimStoragePersistenceRequest(): Promise<boolean>;
}

export interface IndexedDbSettingsRepositoryOptions {
  readonly store?: IndexedDbByteStore;
  readonly legacyStorage?: () => KeyValueStorage;
}

/** Settings are strictly validated and stored as one durable, cross-tab record. */
export class IndexedDbSettingsRepository implements SettingsRepository {
  readonly #store: IndexedDbByteStore;
  readonly #legacyStorage: () => KeyValueStorage;

  constructor(options: IndexedDbSettingsRepositoryOptions = {}) {
    this.#store = options.store ?? new IndexedDbByteStore({ maxRecordBytes: MAX_SETTINGS_BYTES });
    this.#legacyStorage = options.legacyStorage ?? browserStorage;
  }

  async get(): Promise<Settings> {
    return this.#store.withCeremonyLock(SETTINGS_LOCK_ID, async () => {
      const current = await this.#readPersisted();
      if (current) {
        this.#clearLegacyBestEffort();
        return current;
      }
      return (await this.#migrateLegacy()) ?? cloneSettings(DEFAULT_SETTINGS);
    });
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    const copiedPatch = clonePatch(patch);
    return this.#store.withCeremonyLock(SETTINGS_LOCK_ID, async () => {
      const current =
        (await this.#readPersisted()) ??
        (await this.#migrateLegacy()) ??
        cloneSettings(DEFAULT_SETTINGS);
      const next = v.parse(settingsSchema, { ...current, ...copiedPatch, v: 2 });
      const bytes = encodeSettings(next);
      const previousBytes = await this.#store.load(SETTINGS_RECORD_KEY);
      const stored = previousBytes
        ? await this.#store.compareAndSwap(SETTINGS_RECORD_KEY, previousBytes, bytes)
        : await this.#store.putIfAbsent(SETTINGS_RECORD_KEY, bytes);
      if (!stored) throw new Error('Settings changed during update; reload and try again.');
      const confirmed = await this.#readPersisted();
      if (!confirmed || !equalSettings(confirmed, next))
        throw new Error('Settings write could not be confirmed.');
      this.#clearLegacyBestEffort();
      return cloneSettings(confirmed);
    });
  }

  async claimStoragePersistenceRequest(): Promise<boolean> {
    return this.#store.withCeremonyLock(SETTINGS_LOCK_ID, async () => {
      const stored = await this.#store.load(STORAGE_PERSISTENCE_MARKER_KEY);
      if (stored !== null) {
        if (canonicalDecode(stored) !== true)
          throw new Error('Stored storage-persistence marker is invalid.');
        return false;
      }
      const marker = canonicalEncode(true);
      const created = await this.#store.putIfAbsent(STORAGE_PERSISTENCE_MARKER_KEY, marker);
      const confirmed = await this.#store.load(STORAGE_PERSISTENCE_MARKER_KEY);
      if (!confirmed || canonicalDecode(confirmed) !== true)
        throw new Error('Storage-persistence request marker could not be confirmed.');
      return created;
    });
  }

  async #readPersisted(): Promise<Settings | null> {
    const bytes = await this.#store.load(SETTINGS_RECORD_KEY);
    if (bytes === null) return null;
    if (bytes.byteLength > MAX_SETTINGS_BYTES)
      throw new Error('Stored settings exceed their size limit.');
    return v.parse(settingsSchema, canonicalDecode(bytes));
  }

  async #migrateLegacy(): Promise<Settings | null> {
    const storage = this.#legacyStorage();
    const raw = storage.getItem(LEGACY_SETTINGS_KEY);
    if (raw === null) return null;
    const legacy = v.parse(legacySettingsSchema, JSON.parse(raw));
    const migrated = v.parse(settingsSchema, {
      ...legacy,
      v: 2,
      network: DEFAULT_NETWORK_SETTINGS,
    });
    const bytes = encodeSettings(migrated);
    await this.#store.putIfAbsent(SETTINGS_RECORD_KEY, bytes);
    const confirmed = await this.#readPersisted();
    if (!confirmed) throw new Error('Migrated settings write could not be confirmed.');
    // Keep the legacy record until IndexedDB contains a valid durable replacement.
    this.#clearLegacyBestEffort();
    return confirmed;
  }

  #clearLegacyBestEffort(): void {
    try {
      this.#legacyStorage().removeItem(LEGACY_SETTINGS_KEY);
    } catch {
      // The confirmed IndexedDB value is authoritative; stale legacy cleanup can retry later.
    }
  }
}

function encodeSettings(settings: Settings): Uint8Array {
  const bytes = canonicalEncode(settings);
  if (bytes.byteLength > MAX_SETTINGS_BYTES) throw new Error('Settings exceed their size limit.');
  return bytes;
}

function cloneSettings(settings: Settings): Settings {
  return v.parse(settingsSchema, canonicalDecode(canonicalEncode(settings)));
}

function clonePatch(patch: SettingsPatch): SettingsPatch {
  return v.parse(settingsPatchSchema, canonicalDecode(canonicalEncode(patch)));
}

function equalSettings(left: Settings, right: Settings): boolean {
  const leftBytes = canonicalEncode(left);
  const rightBytes = canonicalEncode(right);
  return (
    leftBytes.length === rightBytes.length &&
    leftBytes.every((byte, index) => byte === rightBytes[index])
  );
}
