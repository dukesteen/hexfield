import { Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useImportPublicReplay, usePublicReplays } from '../../queries/online-public-replays.js';
import { MAX_ONLINE_PUBLIC_ARCHIVE_BYTES } from '../../session/online-public-archive-format.js';

export function PublicReplayLibrary() {
  const { t } = useTranslation('lobby');
  const navigate = useNavigate();
  const catalogue = usePublicReplays();
  const imported = useImportPublicReplay();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState(false);
  const chooseFile = async (file: File | undefined) => {
    if (!file || imported.isPending) return;
    setError(false);
    try {
      // Check before File.arrayBuffer() so a huge file never enters JS memory.
      if (file.size < 1 || file.size > MAX_ONLINE_PUBLIC_ARCHIVE_BYTES)
        throw new Error('Public replay size is invalid');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const id = await imported.mutateAsync(bytes);
      await navigate({ to: '/replay/$archiveId', params: { archiveId: id } });
    } catch {
      setError(true);
    } finally {
      if (input.current) input.current.value = '';
    }
  };
  return (
    <section className="saved-games" aria-labelledby="public-replay-title">
      <h3 id="public-replay-title">{t('lobby:publicReplaysTitle')}</h3>
      <p className="muted">{t('lobby:publicReplaysDescription')}</p>
      <input
        ref={input}
        hidden
        type="file"
        accept=".hxar,application/octet-stream"
        aria-label={t('lobby:publicReplayChoose')}
        disabled={imported.isPending}
        onChange={(event) => void chooseFile(event.currentTarget.files?.[0])}
      />
      <button
        className="button button-quiet"
        type="button"
        disabled={imported.isPending}
        onClick={() => input.current?.click()}
      >
        {t('lobby:publicReplayImport')}
      </button>
      {imported.isPending && <p role="status">{t('lobby:publicReplayVerifying')}</p>}
      {(error || catalogue.isError) && <p role="alert">{t('lobby:publicReplayFailed')}</p>}
      {catalogue.data?.map((item) => (
        <Link
          key={item.id}
          to="/replay/$archiveId"
          params={{ archiveId: item.id }}
          className="saved-game-row public-replay-row"
          aria-label={`${t('lobby:publicReplayOpen')}: ${item.names.join(', ')}`}
        >
          <span className="online-history-description">
            <span>{item.names.join(' · ')}</span>
            <span className="saved-game-time">
              {t('lobby:publicReplaySummary', {
                date: new Date(item.createdAt).toLocaleDateString(),
                number: item.headSeq,
              })}
            </span>
          </span>
          <span aria-hidden="true">→</span>
        </Link>
      ))}
    </section>
  );
}
