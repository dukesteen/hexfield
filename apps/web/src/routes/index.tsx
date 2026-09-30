import { createFileRoute, Link } from '@tanstack/react-router';
import { getGameArtUrl, getKnightIconUrl, getShipIconUrl } from '@cp2p/renderer';
import { useTranslation } from 'react-i18next';
import { useSavedGames } from '../queries/hooks';
import { useResumableGames } from '../queries/online-games';
import { SavedOnlineGames } from '../features/online/SavedOnlineGames';
import { PublicReplayLibrary } from '../features/online/PublicReplayLibrary';
import { ImportedOnlineFullSaves } from '../features/online/ImportedOnlineFullSaves';
import { HomeModes } from '../features/home/HomeModes';
import { LocalSavedGames } from '../features/home/LocalSavedGames';
import '../features/home/home.css';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  const { t } = useTranslation(['common', 'lobby', 'game']);
  // Both lists share their query cache with the components below; these reads only place them.
  const hasLocal = !!useSavedGames().data?.length;
  const hasOnline = !!useResumableGames().data?.games.length;
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
        <section className="home-hero" aria-labelledby="home-title">
          <div className="home-intro">
            <h1 id="home-title">{t('lobby:homeTitle')}</h1>
            <p>{t('lobby:homeDescription')}</p>
            <div className="home-actions">
              <Link to="/online/create" className="button button-primary home-action-main">
                {t('lobby:playWithFriends')}
              </Link>
              <Link to="/join" className="button button-quiet">
                {t('lobby:joinGame')}
              </Link>
              <Link to="/local/new" className="button button-quiet">
                {t('lobby:newGame')}
              </Link>
            </div>
          </div>
          <div className="home-hero-art" aria-hidden="true">
            <img className="home-board-art" src={getGameArtUrl('preview')} alt="" />
            <img className="home-hero-piece is-ship" src={getShipIconUrl('orange', 3)} alt="" />
            <img className="home-hero-piece is-knight" src={getKnightIconUrl('blue', 2)} alt="" />
          </div>
        </section>
        {(hasLocal || hasOnline) && (
          <section className="home-continue" aria-labelledby="home-continue-title">
            <div className="home-section-heading">
              <h2 id="home-continue-title">{t('lobby:homeContinueTitle')}</h2>
            </div>
            <div className="home-panels">
              {hasLocal && <LocalSavedGames />}
              {hasOnline && <SavedOnlineGames />}
            </div>
          </section>
        )}
        <HomeModes />
        <section className="home-library" aria-labelledby="home-library-title">
          <div className="home-section-heading">
            <h2 id="home-library-title">{t('lobby:homeLibraryTitle')}</h2>
            <p className="muted">{t('lobby:homeLibraryIntro')}</p>
            <p className="muted home-editor-note">
              {t('lobby:homeEditorNote')}{' '}
              <Link to="/editor" className="text-link">
                {t('lobby:mapEditorLink')}
              </Link>
            </p>
          </div>
          <div className="home-panels">
            <PublicReplayLibrary />
            <ImportedOnlineFullSaves />
            {/* Load errors and unreadable saves stay down here, out of the way. */}
            {!hasLocal && <LocalSavedGames />}
            {!hasOnline && <SavedOnlineGames />}
          </div>
        </section>
      </div>
    </main>
  );
}
