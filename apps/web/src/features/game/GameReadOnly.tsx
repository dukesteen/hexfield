import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RESOURCES, baseLongestRoadLength, type GameState, type Seat } from '@cp2p/engine';
import { getResourceIconUrl } from '@cp2p/renderer';
import { BoardView } from '../board/BoardView';
import type { BoardRenderer } from '@cp2p/renderer';
import type { ActionAvailability } from '../actions/availability';
import { toRenderModel } from '../board/toRenderModel';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { useSessionStore } from '../../store/session-store';
import { EventLog } from './EventLog';
import { useGameActions } from './GameActions';
import { GameOverPanel } from './GameOverPanel';
import { useBoardAppearance } from './use-appearance';

function playerName(presentation: GamePresentation, seat: Seat): string {
  return presentation.players.find((player) => player.seat === seat)?.name ?? String(seat + 1);
}

function knightsPlayed(state: GameState, seat: Seat): number {
  const base = state.ext.base;
  if (typeof base !== 'object' || base === null || !('knightsPlayed' in base)) return 0;
  const counts = base.knightsPlayed;
  return Array.isArray(counts) && typeof counts[seat] === 'number' ? counts[seat] : 0;
}

function SeatTimer({ seat }: { seat: Seat }) {
  const { t } = useTranslation('game');
  const timers = useSessionStore((store) => store.timers);
  const pending = useSessionStore((store) => store.pending);
  const [now, setNow] = useState(() => Date.now());
  const timer =
    timers.find((item) => item.seat === seat && !item.paused) ??
    timers.find((item) => item.seat === seat);
  useEffect(() => {
    if (!timer || timer.paused) return () => undefined;
    const handle = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(handle);
  }, [timer]);
  if (!timer) return null;
  const remaining =
    timer.expiresAt === null ? timer.remainingMs : Math.max(0, timer.expiresAt - now);
  const seconds = Math.ceil(remaining / 1000);
  const deadline = pending.find(
    (item) => item.kind === 'player' && item.seat === seat && item.deadline?.phase === timer.phase,
  );
  const duration = deadline?.kind === 'player' ? (deadline.deadline?.seconds ?? seconds) : seconds;
  const percent =
    duration > 0 ? Math.max(0, Math.min(100, (remaining / (duration * 1000)) * 100)) : 0;
  return (
    <span
      className="timer-ring"
      role="timer"
      aria-label={t('game:playerTimer', { count: seconds })}
      style={{
        background: `conic-gradient(var(--accent) ${percent}%, var(--raised) ${percent}% 100%)`,
      }}
    >
      <span>{seconds}</span>
    </span>
  );
}

function PlayerRail({ state, presentation }: { state: GameState; presentation: GamePresentation }) {
  const { t } = useTranslation('game');
  return (
    <aside className="player-rail" aria-label={t('game:players')}>
      <h2>{t('game:players')}</h2>
      <div className="player-list">
        {state.seats.map((seatState) => {
          const identity = presentation.players.find((player) => player.seat === seatState.seat);
          return (
            <section
              key={seatState.seat}
              className={`player-panel ${state.turn.activeSeat === seatState.seat ? 'is-active' : ''}`}
              aria-label={playerName(presentation, seatState.seat)}
            >
              <div className="player-panel-heading">
                <span
                  className={`player-marker marker-${identity?.shape ?? 'circle'} color-${identity?.color ?? 'blue'}`}
                  aria-hidden="true"
                />
                <strong>{playerName(presentation, seatState.seat)}</strong>
                <SeatTimer seat={seatState.seat} />
                <span className="player-vp">{seatState.publicVp}</span>
              </div>
              <div className="player-panel-stats">
                <span>{t('game:resourceCards', { count: seatState.resources.total })}</span>
                <span>
                  {t('game:developmentCards', {
                    count: seatState.cardSlots.filter((slot) => !slot.revealed).length,
                  })}
                </span>
                <span>
                  {t('game:knightsPlayed', { count: knightsPlayed(state, seatState.seat) })}
                </span>
                <span>
                  {t('game:roadLength', { count: baseLongestRoadLength(state, seatState.seat) })}
                </span>
                <span>{t('game:roadsLeft', { count: seatState.piecesLeft.road ?? 0 })}</span>
                <span>
                  {t('game:settlementsLeft', { count: seatState.piecesLeft.settlement ?? 0 })}
                </span>
                <span>{t('game:citiesLeft', { count: seatState.piecesLeft.city ?? 0 })}</span>
              </div>
              {state.awards.longestRoad === seatState.seat && (
                <span className="award-chip">{t('game:longestRoad')}</span>
              )}
              {state.awards.largestArmy === seatState.seat && (
                <span className="award-chip">{t('game:largestArmy')}</span>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function HandDock({ state }: { state: GameState }) {
  const { t } = useTranslation('game');
  const revealedSeat = useSessionStore((store) => store.revealedSeat);
  const privateState = useSessionStore((store) => store.privateState);
  const seatState = state.seats.find((seat) => seat.seat === revealedSeat);
  return (
    <section className="hand-dock" aria-label={t('game:yourHand')}>
      <div className="section-heading">
        <h2>{t('game:yourHand')}</h2>
        {revealedSeat !== null && (
          <button
            className="button button-quiet"
            type="button"
            onClick={() => useSessionStore.getState().conceal()}
          >
            {t('game:hideHand')}
          </button>
        )}
      </div>
      {!privateState || !seatState ? (
        <p className="muted">{t('game:handHidden')}</p>
      ) : (
        <>
          <div className="resource-hand">
            {RESOURCES.map((resource) => (
              <div className={`resource-count resource-${resource}`} key={resource}>
                <span className="resource-count-label">
                  <img src={getResourceIconUrl(resource)} alt="" aria-hidden="true" />
                  {t(`game:${resource}`)}
                </span>
                <strong>{privateState.hand[resource] ?? 0}</strong>
              </div>
            ))}
          </div>
          {seatState.cardSlots.some((slot) => !slot.revealed) && (
            <div className="development-hand">
              {seatState.cardSlots
                .filter((slot) => !slot.revealed)
                .map((slot) => (
                  <span className="development-card" key={slot.slotId}>
                    {t(`game:dev${privateState.slots[slot.slotId] ?? 'Hidden'}`)}
                    {slot.acquiredTurn === state.turn.number && <small>{t('game:newCard')}</small>}
                  </span>
                ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function TurnTimer() {
  const { t } = useTranslation('game');
  const timers = useSessionStore((store) => store.timers);
  const state = useSessionStore((store) => store.state);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (timers.length === 0) return () => undefined;
    const handle = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(handle);
  }, [timers.length]);
  const timer =
    timers.find((entry) => !entry.paused && entry.seat === state?.turn.activeSeat) ??
    timers.find((entry) => !entry.paused) ??
    timers.find((entry) => entry.seat === state?.turn.activeSeat);
  if (!timer) return null;
  if (timer.paused || timer.expiresAt === null) {
    return <span className="turn-timer">{t('game:timerPaused')}</span>;
  }
  const seconds = Math.max(0, Math.ceil((timer.expiresAt - now) / 1000));
  return <span className="turn-timer">{t('game:secondsRemaining', { count: seconds })}</span>;
}

function PrivacyCover({ player, seat }: { player: string; seat: Seat }) {
  const { t } = useTranslation('game');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return () => undefined;
    if (typeof element.showModal === 'function') element.showModal();
    else element.open = true;
    return () => element.close?.();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="privacy-cover"
      aria-labelledby="privacy-title"
      onCancel={(event) => event.preventDefault()}
    >
      <div className="privacy-card">
        <span className="privacy-symbol" aria-hidden="true">
          ◈
        </span>
        <h2 id="privacy-title">{t('game:passToPlayer', { player })}</h2>
        <p>{t('game:privacyInstruction', { player })}</p>
        <button
          className="button button-primary"
          type="button"
          onClick={() => useSessionStore.getState().reveal(seat)}
        >
          {t('game:revealHand')}
        </button>
      </div>
    </dialog>
  );
}

interface GameScreenProps {
  presentation: GamePresentation;
  onRematch: () => Promise<void>;
  onExportReplay: () => Promise<void>;
  onRendererReady?: (renderer: BoardRenderer) => void;
  onActionsChange?: (actions: ActionAvailability | null) => void;
}

export function GameReadOnly({
  presentation,
  onRematch,
  onExportReplay,
  onRendererReady,
  onActionsChange,
}: GameScreenProps) {
  const { t } = useTranslation('game');
  const state = useSessionStore((store) => store.state);
  if (!state) return <p role="status">{t('game:loadingGame')}</p>;
  return (
    <LiveGame
      state={state}
      presentation={presentation}
      onRematch={onRematch}
      onExportReplay={onExportReplay}
      {...(onRendererReady ? { onRendererReady } : {})}
      {...(onActionsChange ? { onActionsChange } : {})}
    />
  );
}

function LiveGame({
  state,
  presentation,
  onRematch,
  onExportReplay,
  onRendererReady,
  onActionsChange,
}: GameScreenProps & { state: GameState }) {
  const { t } = useTranslation('game');
  const events = useSessionStore((store) => store.events);
  const pending = useSessionStore((store) => store.pending);
  const waitingSeat = useSessionStore((store) => store.waitingSeat);
  const revealedSeat = useSessionStore((store) => store.revealedSeat);
  const { appearance, reducedMotion } = useBoardAppearance(presentation);
  const model = useMemo(() => toRenderModel(state, 'spectator'), [state]);
  const actions = useGameActions(state, pending, presentation);
  useEffect(() => onActionsChange?.(actions.availability), [actions.availability, onActionsChange]);
  const activeName = playerName(presentation, actions.actorSeat);
  const winner = state.result ? playerName(presentation, state.result.winner) : null;
  const baseOptions = state.config.options.base;
  const hideBankCounts =
    typeof baseOptions === 'object' &&
    baseOptions !== null &&
    'hideBankCounts' in baseOptions &&
    baseOptions.hideBankCounts === true;

  return (
    <div className="game-page">
      <header className="game-header">
        <div>
          <p className="eyebrow">{t('game:turnNumber', { number: state.turn.number })}</p>
          <h1>
            {winner
              ? t('game:winner', { player: winner })
              : t('game:activePlayer', { player: activeName })}
          </h1>
        </div>
        <TurnTimer />
      </header>
      <div className="game-grid">
        <section className="game-board" aria-label={t('game:board')}>
          <BoardView
            model={model}
            appearance={appearance}
            reducedMotion={reducedMotion}
            label={t('game:board')}
            highlights={actions.highlights}
            onSelect={(hit) => actions.onBoardSelect(hit)}
            targetLabel={(hit) => actions.targetLabel(hit)}
            {...(onRendererReady ? { onRendererReady } : {})}
          />
        </section>
        <PlayerRail state={state} presentation={presentation} />
        <div className="game-bottom">
          <HandDock state={state} />
          {winner ? (
            <GameOverPanel
              state={state}
              events={events}
              presentation={presentation}
              onRematch={onRematch}
              onExportReplay={onExportReplay}
            />
          ) : (
            actions.dock
          )}
          {!hideBankCounts ? (
            <section className="bank-panel" aria-label={t('game:bank')}>
              <h2>{t('game:bank')}</h2>
              <div>
                {RESOURCES.map((resource) => (
                  <span key={resource}>
                    {t(`game:${resource}`)} {state.bank[resource] ?? 0}
                  </span>
                ))}
              </div>
            </section>
          ) : (
            <p className="bank-panel muted">{t('game:bankHidden')}</p>
          )}
          <EventLog events={events} presentation={presentation} />
        </div>
      </div>
      {waitingSeat !== null && revealedSeat === null && !winner && (
        <PrivacyCover player={playerName(presentation, waitingSeat)} seat={waitingSeat} />
      )}
    </div>
  );
}
