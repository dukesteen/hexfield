import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useDeleteOnlineGame,
  useExportOnlineReplay,
  useOpenOnlineReplay,
  useResumableGames,
} from '../../queries/online-games';
import { ActionPendingContext, DialogFrame } from '../dialogs/DialogFrame';
import './saved-online-games.css';

/** Stored summaries are display-only; opening a game validates its certified history again. */
export function SavedOnlineGames() {
  const { t } = useTranslation('lobby');
  const navigate = useNavigate();
  const saved = useResumableGames();
  const exported = useExportOnlineReplay();
  const opened = useOpenOnlineReplay();
  const removed = useDeleteOnlineGame();
  const [deleteTarget, setDeleteTarget] = useState<{
    gameId: string;
    genesisDigest: string;
    names: string;
  } | null>(null);
  const [message, setMessage] = useState<'failed' | 'busy' | null>(null);
  const pending = exported.isPending || opened.isPending || removed.isPending;
  const replay = async (gameId: string, download: boolean) => {
    setMessage(null);
    try {
      if (!download) {
        const id = await opened.mutateAsync(gameId);
        await navigate({ to: '/replay/$archiveId', params: { archiveId: id } });
        return;
      }
      const bytes = await exported.mutateAsync(gameId);
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `hexfield-${gameId}.hxar`;
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch {
      setMessage('failed');
    }
  };
  const confirmDelete = async () => {
    if (!deleteTarget || pending) return;
    setMessage(null);
    try {
      const result = await removed.mutateAsync({
        gameId: deleteTarget.gameId,
        genesisDigest: deleteTarget.genesisDigest,
      });
      if (result === 'busy') setMessage('busy');
      else setDeleteTarget(null);
    } catch {
      setMessage('failed');
    }
  };
  if (!saved.isError && !saved.data?.games.length && !saved.data?.unavailableGameIds.length)
    return null;
  const stats = saved.data?.stats;
  return (
    <section className="saved-games" aria-labelledby="online-saved-title">
      <h2 id="online-saved-title">{t('lobby:onlineSavedGames')}</h2>
      {saved.isError && <p role="alert">{t('lobby:onlineSavedLoadFailed')}</p>}
      {pending && !deleteTarget && <p role="status">{t('lobby:onlineHistoryWorking')}</p>}
      {message && !deleteTarget && <p role="alert">{t('lobby:onlineHistoryActionFailed')}</p>}
      {!!saved.data?.unavailableGameIds.length && (
        <p role="status">{t('lobby:onlineSavedPartial')}</p>
      )}
      {stats && stats.gamesPlayed > 0 && (
        <div className="online-history-stats">
          <p className="muted">{t('lobby:onlineStatsScope')}</p>
          <dl>
            <div>
              <dt>{t('lobby:onlineStatsGames')}</dt>
              <dd>{stats.gamesPlayed}</dd>
            </div>
            <div>
              <dt>{t('lobby:onlineStatsWinRate')}</dt>
              <dd>{Math.round((stats.wins / stats.gamesPlayed) * 100)}%</dd>
            </div>
            <div>
              <dt>{t('lobby:onlineStatsAverageVp')}</dt>
              <dd>{stats.averageVictoryPoints?.toFixed(1)}</dd>
            </div>
          </dl>
        </div>
      )}
      {saved.data?.games.map((game) => {
        const names = game.genesis.seats.map((seat) => seat.name);
        const outcome = game.outcome;
        const winner = outcome
          ? game.genesis.seats.find((seat) => seat.seat === outcome.terminal.winner)?.name
          : undefined;
        const action = outcome ? t('lobby:onlineHistoryOpenResult') : t('lobby:onlineResumeTitle');
        return (
          <article key={game.gameId} className="online-history-item">
            <Link
              to="/game/$gameId"
              params={{ gameId: game.gameId }}
              className="saved-game-row online-history-row"
              aria-label={`${action}: ${names.join(', ')}`}
            >
              <span className="online-history-description">
                <span className="saved-game-names">{names.join(' · ')}</span>
                <span className="saved-game-time">
                  {t('lobby:onlineGameStarted', {
                    date: new Date(game.genesis.createdAt).toLocaleDateString(),
                  })}
                </span>
                {outcome && (
                  <span className="online-history-result">
                    {t('lobby:onlineHistoryWinner', { player: winner })}
                    <span className="online-history-audit" data-audit={outcome.audit.status}>
                      {outcome.audit.status === 'verified'
                        ? t('lobby:onlineHistoryVerified')
                        : outcome.audit.status === 'failed'
                          ? t('lobby:onlineHistoryAuditFailed')
                          : t('lobby:onlineHistoryAuditPending')}
                    </span>
                  </span>
                )}
                {game.outcomeUnavailable && (
                  <span className="muted">{t('lobby:onlineHistoryUnavailable')}</span>
                )}
                {game.activity && (
                  <span className="saved-game-time">
                    {t('lobby:onlineHistoryLastActive', {
                      date: new Date(game.activity.lastActivityAt).toLocaleDateString(),
                    })}
                  </span>
                )}
                {game.abandoned && (
                  <span className="online-history-inactive">
                    {t('lobby:onlineHistoryInactive')}
                  </span>
                )}
              </span>
              <span className="saved-game-arrow" aria-hidden="true">
                →
              </span>
            </Link>
            <div className="online-history-actions">
              <button
                type="button"
                className="button button-quiet"
                disabled={pending}
                onClick={() => void replay(game.gameId, false)}
              >
                {t('lobby:onlineHistoryReplay')}
              </button>
              <button
                type="button"
                className="button button-quiet"
                disabled={pending}
                onClick={() => void replay(game.gameId, true)}
              >
                {t('lobby:onlineHistoryExport')}
              </button>
              <button
                type="button"
                className="button button-quiet online-history-remove"
                disabled={pending}
                onClick={() => {
                  setMessage(null);
                  setDeleteTarget({
                    gameId: game.gameId,
                    genesisDigest: game.genesisDigest,
                    names: names.join(' · '),
                  });
                }}
              >
                {t('lobby:onlineHistoryDelete')}
              </button>
            </div>
          </article>
        );
      })}
      {deleteTarget && (
        <ActionPendingContext value={removed.isPending}>
          <DialogFrame
            className="app-dialog"
            title={t('lobby:onlineHistoryDeleteTitle')}
            onCancel={() => {
              setDeleteTarget(null);
              setMessage(null);
            }}
            footer={
              <div className="dialog-actions">
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => {
                    setDeleteTarget(null);
                    setMessage(null);
                  }}
                >
                  {t('lobby:onlineHistoryCancelDelete')}
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void confirmDelete()}
                >
                  {t('lobby:onlineHistoryDelete')}
                </button>
              </div>
            }
          >
            <p>{deleteTarget.names}</p>
            <p>{t('lobby:onlineHistoryDeleteWarning')}</p>
            {message && (
              <p role="alert">
                {t(
                  message === 'busy'
                    ? 'lobby:onlineHistoryDeleteBusy'
                    : 'lobby:onlineHistoryActionFailed',
                )}
              </p>
            )}
          </DialogFrame>
        </ActionPendingContext>
      )}
    </section>
  );
}
