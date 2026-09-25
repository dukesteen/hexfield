import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GameEvent, GameState } from '@cp2p/engine';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { useSessionStore } from '../../store/session-store';
import { diceHistogram, productionBySeat, victoryBreakdown } from './stats';

export function GameOverPanel({
  state,
  events,
  presentation,
  onRematch,
  onExportReplay,
}: {
  state: GameState;
  events: readonly GameEvent[];
  presentation: GamePresentation;
  onRematch: () => Promise<void>;
  onExportReplay: () => Promise<void>;
}) {
  const { t } = useTranslation('game');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const finalHidden = useSessionStore((store) => store.finalHiddenVictoryPoints);
  const dice = diceHistogram(events);
  const peak = Math.max(1, ...dice.map((entry) => entry.count));
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(false);
    try {
      await action();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="game-over-panel" aria-label={t('game:gameOver')}>
      <h2>{t('game:gameOver')}</h2>
      <p>{t('game:finalScore')}</p>
      <div className="final-scores">
        {state.config.seats.map((seat) => {
          const score = victoryBreakdown(state, seat, finalHidden[seat] ?? null);
          const name =
            presentation.players.find((player) => player.seat === seat)?.name ??
            t('game:playerFallback', { number: seat + 1 });
          return (
            <div className="final-score" key={seat}>
              <strong>{name}</strong>
              <b>
                {score.total === null
                  ? t('game:scoreUnknown')
                  : t('game:victoryPoints', { count: score.total })}
              </b>
              <small>{t('game:scoreBreakdown', { ...score, hidden: score.hidden ?? '?' })}</small>
              <small>{t('game:productionTotal', { count: productionBySeat(events, seat) })}</small>
            </div>
          );
        })}
      </div>
      <h3>{t('game:diceHistory')}</h3>
      <div className="dice-histogram" role="img" aria-label={t('game:diceHistory')}>
        {dice.map(({ roll, count }) => (
          <div className="dice-bar" key={roll} title={t('game:diceCount', { roll, count })}>
            <span className="dice-bar-count">{count}</span>
            <span
              className="dice-bar-fill"
              style={{ height: `${Math.round((count / peak) * 72)}px` }}
            />
            <span>{roll}</span>
          </div>
        ))}
      </div>
      <div className="action-row">
        <button
          className="button button-primary"
          type="button"
          disabled={busy}
          onClick={() => void run(onRematch)}
        >
          {t('game:rematch')}
        </button>
        <button
          className="button button-quiet"
          type="button"
          disabled={busy}
          onClick={() => void run(onExportReplay)}
        >
          {t('game:exportReplay')}
        </button>
      </div>
      {error && <p role="alert">{t('game:gameOverActionFailed')}</p>}
    </section>
  );
}
