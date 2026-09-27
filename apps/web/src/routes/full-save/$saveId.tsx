import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { BoardView } from '../../features/board/BoardView.js';
import { toRenderModel } from '../../features/board/toRenderModel.js';
import { formatGameEvent } from '../../features/game/event-format.js';
import { useBoardAppearance } from '../../features/game/use-appearance.js';
import { useImportedOnlineFullSave } from '../../queries/online-full-saves.js';
import type { OnlineFullSaveDisplay } from '../../session/online-full-save-client.js';
import type { GamePresentation } from '../../queries/repositories/saved-games.js';
import '../replay/replay.css';
import './full-save.css';

const SHAPES = ['circle', 'triangle', 'square', 'diamond'] as const;

export const Route = createFileRoute('/full-save/$saveId')({ component: ImportedFullSavePage });

function ReadOnlyFullSave({ save }: { save: OnlineFullSaveDisplay }) {
  const { t } = useTranslation(['lobby', 'game', 'log']);
  const presentation = useMemo<GamePresentation>(
    () => ({
      players: save.players.map((player) => ({ ...player, shape: SHAPES[player.seat] })),
      botDelayMs: 0,
    }),
    [save.players],
  );
  const { appearance, reducedMotion } = useBoardAppearance(presentation);
  const model = useMemo(() => toRenderModel(save.state, 'spectator'), [save.state]);
  return (
    <main className="app-page public-replay-page imported-full-save-page">
      <header className="app-header">
        <Link to="/" className="text-link">
          {t('lobby:backHome')}
        </Link>
        <h1>{t('lobby:fullSaveOpenTitle')}</h1>
      </header>
      <div className="full-save-readonly-notice">
        <strong>{t('lobby:fullSavePausedTitle')}</strong>
        <p>{t('lobby:fullSavePausedDescription')}</p>
        {save.privateCapsule === 'encrypted' && <p>{t('lobby:fullSavePrivateLocked')}</p>}
      </div>
      <p>{t('lobby:publicReplayHead', { number: save.head.seq })}</p>
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
              {save.events.toReversed().map((event, index) => (
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

function ImportedFullSavePage() {
  const { saveId } = Route.useParams();
  const { t } = useTranslation('lobby');
  const imported = useImportedOnlineFullSave(saveId);
  if (imported.isPending)
    return (
      <p className="app-page" role="status">
        {t('lobby:fullSaveVerifying')}
      </p>
    );
  if (imported.isError || !imported.data)
    return (
      <main className="app-page message-page">
        <h1>{t('lobby:fullSaveOpenFailed')}</h1>
        <Link to="/" className="button button-primary">
          {t('lobby:backHome')}
        </Link>
      </main>
    );
  return <ReadOnlyFullSave save={imported.data} />;
}
