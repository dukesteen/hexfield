import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { BoardView } from '../../features/board/BoardView.js';
import { toRenderModel } from '../../features/board/toRenderModel.js';
import { formatGameEvent } from '../../features/game/event-format.js';
import { useBoardAppearance } from '../../features/game/use-appearance.js';
import { usePublicReplay } from '../../queries/online-public-replays.js';
import type { PublicArchiveDisplay } from '../../session/online-public-archive-worker.js';
import type { GamePresentation } from '../../queries/repositories/saved-games.js';
import { replayFailureMessage } from '../../features/online/replay-failure.js';
import './replay.css';
import { PLAYER_SHAPES } from '../../features/players/identity';

const SHAPES = PLAYER_SHAPES;

export const Route = createFileRoute('/replay/$archiveId')({ component: PublicReplayPage });

function VerifiedReplay({ archive }: { archive: PublicArchiveDisplay }) {
  const { t } = useTranslation(['lobby', 'game', 'log']);
  const presentation = useMemo<GamePresentation>(
    () => ({
      players: archive.players.map((player) => ({
        ...player,
        shape: SHAPES[player.seat],
      })),
      botDelayMs: 0,
    }),
    [archive.players],
  );
  const { appearance, reducedMotion } = useBoardAppearance(presentation);
  const model = useMemo(() => toRenderModel(archive.state, 'spectator'), [archive.state]);
  return (
    <main className="app-page public-replay-page">
      <header className="app-header">
        <Link to="/" className="text-link">
          {t('lobby:backHome')}
        </Link>
        <h1>{t('lobby:publicReplayTitle')}</h1>
      </header>
      <p className="muted">{t('lobby:publicReplayReadOnly')}</p>
      <p>{t('lobby:publicReplayHead', { number: archive.head.seq })}</p>
      <div className="public-replay-layout">
        <section aria-label={t('lobby:publicReplayBoard')} className="public-replay-board">
          <BoardView model={model} appearance={appearance} reducedMotion={reducedMotion} />
        </section>
        <aside className="public-replay-sidebar">
          <h2>{t('lobby:publicReplayPlayers')}</h2>
          <ol>
            {presentation.players.map((player) => (
              <li key={player.seat}>{player.name}</li>
            ))}
          </ol>
          <details className="event-log" open>
            <summary>{t('game:eventLog')}</summary>
            <ol>
              {archive.events.toReversed().map((event, index) => (
                <li key={index}>
                  {formatGameEvent(
                    event,
                    t,
                    (seat) =>
                      presentation.players.find((player) => player.seat === seat)?.name ??
                      String(seat + 1),
                  )}
                </li>
              ))}
            </ol>
          </details>
        </aside>
      </div>
    </main>
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
    return (
      <main className="app-page message-page">
        <h1>{replayFailureMessage(replay.error, t)}</h1>
        <Link to="/" className="button button-primary">
          {t('lobby:backHome')}
        </Link>
      </main>
    );
  return <VerifiedReplay archive={replay.data} />;
}
