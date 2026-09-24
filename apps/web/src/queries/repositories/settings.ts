import * as v from 'valibot';
import { browserStorage, type KeyValueStorage } from './storage';

const SETTINGS_KEY = 'hexfield:settings:v1';

const settingsSchema = v.strictObject({
  v: v.literal(1),
  language: v.literal('en'),
  theme: v.picklist(['system', 'light', 'dark']),
  hotseatCover: v.boolean(),
  reducedMotion: v.picklist(['system', 'reduce']),
});

export type Settings = v.InferOutput<typeof settingsSchema>;
export type SettingsPatch = Partial<Omit<Settings, 'v'>>;

export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  language: 'en',
  theme: 'system',
  hotseatCover: true,
  reducedMotion: 'system',
};

export interface SettingsRepository {
  get(): Promise<Settings>;
  update(patch: SettingsPatch): Promise<Settings>;
}

/** Settings are validated on both reads and writes; corrupt data is surfaced to the UI. */
export class LocalSettingsRepository implements SettingsRepository {
  constructor(private readonly storage: () => KeyValueStorage = browserStorage) {}

  private read(): Settings {
    const raw = this.storage().getItem(SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_SETTINGS };
    return v.parse(settingsSchema, JSON.parse(raw) as unknown);
  }

  async get(): Promise<Settings> {
    return this.read();
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    const settings = v.parse(settingsSchema, { ...this.read(), ...patch });
    this.storage().setItem(SETTINGS_KEY, JSON.stringify(settings));
    return settings;
  }
}
