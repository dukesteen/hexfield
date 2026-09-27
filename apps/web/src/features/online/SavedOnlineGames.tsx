import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useResumableGames } from '../../queries/online-games';
import './saved-online-games.css';

/** Stored summaries are display-only; opening a game validates its certified history again. */
export function SavedOnlineGames() {
  const { t } = useTranslation('lobby');
  const saved = useResumableGames();
  if (!saved.isError && !saved.data?.games.length && !saved.data?.unavailableGameIds.length)
    return null;
  const stats = saved.data?.stats;
  return (
    <section className="saved-games" aria-labelledby="online-saved-title">
      <h2 id="online-saved-title">{t('lobby:onlineSavedGames')}</h2>
      {saved.isError && <p role="alert">{t('lobby:onlineSavedLoadFailed')}</p>}
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
          <Link
            key={game.gameId}
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
            </span>
            <span className="saved-game-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        );
      })}
    </section>
  );
}
