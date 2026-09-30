import { useRouterState } from '@tanstack/react-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { watchBackgrounding } from './background-watch.js';
import { isActiveGamePath, isOnlineGamePath, isWakeLockPath } from './game-paths.js';
import { pwaUpdates, type UpdateStore } from './update-store.js';
import { browserWakeLock, holdScreenWakeLock } from './wake-lock.js';
import './pwa.css';

export function usePwaUpdate(store: UpdateStore = pwaUpdates) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * "Update available — Reload". Deferred while a game or lobby is open, so a new version never
 * interrupts play; it appears once the player is back on a non-game screen.
 */
export function UpdatePrompt({ path, store = pwaUpdates }: { path: string; store?: UpdateStore }) {
  const { t } = useTranslation('common');
  const { status } = usePwaUpdate(store);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (status !== 'waiting') setDismissed(false);
  }, [status]);
  if (status === 'updating')
    return (
      <aside className="pwa-toast" role="status">
        <p>{t('common:pwaUpdating')}</p>
      </aside>
    );
  if (status !== 'waiting' || dismissed || isActiveGamePath(path)) return null;
  return (
    <aside className="pwa-toast" role="status" aria-label={t('common:pwaUpdateAvailable')}>
      <p>
        <strong>{t('common:pwaUpdateAvailable')}</strong> {t('common:pwaUpdateDescription')}
      </p>
      <div className="pwa-toast-actions">
        <button className="button button-quiet" type="button" onClick={() => setDismissed(true)}>
          {t('common:pwaUpdateLater')}
        </button>
        <button
          className="button button-primary"
          type="button"
          onClick={() => void store.applyUpdate()}
        >
          {t('common:pwaUpdateReload')}
        </button>
      </div>
    </aside>
  );
}

/** Screen wake lock during games, and the online-game backgrounding warning. */
export function GameScreenGuards({ path }: { path: string }) {
  const { t } = useTranslation('common');
  const keepAwake = isWakeLockPath(path);
  const online = isOnlineGamePath(path);
  const [backgrounded, setBackgrounded] = useState(false);

  useEffect(
    () => (keepAwake ? holdScreenWakeLock(browserWakeLock(), document) : undefined),
    [keepAwake],
  );

  useEffect(() => {
    setBackgrounded(false);
    return online ? watchBackgrounding(document, () => setBackgrounded(true)) : undefined;
  }, [online]);

  if (!online || !backgrounded) return null;
  return (
    <aside className="pwa-toast pwa-toast-warning" role="status">
      <p>{t('common:pwaBackgroundWarning')}</p>
      <div className="pwa-toast-actions">
        <button
          className="button button-quiet"
          type="button"
          onClick={() => setBackgrounded(false)}
        >
          {t('common:pwaDismiss')}
        </button>
      </div>
    </aside>
  );
}

export function PwaNotices() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  return (
    <>
      <UpdatePrompt path={path} />
      <GameScreenGuards path={path} />
    </>
  );
}
