import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useExportOnlineFullSave } from '../../queries/online-full-saves.js';
import { OnlineFullSaveClientError } from '../../session/online-full-save-client.js';
import { ActionPendingContext, DialogFrame } from '../dialogs/DialogFrame.js';
import './full-save.css';

function downloadSave(gameId: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `hexfield-${gameId}.hxfs`;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function FullSaveExportDialog({ gameId, onClose }: { gameId: string; onClose: () => void }) {
  const { t } = useTranslation('lobby');
  const exported = useExportOnlineFullSave();
  const [includePrivate, setIncludePrivate] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (exported.isPending) return;
    setError(null);
    try {
      const bytes = await exported.mutateAsync({
        gameId,
        includePrivate,
        ...(includePrivate ? { passphrase } : {}),
      });
      downloadSave(gameId, bytes);
      setPassphrase('');
      onClose();
    } catch (reason) {
      if (reason instanceof OnlineFullSaveClientError) {
        setError(
          reason.code === 'full-save-passphrase'
            ? 'lobby:fullSavePassphraseInvalid'
            : 'lobby:fullSaveExportFailed',
        );
      } else setError('lobby:fullSaveExportFailed');
      setPassphrase('');
    }
  };

  return (
    <ActionPendingContext value={exported.isPending}>
      <DialogFrame
        className="app-dialog full-save-dialog"
        title={t('lobby:fullSaveExportTitle')}
        onCancel={() => {
          setPassphrase('');
          onClose();
        }}
        footer={
          <div className="dialog-actions">
            <button
              type="button"
              className="button button-quiet"
              disabled={exported.isPending}
              onClick={() => {
                setPassphrase('');
                onClose();
              }}
            >
              {t('lobby:manualClose')}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={exported.isPending || (includePrivate && passphrase.length < 12)}
              onClick={() => void submit()}
            >
              {exported.isPending ? t('lobby:fullSaveExporting') : t('lobby:fullSaveExport')}
            </button>
          </div>
        }
      >
        <p>{t('lobby:fullSaveExportDescription')}</p>
        <p className="muted">{t('lobby:fullSavePublicContents')}</p>
        <label className="full-save-private-choice">
          <input
            type="checkbox"
            checked={includePrivate}
            disabled={exported.isPending}
            onChange={(event) => {
              setIncludePrivate(event.currentTarget.checked);
              setPassphrase('');
              setError(null);
            }}
          />
          <span>{t('lobby:fullSaveIncludePrivate')}</span>
        </label>
        {includePrivate && (
          <div className="full-save-private-warning">
            <p role="note">{t('lobby:fullSavePrivateWarning')}</p>
            <label>
              {t('lobby:fullSavePassphrase')}
              <input
                type="password"
                autoComplete="new-password"
                maxLength={1024}
                value={passphrase}
                disabled={exported.isPending}
                onChange={(event) => setPassphrase(event.currentTarget.value)}
              />
            </label>
            <small>{t('lobby:fullSavePassphraseMinimum')}</small>
          </div>
        )}
        {error && <p role="alert">{t(error)}</p>}
      </DialogFrame>
    </ActionPendingContext>
  );
}
