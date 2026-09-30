import { useTranslation } from 'react-i18next';
import { usePwaUpdate } from '../../pwa/PwaNotices.js';
import { pwaUpdates, type UpdateStore } from '../../pwa/update-store.js';

/**
 * P2P games need identical protocol and engine versions. "Update now" installs a newer
 * version if the server has one and reloads; otherwise it says this device is already current.
 */
export function VersionMismatchNotice({
  message,
  store = pwaUpdates,
}: {
  message: string;
  store?: UpdateStore;
}) {
  const { t } = useTranslation('lobby');
  const { status } = usePwaUpdate(store);
  return (
    <div className="online-notice online-version-notice" role="alert">
      <p>{message}</p>
      {status === 'latest' ? (
        <p>{t('lobby:onlineUpdateLatest')}</p>
      ) : (
        <button
          className="button button-primary"
          type="button"
          disabled={status === 'updating'}
          onClick={() => void store.updateNow()}
        >
          {t('lobby:onlineUpdateNow')}
        </button>
      )}
    </div>
  );
}
