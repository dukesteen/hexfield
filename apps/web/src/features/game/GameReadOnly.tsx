import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RESOURCES,
  baseLongestRoadLength,
  type CommandShape,
  type GameState,
  type Seat,
} from '@cp2p/engine';
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
import { PlacementConfirmation } from './PlacementConfirmation';
import { useBoardAppearance } from './use-appearance';
import { sessionForActions } from '../../store/session-store';
import { useVisualEffects } from './use-visual-effects';

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

function PlayerRail({
  state,
  presentation,
  activeSeat,
}: {
  state: GameState;
  presentation: GamePresentation;
  activeSeat: Seat;
}) {
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
              data-seat-panel={seatState.seat}
              className={`player-panel ${activeSeat === seatState.seat ? 'is-active' : ''}`}
              aria-label={playerName(presentation, seatState.seat)}
              aria-current={activeSeat === seatState.seat ? 'step' : undefined}
            >
              <div className="player-panel-heading">
                <span
                  className={`player-marker marker-${identity?.shape ?? 'circle'} color-${identity?.color ?? 'blue'}`}
                  aria-hidden="true"
                />
                <strong>{playerName(presentation, seatState.seat)}</strong>
                <SeatTimer seat={seatState.seat} />
                <span
                  className="player-vp"
                  aria-label={t('game:publicVictoryPoints', { count: seatState.publicVp })}
                >
                  {seatState.publicVp} <small>{t('game:vpShort')}</small>
                </span>
              </div>
              <div className="player-panel-status">
                {activeSeat === seatState.seat && <span>{t('game:actingNow')}</span>}
                <span className="connection-status">{t('game:localConnection')}</span>
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
  const optionalViewingSeat = useSessionStore((store) => store.optionalViewingSeat);
  const seatState = state.seats.find((seat) => seat.seat === revealedSeat);
  const cardReason = (slotId: string, card: string, acquiredTurn: number): string | null => {
    if (card === 'Hidden') return t('game:cardUnavailable');
    if (acquiredTurn === state.turn.number && card !== 'victoryPoint') return t('game:newCard');
    if (card === 'victoryPoint') return t('game:vpCardExplanation');
    if (revealedSeat === null) return t('game:cardUnavailable');
    const params =
      card === 'yearOfPlenty'
        ? { resources: { brick: 2, lumber: 0, wool: 0, grain: 0, ore: 0 } }
        : card === 'monopoly'
          ? { resource: 'brick' }
          : undefined;
    const command: CommandShape = {
      type: 'PLAY_DEV_CARD',
      slotId,
      card,
      ...(params ? { params } : {}),
    };
    const valid = sessionForActions()?.validate(revealedSeat, command);
    if (valid?.ok) return null;
    const code = valid?.error.code;
    if (code === 'not-pending') return t('game:cardNotYourTurn');
    if (code === 'dev-card-already-played') return t('game:cardAlreadyPlayed');
    if (code === 'new-dev-card') return t('game:newCard');
    if (code === 'session-paused') return t('game:cardPaused');
    if (code === 'invalid-dev-slot') return t('game:cardSlotUnavailable');
    if (code === 'invalid-dev-params' || code === 'unknown-field')
      return t('game:cardNeedsChoices');
    return t('game:cardRuleUnavailable');
  };
  return (
    <section className="hand-dock" aria-label={t('game:yourHand')}>
      <div className="section-heading">
        <h2>{t('game:yourHand')}</h2>
        {revealedSeat !== null && (
          <div className="hand-controls">
            {optionalViewingSeat !== null && (
              <button
                className="button button-quiet"
                type="button"
                onClick={() => useSessionStore.getState().leaveOptionalSeat()}
              >
                {t('game:returnToBoard')}
              </button>
            )}
            <button
              className="button button-quiet"
              type="button"
              onClick={() => {
                const store = useSessionStore.getState();
                if (optionalViewingSeat !== null) store.leaveOptionalSeat();
                else store.conceal();
              }}
            >
              {t('game:hideHand')}
            </button>
          </div>
        )}
      </div>
      {!privateState || !seatState ? (
        <p className="muted">{t('game:handHidden')}</p>
      ) : (
        <>
          <div className="resource-hand">
            {RESOURCES.map((resource) => (
              <div
                className={`resource-count resource-${resource}`}
                key={resource}
                tabIndex={0}
                title={t('game:resourceInHand', {
                  resource: t(`game:${resource}`),
                  count: privateState.hand[resource] ?? 0,
                })}
                aria-label={t('game:resourceInHand', {
                  resource: t(`game:${resource}`),
                  count: privateState.hand[resource] ?? 0,
                })}
              >
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
                .map((slot) => {
                  const card = privateState.slots[slot.slotId] ?? 'Hidden';
                  const label = t(`game:dev${card}`);
                  const reason = cardReason(slot.slotId, card, slot.acquiredTurn);
                  return (
                    <span
                      className={`development-card ${reason ? 'is-disabled' : ''}`}
                      key={slot.slotId}
                      tabIndex={0}
                      title={reason ?? label}
                      aria-label={reason ? `${label}: ${reason}` : label}
                    >
                      {label}
                      {reason && <small>{reason}</small>}
                    </span>
                  );
                })}
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
  const optionalChoices = useSessionStore((store) => store.optionalChoices);
  const optionalViewingSeat = useSessionStore((store) => store.optionalViewingSeat);
  const { appearance, reducedMotion } = useBoardAppearance(presentation);
  const [renderer, setRenderer] = useState<BoardRenderer | null>(null);
  const boardRef = useRef<HTMLElement>(null);
  const { skip, overlay } = useVisualEffects(renderer, reducedMotion);
  const model = useMemo(() => toRenderModel(state, 'spectator'), [state]);
  const actions = useGameActions(state, pending, presentation);
  const previewPlayer = appearance.players.find((player) => player.seat === actions.actorSeat);
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
        <div className="game-header-controls">
          <TurnTimer />
          <button className="button button-quiet" type="button" onClick={skip}>
            {t('game:skipAnimations')}
          </button>
        </div>
      </header>
      {optionalChoices.length > 0 && optionalViewingSeat === null && (
        <div className="optional-trade-chooser" role="group" aria-label={t('game:optionalTrade')}>
          <span>{t('game:optionalTrade')}</span>
          {optionalChoices.map((seat) => (
            <button
              className="button button-quiet"
              type="button"
              key={seat}
              onClick={() => useSessionStore.getState().viewOptionalSeat(seat)}
            >
              {t('game:viewOptionalTrade', { player: playerName(presentation, seat) })}
            </button>
          ))}
        </div>
      )}
      <div className="game-grid">
        <section ref={boardRef} className="game-board" aria-label={t('game:board')}>
          <BoardView
            model={model}
            appearance={appearance}
            reducedMotion={reducedMotion}
            label={t('game:board')}
            highlights={actions.highlights}
            focusTarget={actions.focusTarget}
            {...(!previewPlayer || !actions.placementConfirmation
              ? {}
              : {
                  focusPreview: {
                    piece: actions.placementConfirmation.piece,
                    color: previewPlayer.color,
                    marker: previewPlayer.marker,
                  },
                })}
            onSelect={(hit) => actions.onBoardSelect(hit)}
            targetLabel={(hit) => actions.targetLabel(hit)}
            onRendererReady={(readyRenderer) => {
              setRenderer(readyRenderer);
              onRendererReady?.(readyRenderer);
            }}
          />
          {actions.placementConfirmation && (
            <PlacementConfirmation
              boardRef={boardRef}
              renderer={renderer}
              hit={actions.placementConfirmation.hit}
              piece={actions.placementConfirmation.piece}
              label={actions.placementConfirmation.label}
              onConfirm={actions.placementConfirmation.confirm}
              onCancel={actions.placementConfirmation.cancel}
            />
          )}
        </section>
        <PlayerRail state={state} presentation={presentation} activeSeat={actions.actorSeat} />
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
      {overlay}
    </div>
  );
}
