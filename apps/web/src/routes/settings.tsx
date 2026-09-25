import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings, useUpdateSettings } from '../queries/hooks';
import type { Settings } from '../queries/repositories/settings';

export const Route = createFileRoute('/settings')({ component: SettingsPage });

function SettingsPage() {
  const { t } = useTranslation(['lobby', 'game']);
  const settings = useSettings();
  return (
    <main className="app-page form-page">
      <header className="app-header">
        <Link to="/" className="text-link">
          {t('lobby:backHome')}
        </Link>
        <span className="app-brand">{t('lobby:settingsTitle')}</span>
      </header>
      <div className="form-page-content">
        <h1>{t('lobby:settingsTitle')}</h1>
        <p className="muted">{t('lobby:settingsDescription')}</p>
        {settings.isPending && <p role="status">{t('game:loadingGame')}</p>}
        {settings.isError && <p role="alert">{t('lobby:settingsLoadError')}</p>}
        {settings.data && <SettingsForm initial={settings.data} />}
      </div>
    </main>
  );
}

function SettingsForm({ initial }: { initial: Settings }) {
  const { t } = useTranslation('lobby');
  const [theme, setTheme] = useState(initial.theme);
  const [hotseatCover, setHotseatCover] = useState(initial.hotseatCover);
  const [reducedMotion, setReducedMotion] = useState(initial.reducedMotion);
  const update = useUpdateSettings();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    update.mutate({ theme, hotseatCover, reducedMotion });
  };

  return (
    <form className="settings-form" onSubmit={submit}>
      <fieldset>
        <legend>{t('lobby:appearance')}</legend>
        <label htmlFor="theme">{t('lobby:theme')}</label>
        <select
          id="theme"
          value={theme}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'system' || value === 'light' || value === 'dark') setTheme(value);
          }}
        >
          <option value="system">{t('lobby:themeSystem')}</option>
          <option value="light">{t('lobby:themeLight')}</option>
          <option value="dark">{t('lobby:themeDark')}</option>
        </select>
      </fieldset>
      <fieldset>
        <legend>{t('lobby:privacy')}</legend>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={hotseatCover}
            onChange={(event) => setHotseatCover(event.target.checked)}
          />
          <span>{t('lobby:hotseatCover')}</span>
        </label>
      </fieldset>
      <fieldset>
        <legend>{t('lobby:motion')}</legend>
        <label htmlFor="motion-setting">{t('lobby:motion')}</label>
        <select
          id="motion-setting"
          value={reducedMotion}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'system' || value === 'reduce') setReducedMotion(value);
          }}
        >
          <option value="system">{t('lobby:motionSystem')}</option>
          <option value="reduce">{t('lobby:motionReduce')}</option>
        </select>
      </fieldset>
      <button className="button button-primary" type="submit" disabled={update.isPending}>
        {t('lobby:saveSettings')}
      </button>
      {update.isSuccess && <p role="status">{t('lobby:settingsSaved')}</p>}
      {update.isError && <p role="alert">{t('lobby:settingsSaveError')}</p>}
    </form>
  );
}
