import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useSavedGames } from '../../queries/hooks';

/** Local saves on this device. Renders nothing while loading or when there is nothing to resume. */
export function LocalSavedGames() {
  const { t } = useTranslation(['lobby']);
  const games = useSavedGames();
  if (games.isError)
    return (
      <section className="saved-games" aria-labelledby="saved-title">
        <h3 id="saved-title">{t('lobby:savedGames')}</h3>
        <p role="alert">{t('lobby:loadFailed')}</p>
      </section>
    );
  if (!games.data?.length) return null;
  return (
    <section className="saved-games" aria-labelledby="saved-title">
      <h3 id="saved-title">{t('lobby:savedGames')}</h3>
      {games.data.map((game) => (
        <Link
          key={game.id}
          to="/local/$gameId"
          params={{ gameId: game.id }}
          className="saved-game-row"
          aria-label={`${t('lobby:resumeGame')}: ${game.presentation.players.map((p) => p.name).join(', ')}`}
        >
          <span className="saved-game-names">
            {game.presentation.players.map((player) => player.name).join(' · ')}
          </span>
          <span className="saved-game-time">
            {t('lobby:lastSaved', { date: new Date(game.updatedAt).toLocaleDateString() })}
          </span>
          <span className="saved-game-arrow" aria-hidden="true">
            →
          </span>
        </Link>
      ))}
    </section>
  );
}
