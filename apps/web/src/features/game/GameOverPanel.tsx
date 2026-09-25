import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GameEvent, GameState } from '@cp2p/engine';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { useSessionStore } from '../../store/session-store';
import { diceHistogram, productionBySeat, victoryBreakdown } from './stats';

type Score = ReturnType<typeof victoryBreakdown>;

function ScoreParts({ score }: { score: Score }) {
  const { t } = useTranslation('game');
  return (
    <dl className="results-score-parts">
      <div>
        <dt>{t('game:scoreBuildings')}</dt>
        <dd>{score.buildings}</dd>
      </div>
      <div>
        <dt>{t('game:scoreAwards')}</dt>
        <dd>{score.awards}</dd>
      </div>
      <div>
        <dt>{t('game:scoreVpCards')}</dt>
        <dd>
          {score.vpCards === null
            ? t('game:scoreVpCardsPartial', { count: score.revealed })
            : score.vpCards}
        </dd>
      </div>
    </dl>
  );
}

export function GameOverPanel({
  state,
  events,
  presentation,
  onViewBoard,
  onRematch,
  onExportReplay,
}: {
  state: GameState;
  events: readonly GameEvent[];
  presentation: GamePresentation;
  onViewBoard: () => void;
  onRematch: () => Promise<void>;
  onExportReplay: () => Promise<void>;
}) {
  const { t } = useTranslation('game');
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [statsOpen, setStatsOpen] = useState(
    () => !window.matchMedia('(max-width: 767px), (max-height: 500px)').matches,
  );
  const finalHidden = useSessionStore((store) => store.finalHiddenVictoryPoints);
  const winnerSeat = state.result?.winner;
  const players = state.config.seats.map((seat) => {
    const identity = presentation.players.find((player) => player.seat === seat);
    return {
      seat,
      identity,
      name: identity?.name ?? t('game:playerFallback', { number: seat + 1 }),
      score: victoryBreakdown(state, seat, finalHidden[seat] ?? null),
      production: productionBySeat(events, seat),
    };
  });
  const standings = players.toSorted((a, b) => {
    if (a.seat === winnerSeat) return -1;
    if (b.seat === winnerSeat) return 1;
    if (a.score.total === null) return b.score.total === null ? a.seat - b.seat : 1;
    if (b.score.total === null) return -1;
    return b.score.total - a.score.total || a.seat - b.seat;
  });
  const winner = standings[0];
  const dice = diceHistogram(events);
  const peak = Math.max(1, ...dice.map((entry) => entry.count));
  const topProduction = Math.max(1, ...players.map((player) => player.production));

  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    if (typeof element.showModal === 'function') element.showModal();
    else element.open = true;
    heading.current?.focus({ preventScroll: true });
    return () => {
      if (element.open) element.close?.();
    };
  }, []);

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

  if (!winner || winnerSeat === undefined) return null;
  return (
    <dialog
      ref={dialog}
      className="results-dialog"
      aria-labelledby="results-heading"
      onCancel={(event) => {
        event.preventDefault();
        onViewBoard();
      }}
    >
      <header className="results-header">
        <span className="eyebrow">{t('game:gameOver')}</span>
        <h2 id="results-heading" ref={heading} tabIndex={-1}>
          {t('game:winner', { player: winner.name })}
        </h2>
      </header>
      <div className="results-body">
        <div className="results-layout">
          <section className="results-hero" aria-label={t('game:resultsWinnerScore')}>
            <div className="results-identity">
              <span
                className={`player-marker marker-${winner.identity?.shape ?? 'circle'} color-${winner.identity?.color ?? 'blue'}`}
                aria-hidden="true"
              />
              <strong>{winner.name}</strong>
              <span className="results-winner-badge">{t('game:resultsWinnerBadge')}</span>
            </div>
            <p className="results-total">
              {winner.score.total === null ? (
                t('game:scoreUnknown')
              ) : (
                <>
                  <strong>{winner.score.total}</strong> {t('game:vpShort')}
                </>
              )}
            </p>
            <ScoreParts score={winner.score} />
          </section>

          <section className="results-standings" aria-labelledby="results-standings-heading">
            <h3 id="results-standings-heading">{t('game:standings')}</h3>
            <ol>
              {standings.map((player) => (
                <li className="results-standing" key={player.seat}>
                  <span
                    className={`player-marker marker-${player.identity?.shape ?? 'circle'} color-${player.identity?.color ?? 'blue'}`}
                    aria-hidden="true"
                  />
                  <span className="results-standing-name">
                    <strong>{player.name}</strong>
                    {player.seat === winnerSeat && <small>{t('game:resultsWinnerBadge')}</small>}
                  </span>
                  <span className="results-standing-total">
                    {player.score.total === null ? (
                      t('game:scoreUnknown')
                    ) : (
                      <>
                        {player.score.total} <small>{t('game:vpShort')}</small>
                      </>
                    )}
                  </span>
                  <span className="results-standing-breakdown">
                    {t('game:scoreBuildings')} {player.score.buildings} · {t('game:scoreAwards')}{' '}
                    {player.score.awards} · {t('game:scoreVpCards')}{' '}
                    {player.score.vpCards === null
                      ? t('game:scoreVpCardsPartial', { count: player.score.revealed })
                      : player.score.vpCards}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <details
            className="results-stats"
            open={statsOpen}
            onToggle={(event) => setStatsOpen(event.currentTarget.open)}
          >
            <summary>{t('game:gameStats')}</summary>
            <h3>{t('game:diceHistory')}</h3>
            <ol className="results-dice-histogram">
              {dice.map(({ roll, count }) => (
                <li key={roll} aria-label={t('game:diceCount', { roll, count })}>
                  <span aria-hidden="true">{count}</span>
                  <span
                    className="results-dice-fill"
                    aria-hidden="true"
                    style={{ height: `${Math.round((count / peak) * 88)}px` }}
                  />
                  <span aria-hidden="true">{roll}</span>
                </li>
              ))}
            </ol>
            <h3>{t('game:resourcesProduced')}</h3>
            <ul className="results-production">
              {players.map((player) => (
                <li key={player.seat}>
                  <span>{player.name}</span>
                  <span className="results-production-track">
                    <span style={{ width: `${(player.production / topProduction) * 100}%` }} />
                  </span>
                  <strong>{player.production}</strong>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </div>
      <footer className="results-footer" aria-busy={busy}>
        {error && <p role="alert">{t('game:gameOverActionFailed')}</p>}
        <button className="button button-quiet" type="button" onClick={onViewBoard}>
          {t('game:viewBoard')}
        </button>
        <button
          className="button button-quiet"
          type="button"
          disabled={busy}
          onClick={() => void run(onExportReplay)}
        >
          {t('game:exportReplay')}
        </button>
        <button
          className="button button-primary"
          type="button"
          disabled={busy}
          onClick={() => void run(onRematch)}
        >
          {t('game:rematch')}
        </button>
      </footer>
    </dialog>
  );
}
