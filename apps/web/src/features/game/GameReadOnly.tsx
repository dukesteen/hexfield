import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RESOURCES,
  baseLongestRoadLength,
  type CommandShape,
  type GameState,
  type Seat,
} from '@cp2p/engine';
import { BoardView } from '../board/BoardView';
import { ResourceCard } from '../trade/ResourceCard';
import {
  getDevelopmentCardUrl,
  getResourceIconUrl,
  type BoardRenderer,
  type DevelopmentCard,
} from '@cp2p/renderer';
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
import { useVisualEffects, type ProductionReceipt } from './use-visual-effects';
import type { SaveStatus } from './save-coordinator';

function playerName(presentation: GamePresentation, seat: Seat): string {
  return presentation.players.find((player) => player.seat === seat)?.name ?? String(seat + 1);
}

function knightsPlayed(state: GameState, seat: Seat): number {
  const base = state.ext.base;
  if (typeof base !== 'object' || base === null || !('knightsPlayed' in base)) return 0;
  const counts = base.knightsPlayed;
  return Array.isArray(counts) && typeof counts[seat] === 'number' ? counts[seat] : 0;
}

function developmentCardArt(card: string): string | null {
  switch (card) {
    case 'knight':
    case 'roadBuilding':
    case 'yearOfPlenty':
    case 'monopoly':
    case 'victoryPoint':
      return getDevelopmentCardUrl(card satisfies DevelopmentCard);
    default:
      return null;
  }
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
  receipts,
}: {
  state: GameState;
  presentation: GamePresentation;
  activeSeat: Seat;
  receipts: readonly ProductionReceipt[];
}) {
  const { t } = useTranslation('game');
  return (
    <aside className="player-rail" aria-label={t('game:players')}>
      <h2>{t('game:players')}</h2>
      <div className="player-list">
        {state.seats.map((seatState) => {
          const identity = presentation.players.find((player) => player.seat === seatState.seat);
          const receipt = receipts.find((entry) => entry.seat === seatState.seat);
          const gains = receipt
            ? RESOURCES.flatMap((resource) => {
                const count = receipt.resources[resource];
                return count && count > 0 ? [{ resource, count }] : [];
              })
            : [];
          return (
            <section
              key={seatState.seat}
              data-seat-panel={seatState.seat}
              className={`player-panel ${activeSeat === seatState.seat ? 'is-active' : ''} ${gains.length ? 'has-receipt' : ''}`}
              aria-label={playerName(presentation, seatState.seat)}
              aria-current={activeSeat === seatState.seat ? 'step' : undefined}
            >
              <div className="player-panel-heading">
                <span
                  className={`player-marker marker-${identity?.shape ?? 'circle'} color-${identity?.color ?? 'blue'}`}
                  aria-hidden="true"
                />
                <strong>{playerName(presentation, seatState.seat)}</strong>
                <span className="player-seat-index" aria-hidden="true">
                  {t('game:playerShort', { number: seatState.seat + 1 })}
                </span>
                <SeatTimer seat={seatState.seat} />
                <span
                  className="player-vp"
                  aria-label={t('game:publicVictoryPoints', { count: seatState.publicVp })}
                >
                  {seatState.publicVp} <small>{t('game:vpShort')}</small>
                </span>
              </div>
              <div className="player-panel-status">
                {gains.length ? (
                  <span
                    className="production-receipt"
                    role="status"
                    aria-label={t('game:recentGains', {
                      resources: gains
                        .map(({ resource, count }) => `${count} ${t(`game:${resource}`)}`)
                        .join(', '),
                    })}
                  >
                    <span className="receipt-label">{t('game:recentGainsLabel')}</span>
                    {gains.map(({ resource, count }) => (
                      <span
                        className="receipt-resource"
                        key={resource}
                        tabIndex={0}
                        title={t('game:resourceGain', {
                          count,
                          resource: t(`game:${resource}`),
                        })}
                        aria-label={t('game:resourceGain', {
                          count,
                          resource: t(`game:${resource}`),
                        })}
                      >
                        <img src={getResourceIconUrl(resource)} alt="" aria-hidden="true" />
                        <b>+{count}</b>
                      </span>
                    ))}
                  </span>
                ) : (
                  <>
                    {activeSeat === seatState.seat && <span>{t('game:actingNow')}</span>}
                    <span className="connection-status">{t('game:localConnection')}</span>
                  </>
                )}
              </div>
              <dl className="player-panel-stats">
                <div title={t('game:resourceCards', { count: seatState.resources.total })}>
                  <dt>{t('game:statCards')}</dt>
                  <dd>{seatState.resources.total}</dd>
                </div>
                <div
                  title={t('game:developmentCards', {
                    count: seatState.cardSlots.filter((slot) => !slot.revealed).length,
                  })}
                >
                  <dt>{t('game:statDev')}</dt>
                  <dd>{seatState.cardSlots.filter((slot) => !slot.revealed).length}</dd>
                </div>
                <div
                  title={t('game:knightsPlayed', { count: knightsPlayed(state, seatState.seat) })}
                >
                  <dt>{t('game:statKnights')}</dt>
                  <dd>{knightsPlayed(state, seatState.seat)}</dd>
                </div>
                <div
                  title={t('game:roadLength', {
                    count: baseLongestRoadLength(state, seatState.seat),
                  })}
                >
                  <dt>{t('game:statRoad')}</dt>
                  <dd>{baseLongestRoadLength(state, seatState.seat)}</dd>
                </div>
              </dl>
              <details className="player-pieces">
                <summary>{t('game:piecesLeft')}</summary>
                <span>{t('game:roadsLeft', { count: seatState.piecesLeft.road ?? 0 })}</span>
                <span>
                  {t('game:settlementsLeft', { count: seatState.piecesLeft.settlement ?? 0 })}
                </span>
                <span>{t('game:citiesLeft', { count: seatState.piecesLeft.city ?? 0 })}</span>
              </details>
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
  const developmentDialog = useRef<HTMLDialogElement>(null);
  const [compactHand, setCompactHand] = useState(
    () => window.matchMedia('(max-width: 767px), (max-height: 500px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px), (max-height: 500px)');
    const update = () => setCompactHand(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    developmentDialog.current?.close();
  }, [revealedSeat]);
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
  const developmentCards =
    seatState?.cardSlots
      .filter((slot) => !slot.revealed)
      .map((slot) => {
        const card = privateState?.slots[slot.slotId] ?? 'Hidden';
        const label = t(`game:dev${card}`);
        const reason = cardReason(slot.slotId, card, slot.acquiredTurn);
        const art = developmentCardArt(card);
        return (
          <span
            className={`development-card ${reason && card !== 'victoryPoint' ? 'is-disabled' : ''}`}
            key={slot.slotId}
            tabIndex={0}
            title={reason ?? label}
            aria-label={reason ? `${label}: ${reason}` : label}
          >
            {art && <img src={art} alt="" aria-hidden="true" draggable={false} />}
            <strong>{label}</strong>
          </span>
        );
      }) ?? [];
  return (
    <section className="hand-dock" aria-label={t('game:yourHand')}>
      <div className="section-heading">
        <h2>{t('game:yourHand')}</h2>
        {revealedSeat !== null && (
          <div className="hand-controls">
            {compactHand && privateState && developmentCards.length > 0 && (
              <button
                className="button button-quiet"
                type="button"
                aria-label={t('game:developmentCards', { count: developmentCards.length })}
                onClick={() => {
                  if (developmentDialog.current && !developmentDialog.current.open)
                    developmentDialog.current.showModal();
                }}
              >
                {t('game:devCardsShort', { count: developmentCards.length })}
              </button>
            )}
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
                className="resource-hand-card"
                key={resource}
                data-empty={(privateState.hand[resource] ?? 0) === 0}
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
                <ResourceCard resource={resource} count={privateState.hand[resource] ?? 0} />
              </div>
            ))}
          </div>
          {!compactHand && developmentCards.length > 0 && (
            <div className="development-hand">{developmentCards}</div>
          )}
          {compactHand && developmentCards.length > 0 && (
            <dialog
              ref={developmentDialog}
              className="development-dialog"
              aria-labelledby="development-dialog-title"
            >
              <h2 id="development-dialog-title">
                {t('game:developmentCards', { count: developmentCards.length })}
              </h2>
              <div className="development-hand">{developmentCards}</div>
              <button
                className="button button-quiet"
                type="button"
                onClick={() => developmentDialog.current?.close()}
              >
                {t('game:closeDevCards')}
              </button>
            </dialog>
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
  saveStatus: SaveStatus;
  onLeave: () => void;
  devTools?: React.ReactNode;
  onRematch: () => Promise<void>;
  onExportReplay: () => Promise<void>;
  onRendererReady?: (renderer: BoardRenderer) => void;
  onActionsChange?: (actions: ActionAvailability | null) => void;
}

export function GameReadOnly({
  presentation,
  saveStatus,
  onLeave,
  devTools,
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
      saveStatus={saveStatus}
      onLeave={onLeave}
      {...(devTools ? { devTools } : {})}
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
  saveStatus,
  onLeave,
  devTools,
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
  const [gameInfoOpen, setGameInfoOpen] = useState(
    () => !window.matchMedia('(max-width: 767px), (max-height: 500px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px), (max-height: 500px)');
    const update = () => setGameInfoOpen(!media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const [renderer, setRenderer] = useState<BoardRenderer | null>(null);
  const boardRef = useRef<HTMLElement>(null);
  const { skip, overlay, receipts } = useVisualEffects(renderer, reducedMotion);
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
      <details className="game-menu">
        <summary aria-label={t('game:openMenu')}>
          <span aria-hidden="true">☰</span>
        </summary>
        <div className="game-menu-panel">
          <strong>{t('game:gameTitle')}</strong>
          <p>{t('game:turnNumber', { number: state.turn.number })}</p>
          <p>
            {winner
              ? t('game:winner', { player: winner })
              : t('game:activePlayer', { player: activeName })}
          </p>
          <span className={`save-indicator status-${saveStatus}`} role="status">
            {saveStatus === 'saved'
              ? t('game:saveStatus')
              : saveStatus === 'saving'
                ? t('game:saving')
                : t('game:saveError')}
          </span>
          <TurnTimer />
          <button className="button button-quiet" type="button" onClick={skip}>
            {t('game:skipAnimations')}
          </button>
          <button className="button button-quiet" type="button" onClick={onLeave}>
            {t('game:leaveGame')}
          </button>
          {devTools}
        </div>
      </details>
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
          {actions.offerOverlay && <div className="board-offers">{actions.offerOverlay}</div>}
        </section>
        <aside className="game-sidebar" aria-label={t('game:players')}>
          <PlayerRail
            state={state}
            presentation={presentation}
            activeSeat={actions.actorSeat}
            receipts={receipts}
          />
          <details
            className="game-info"
            open={gameInfoOpen}
            onToggle={(event) => setGameInfoOpen(event.currentTarget.open)}
          >
            <summary>{t('game:gameInfo')}</summary>
            {!hideBankCounts ? (
              <section className="bank-panel" aria-label={t('game:bank')}>
                <h2>{t('game:bank')}</h2>
                <div className="bank-cards">
                  {RESOURCES.map((resource) => (
                    <span
                      className="bank-card"
                      key={resource}
                      tabIndex={0}
                      aria-label={t('game:resourceInBank', {
                        resource: t(`game:${resource}`),
                        count: state.bank[resource] ?? 0,
                      })}
                    >
                      <ResourceCard
                        resource={resource}
                        count={state.bank[resource] ?? 0}
                        size="sm"
                      />
                    </span>
                  ))}
                </div>
              </section>
            ) : (
              <p className="bank-panel muted">{t('game:bankHidden')}</p>
            )}
            <EventLog events={events} presentation={presentation} />
          </details>
        </aside>
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
        </div>
      </div>
      {waitingSeat !== null && revealedSeat === null && !winner && (
        <PrivacyCover player={playerName(presentation, waitingSeat)} seat={waitingSeat} />
      )}
      {overlay}
    </div>
  );
}
