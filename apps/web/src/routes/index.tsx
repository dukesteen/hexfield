import { createFileRoute, Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useSavedGames } from '../queries/hooks';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  const { t } = useTranslation(['common', 'lobby', 'game']);
  const games = useSavedGames();
  return (
    <main className="home-page app-page">
      <header className="app-header">
        <span className="brand-mark" aria-hidden="true" />
        <span className="app-brand">{t('common:appTitle')}</span>
        <Link to="/settings" className="text-link header-settings">
          {t('game:openSettings')}
        </Link>
      </header>
      <div className="home-content">
        <section className="home-intro" aria-labelledby="home-title">
          <h1 id="home-title">{t('lobby:homeTitle')}</h1>
          <p>{t('lobby:homeDescription')}</p>
          <Link to="/local/new" className="button button-primary">
            {t('lobby:newGame')}
          </Link>
        </section>
        <section className="saved-games" aria-labelledby="saved-title">
          <div className="section-heading">
            <h2 id="saved-title">{t('lobby:savedGames')}</h2>
          </div>
          {games.isError && <p role="alert">{t('lobby:loadFailed')}</p>}
          {games.isPending && <p role="status">{t('game:loadingGame')}</p>}
          {games.data?.length === 0 && <p className="muted">{t('lobby:noSavedGames')}</p>}
          {games.data?.map((game) => (
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
      </div>
    </main>
  );
}
