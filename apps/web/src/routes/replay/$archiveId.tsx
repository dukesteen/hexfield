import { createFileRoute, Link } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { replayFailureMessage } from '../../features/online/replay-failure.js';
import { loadOnlineReplay } from '../../features/replay/replay-load.js';
import { ReplayViewer } from '../../features/replay/ReplayViewer.js';
import { useDeferredReplay } from '../../features/replay/use-replay.js';
import { usePublicReplay } from '../../queries/online-public-replays.js';
import type { PublicArchiveReplay } from '../../session/online-public-archive-worker.js';

export const Route = createFileRoute('/replay/$archiveId')({ component: PublicReplayPage });

function Failure({ message }: { message: string }) {
  const { t } = useTranslation('lobby');
  return (
    <main className="app-page message-page">
      <h1>{message}</h1>
      <Link to="/" className="button button-primary">
        {t('lobby:backHome')}
      </Link>
    </main>
  );
}

function VerifiedReplay({ archive }: { archive: PublicArchiveReplay }) {
  const { t } = useTranslation(['lobby', 'game']);
  const load = useCallback(() => loadOnlineReplay(archive), [archive]);
  const replay = useDeferredReplay(load);
  if (replay.status === 'loading')
    return (
      <p className="app-page" role="status">
        {t('game:replay.preparing')}
      </p>
    );
  if (replay.status === 'error') return <Failure message={t('lobby:publicReplayFailed')} />;
  return (
    <ReplayViewer
      loaded={replay.value}
      title={t('lobby:publicReplayTitle')}
      notice={<p className="muted">{t('lobby:publicReplayReadOnly')}</p>}
    />
  );
}

function PublicReplayPage() {
  const { archiveId } = Route.useParams();
  const { t } = useTranslation('lobby');
  const replay = usePublicReplay(archiveId);
  if (replay.isPending)
    return (
      <p className="app-page" role="status">
        {t('lobby:publicReplayVerifying')}
      </p>
    );
  if (replay.isError || !replay.data)
    return <Failure message={replayFailureMessage(replay.error, t)} />;
  return <VerifiedReplay archive={replay.data} />;
}
