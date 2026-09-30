import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { loadLocalGameReplay } from '../../../features/replay/replay-load.js';
import { ReplayViewer } from '../../../features/replay/ReplayViewer.js';
import { useDeferredReplay } from '../../../features/replay/use-replay.js';
import { loadSavedGame } from '../../../queries/hooks.js';

/** A game saved on this device (a local or bot game), replayed from its own save. */
export const Route = createFileRoute('/replay/local/$gameId')({
  loader: async ({ context, params }) => {
    const record = await loadSavedGame(context.queryClient, params.gameId);
    if (!record) throw notFound();
    return record;
  },
  component: LocalReplayPage,
  notFoundComponent: MissingReplay,
});

function MissingReplay() {
  const { t } = useTranslation(['game', 'lobby']);
  return (
    <main className="app-page message-page">
      <h1>{t('game:replay.loadFailed')}</h1>
      <Link to="/" className="button button-primary">
        {t('lobby:backHome')}
      </Link>
    </main>
  );
}

function LocalReplayPage() {
  const record = Route.useLoaderData();
  const { t } = useTranslation(['game', 'lobby']);
  const load = useCallback(
    () => loadLocalGameReplay(record, (seat) => t('lobby:defaultPlayerName', { number: seat + 1 })),
    [record, t],
  );
  const replay = useDeferredReplay(load);
  if (replay.status === 'loading')
    return (
      <p className="app-page" role="status">
        {t('game:replay.preparing')}
      </p>
    );
  if (replay.status === 'error') return <MissingReplay />;
  return (
    <ReplayViewer
      loaded={replay.value}
      title={t('game:replay.title', {
        players: record.presentation.players.map((player) => player.name).join(' · '),
      })}
    />
  );
}
