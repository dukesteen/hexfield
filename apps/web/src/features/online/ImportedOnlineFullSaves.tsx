import { Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useImportOnlineFullSave,
  useImportedOnlineFullSaves,
} from '../../queries/online-full-saves.js';
import { OnlineFullSaveClientError } from '../../session/online-full-save-client.js';
import { MAX_ONLINE_FULL_SAVE_BYTES } from '../../session/online-full-save.js';
import './full-save.css';

function errorKey(error: unknown): string {
  if (!(error instanceof OnlineFullSaveClientError)) return 'lobby:fullSaveImportFailed';
  if (error.code === 'full-save-passphrase') return 'lobby:fullSavePassphraseRequired';
  if (error.code === 'full-save-decrypt') return 'lobby:fullSaveWrongPassphrase';
  return 'lobby:fullSaveImportFailed';
}

export function ImportedOnlineFullSaves() {
  const { t } = useTranslation('lobby');
  const navigate = useNavigate();
  const catalogue = useImportedOnlineFullSaves();
  const imported = useImportOnlineFullSave();
  const input = useRef<HTMLInputElement>(null);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);

  const chooseFile = async (file: File | undefined) => {
    if (!file || imported.isPending) return;
    setError(null);
    setPassphrase('');
    try {
      if (file.size < 1 || file.size > MAX_ONLINE_FULL_SAVE_BYTES)
        throw new Error('Full-save file size is invalid');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await imported.mutateAsync({
        bytes,
        ...(passphrase ? { passphrase } : {}),
      });
      setPassphrase('');
      await navigate({ to: '/full-save/$saveId', params: { saveId: result.id } });
    } catch (reason) {
      setError(errorKey(reason));
      setPassphrase('');
    } finally {
      if (input.current) input.current.value = '';
    }
  };

  return (
    <section className="saved-games imported-full-saves" aria-labelledby="full-save-list-title">
      <h3 id="full-save-list-title">{t('lobby:fullSaveTitle')}</h3>
      <p className="muted">{t('lobby:fullSaveDescription')}</p>
      <label className="full-save-import-passphrase">
        {t('lobby:fullSaveImportPassphrase')}
        <input
          type="password"
          autoComplete="current-password"
          maxLength={1024}
          value={passphrase}
          disabled={imported.isPending}
          onChange={(event) => setPassphrase(event.currentTarget.value)}
        />
      </label>
      <input
        ref={input}
        hidden
        type="file"
        accept=".hxfs,application/octet-stream"
        aria-label={t('lobby:fullSaveChoose')}
        disabled={imported.isPending}
        onChange={(event) => void chooseFile(event.currentTarget.files?.[0])}
      />
      <button
        className="button button-quiet"
        type="button"
        disabled={imported.isPending}
        onClick={() => input.current?.click()}
      >
        {t('lobby:fullSaveImport')}
      </button>
      {imported.isPending && <p role="status">{t('lobby:fullSaveImporting')}</p>}
      {(error || catalogue.isError) && <p role="alert">{t(error ?? 'lobby:fullSaveListFailed')}</p>}
      {catalogue.isPending && <p role="status">{t('lobby:fullSaveLoading')}</p>}
      {catalogue.data?.map((save) => (
        <Link
          key={save.id}
          to="/full-save/$saveId"
          params={{ saveId: save.id }}
          className="saved-game-row full-save-row"
          aria-label={`${t('lobby:fullSaveOpen')}: ${save.names.join(', ')}`}
        >
          <span className="online-history-description">
            <span className="saved-game-names">{save.names.join(' · ')}</span>
            <span className="saved-game-time">
              {t('lobby:fullSaveSummary', {
                date: new Date(save.createdAt).toLocaleDateString(),
                number: save.headSeq,
              })}
            </span>
            <span className="full-save-mode">
              {save.privateCapsule === 'encrypted'
                ? t('lobby:fullSavePrivateEncrypted')
                : t('lobby:fullSavePublicOnly')}
            </span>
          </span>
          <span aria-hidden="true">→</span>
        </Link>
      ))}
    </section>
  );
}
