import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RESOURCES, type CommandShape, type GameState, type Seat } from '@cp2p/engine';
import { BoardView } from '../board/BoardView';
import { ResourceCard } from '../trade/ResourceCard';
import {
  getDevelopmentCardUrl,
  getGameArtUrl,
  getPieceIconUrl,
  getResourceIconUrl,
  getShipIconUrl,
  type BoardRenderer,
  type DevelopmentCard,
} from '@cp2p/renderer';
import type { ActionAvailability } from '../actions/availability';
import { toRenderModel } from '../board/toRenderModel';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { useSessionStore } from '../../store/session-store';
import { EventLog } from './EventLog';
import { CheatFlag, FairnessStatus } from './FairnessStatus.js';
import { useGameActions, type GameActionController } from './GameActions';
import { GameOverPanel } from './GameOverPanel';
import { PlacementConfirmation } from './PlacementConfirmation';
import { useBoardAppearance } from './use-appearance';
import { sessionForActions } from '../../store/session-store';
import { useVisualEffects, type ProductionReceipt } from './use-visual-effects';
import { DiceRollReadout, latestDiceRoll } from './DiceRollReadout.js';
import { CockpitSheet } from './CockpitSheet.js';
import { PlayerMarker } from './PlayerMarker.js';
import { MobileGameControls, type MobileTab } from './MobileGameControls.js';
import { useCompactCockpit } from './use-compact-cockpit.js';
import type { SaveStatus } from './save-coordinator';
import { AwardsPanel } from './AwardsPanel';
import { ModuleHud } from '../modules/ModuleHud';
import { ModulePanelExtras } from '../modules/ModulePanelExtras';
import { isSeafaring, routeLength } from './seafaring';
import { FixtureDialog } from '../modules/FixtureDialog';
import type { KnightsController } from '../knights/controller';
import { ImprovementsBoard } from '../knights/ImprovementsBoard';
import { ImprovementsStrip } from '../knights/ImprovementsStrip';
import { ProgressHand } from '../knights/ProgressHand';
import { ProgressCardBack } from '../knights/ProgressCardFace';
import { TRACKS, cardKinds, isCommodity, isKnights, progressHeld } from '../knights/state';
import type { Track } from '../knights/state';

const MAX_INLINE_DEVELOPMENT_CARDS = 5;
const MAX_NARROW_INLINE_DEVELOPMENT_CARDS = 3;

function playerName(presentation: GamePresentation, seat: Seat): string {
  return presentation.players.find((player) => player.seat === seat)?.name ?? String(seat + 1);
}

/** The name of a card kind: a resource, or a commodity in a knights game. */
function kindLabel(t: (key: string) => string, kind: string): string {
  return isCommodity(kind) ? t(`knights:commodity.${kind}`) : t(`game:${kind}`);
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
  compact,
  connectionLabels,
  onOpenPlayer,
}: {
  state: GameState;
  presentation: GamePresentation;
  activeSeat: Seat;
  receipts: readonly ProductionReceipt[];
  compact: boolean;
  connectionLabels?: Partial<Record<Seat, string>>;
  onOpenPlayer: (seat: Seat, trigger: HTMLButtonElement) => void;
}) {
  const { t } = useTranslation('game');
  const revealedSeat = useSessionStore((store) => store.revealedSeat);
  const base = state.config.options.base;
  const target =
    typeof base === 'object' && base !== null && 'vpTarget' in base ? base.vpTarget : 10;
  const seafaring = isSeafaring(state);
  const knightsGame = isKnights(state);
  return (
    <aside className="player-rail" aria-label={t('game:players')}>
      <div className="player-rail-heading">
        <h2>{t('game:players')}</h2>
        {typeof target === 'number' && <span>{t('game:vpToWin', { count: target })}</span>}
      </div>
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
          const pieces = [
            {
              kind: 'road',
              count: seatState.piecesLeft.road ?? 0,
              label: t('game:roadsLeft', { count: seatState.piecesLeft.road ?? 0 }),
            },
            {
              kind: 'settlement',
              count: seatState.piecesLeft.settlement ?? 0,
              label: t('game:settlementsLeft', { count: seatState.piecesLeft.settlement ?? 0 }),
            },
            {
              kind: 'city',
              count: seatState.piecesLeft.city ?? 0,
              label: t('game:citiesLeft', { count: seatState.piecesLeft.city ?? 0 }),
            },
            ...(seafaring
              ? [
                  {
                    kind: 'ship' as const,
                    count: seatState.piecesLeft.ship ?? 0,
                    label: t('game:shipsLeft', { count: seatState.piecesLeft.ship ?? 0 }),
                  },
                ]
              : []),
          ] as const;
          return (
            <section
              key={seatState.seat}
              data-seat-panel={seatState.seat}
              className={`player-panel ${activeSeat === seatState.seat ? 'is-active' : ''} ${gains.length ? 'has-receipt' : ''}`}
              aria-label={playerName(presentation, seatState.seat)}
              aria-current={activeSeat === seatState.seat ? 'step' : undefined}
            >
              {activeSeat === seatState.seat && (
                <img
                  className="player-turn-marker"
                  src={getGameArtUrl('turnMarker')}
                  alt=""
                  aria-hidden="true"
                />
              )}
              <div className="player-panel-heading">
                <PlayerMarker
                  shape={identity?.shape ?? 'circle'}
                  color={identity?.color ?? 'blue'}
                />
                <strong>{playerName(presentation, seatState.seat)}</strong>
                {revealedSeat === seatState.seat && (
                  <span className="player-you">{t('game:you')}</span>
                )}
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
                <CheatFlag seat={seatState.seat} />
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
                        tabIndex={compact ? -1 : 0}
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
                    <span className="connection-status">
                      {connectionLabels?.[seatState.seat] ?? t('game:localConnection')}
                    </span>
                  </>
                )}
              </div>
              <dl className="player-panel-stats">
                <div title={t('game:resourceCards', { count: seatState.resources.total })}>
                  <dt>{t('game:statCards')}</dt>
                  <dd>{seatState.resources.total}</dd>
                </div>
                {!knightsGame && (
                  <>
                    <div
                      title={t('game:developmentCards', {
                        count: seatState.cardSlots.filter((slot) => !slot.revealed).length,
                      })}
                    >
                      <dt>{t('game:statDev')}</dt>
                      <dd>{seatState.cardSlots.filter((slot) => !slot.revealed).length}</dd>
                    </div>
                    <div
                      title={t('game:knightsPlayed', {
                        count: knightsPlayed(state, seatState.seat),
                      })}
                    >
                      <dt>{t('game:statKnights')}</dt>
                      <dd>{knightsPlayed(state, seatState.seat)}</dd>
                    </div>
                  </>
                )}
                <div
                  title={t('game:roadLength', {
                    count: routeLength(state, seatState.seat),
                  })}
                >
                  <dt>{seafaring ? t('game:statRoute') : t('game:statRoad')}</dt>
                  <dd>{routeLength(state, seatState.seat)}</dd>
                </div>
              </dl>
              <div className="player-piece-counts" role="group" aria-label={t('game:piecesLeft')}>
                {pieces.map(({ kind, count, label }) => (
                  <span
                    className="player-piece-count"
                    role="img"
                    aria-label={label}
                    title={label}
                    key={kind}
                  >
                    <img
                      src={
                        kind === 'ship'
                          ? getShipIconUrl(identity?.color)
                          : getPieceIconUrl(kind, identity?.color)
                      }
                      alt=""
                      aria-hidden="true"
                    />
                    <span aria-hidden="true">{count}</span>
                  </span>
                ))}
              </div>
              {state.awards.longestRoad === seatState.seat && (
                <span className="award-chip">
                  {seafaring ? t('game:longestTradeRoute') : t('game:longestRoad')}
                </span>
              )}
              <ModulePanelExtras state={state} seat={seatState.seat} presentation={presentation} />
              {state.awards.largestArmy === seatState.seat && (
                <span className="award-chip">{t('game:largestArmy')}</span>
              )}
              {compact && (
                <button
                  className="player-panel-open"
                  type="button"
                  aria-haspopup="dialog"
                  aria-label={t('game:cockpit.openPlayerDetails', {
                    player: playerName(presentation, seatState.seat),
                  })}
                  onClick={(event) => onOpenPlayer(seatState.seat, event.currentTarget)}
                />
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function PlayerDetails({
  state,
  seat,
  presentation,
  receipt,
  activeSeat,
  connectionLabels,
  summary = false,
}: {
  state: GameState;
  seat: Seat;
  presentation: GamePresentation;
  receipt: ProductionReceipt | undefined;
  activeSeat: Seat;
  connectionLabels?: Partial<Record<Seat, string>>;
  summary?: boolean;
}) {
  const { t } = useTranslation('game');
  const publicSeat = state.seats.find((item) => item.seat === seat);
  if (!publicSeat) return null;
  const identity = presentation.players.find((player) => player.seat === seat);
  const gains = RESOURCES.flatMap((resource) => {
    const count = receipt?.resources[resource];
    return count && count > 0 ? [{ resource, count }] : [];
  });
  const seafaring = isSeafaring(state);
  const awards = [
    state.awards.longestRoad === seat
      ? seafaring
        ? t('game:longestTradeRoute')
        : t('game:longestRoad')
      : null,
    state.awards.largestArmy === seat ? t('game:largestArmy') : null,
  ].filter((award) => award !== null);
  return (
    <section className="player-details" data-active={activeSeat === seat}>
      <div className="player-details-head">
        <PlayerMarker shape={identity?.shape ?? 'circle'} color={identity?.color ?? 'blue'} />
        <strong>{identity?.name ?? t('game:playerFallback', { number: seat + 1 })}</strong>
        <SeatTimer seat={seat} />
        <span
          className="player-vp"
          aria-label={t('game:publicVictoryPoints', { count: publicSeat.publicVp })}
        >
          {publicSeat.publicVp} <small>{t('game:vpShort')}</small>
        </span>
      </div>
      <CheatFlag seat={seat} />
      <dl className="player-details-stats">
        <div>
          <dt>{t(summary ? 'game:statCards' : 'game:cockpit.resourceCards')}</dt>
          <dd>{publicSeat.resources.total}</dd>
        </div>
        {!isKnights(state) && (
          <>
            <div>
              <dt>{t(summary ? 'game:statDev' : 'game:cockpit.developmentCards')}</dt>
              <dd>{publicSeat.cardSlots.filter((slot) => !slot.revealed).length}</dd>
            </div>
            <div>
              <dt>{t(summary ? 'game:statKnights' : 'game:cockpit.knightsPlayed')}</dt>
              <dd>{knightsPlayed(state, seat)}</dd>
            </div>
          </>
        )}
        <div>
          <dt>
            {t(
              summary
                ? seafaring
                  ? 'game:statRoute'
                  : 'game:statRoad'
                : 'game:cockpit.longestRoute',
            )}
          </dt>
          <dd>{routeLength(state, seat)}</dd>
        </div>
      </dl>
      <h3>{t('game:piecesLeft')}</h3>
      <div className="player-details-pieces">
        {(seafaring
          ? (['road', 'settlement', 'city', 'ship'] as const)
          : (['road', 'settlement', 'city'] as const)
        ).map((piece) => {
          const count = publicSeat.piecesLeft[piece] ?? 0;
          const label = t(
            `game:${piece === 'road' ? 'roadsLeft' : piece === 'settlement' ? 'settlementsLeft' : piece === 'city' ? 'citiesLeft' : 'shipsLeft'}`,
            { count },
          );
          return (
            <span role="img" aria-label={label} key={piece}>
              <img
                src={
                  piece === 'ship'
                    ? getShipIconUrl(identity?.color)
                    : getPieceIconUrl(piece, identity?.color)
                }
                alt=""
                aria-hidden="true"
              />
              <b aria-hidden="true">{count}</b>
            </span>
          );
        })}
      </div>
      <h3>{t('game:cockpit.awards')}</h3>
      <p>{awards.length ? awards.join(' · ') : t('game:cockpit.noAwards')}</p>
      <ModulePanelExtras state={state} seat={seat} presentation={presentation} />
      <h3>{t('game:cockpit.status')}</h3>
      <p>
        {activeSeat === seat
          ? t('game:actingNow')
          : (connectionLabels?.[seat] ?? t('game:localConnection'))}
      </p>
      <h3>{t('game:recentGainsLabel')}</h3>
      <div className="player-details-gains" aria-live="polite">
        {gains.length
          ? gains.map(({ resource, count }) => (
              <span
                key={resource}
                role="img"
                aria-label={t('game:resourceGain', { count, resource: t(`game:${resource}`) })}
              >
                <img src={getResourceIconUrl(resource)} alt="" aria-hidden="true" />
                <b aria-hidden="true">+{count}</b>
              </span>
            ))
          : t('game:cockpit.noRecentGains')}
      </div>
    </section>
  );
}

function HandDock({
  state,
  knightIntent,
  toggleKnightIntent,
  compact,
  submitting,
  knights,
}: {
  state: GameState;
  knights: KnightsController | null;
  knightIntent: GameActionController['knightIntent'];
  toggleKnightIntent: GameActionController['toggleKnightIntent'];
  compact: boolean;
  submitting: boolean;
}) {
  const { t } = useTranslation('game');
  const revealedSeat = useSessionStore((store) => store.revealedSeat);
  const privateState = useSessionStore((store) => store.privateState);
  const optionalViewingSeat = useSessionStore((store) => store.optionalViewingSeat);
  const allowManualHide = (sessionForActions()?.controllableSeats().length ?? 0) > 1;
  const developmentDialog = useRef<HTMLDialogElement>(null);
  const intentOpenedDialog = useRef(false);
  const closeAfterKnightCommit = useRef(false);
  const [compactHand, setCompactHand] = useState(
    () => window.matchMedia('(max-width: 767px), (max-height: 500px), (pointer: coarse)').matches,
  );
  const [narrowHand, setNarrowHand] = useState(
    () => window.matchMedia('(min-width: 768px) and (max-width: 1000px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px), (max-height: 500px), (pointer: coarse)');
    const update = () => setCompactHand(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px) and (max-width: 1000px)');
    const update = () => setNarrowHand(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    developmentDialog.current?.close();
  }, [revealedSeat]);
  const seatState = state.seats.find((seat) => seat.seat === revealedSeat);
  const unrevealedSlots =
    seatState?.cardSlots.filter((slot) => !slot.revealed && !slot.deck.startsWith('progress-')) ??
    [];
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
    const session = sessionForActions();
    if (session?.mode === 'p2p') {
      const legal = session
        .getLegalCommands(revealedSeat)
        .commands.some(
          (candidate) =>
            candidate.type === 'PLAY_DEV_CARD' &&
            candidate.slotId === slotId &&
            candidate.card === card,
        );
      return legal ? null : t('game:cardRuleUnavailable');
    }
    const valid = session?.validate(revealedSeat, command);
    if (valid && 'then' in valid) return t('game:cardRuleUnavailable');
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
  const developmentCards = unrevealedSlots.map((slot) => {
    const card = privateState?.slots[slot.slotId] ?? 'Hidden';
    const label = t(`game:dev${card}`);
    const reason = cardReason(slot.slotId, card, slot.acquiredTurn);
    const art = developmentCardArt(card);
    const body = (
      <>
        <span className="development-card-art">
          {art && <img src={art} alt="" aria-hidden="true" draggable={false} />}
        </span>
        <strong>{label}</strong>
      </>
    );
    return (
      <span
        className={`development-card ${reason && card !== 'victoryPoint' ? 'is-disabled' : ''} ${knightIntent?.slotId === slot.slotId ? 'has-knight-intent' : ''}`}
        key={slot.slotId}
      >
        {card === 'knight' && reason === null ? (
          <button
            className="development-card-main"
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={knightIntent?.slotId === slot.slotId}
            disabled={submitting}
            onClick={() => toggleKnightIntent(slot.slotId)}
          >
            {body}
          </button>
        ) : (
          <span
            className="development-card-main"
            tabIndex={0}
            title={reason ?? label}
            aria-label={reason ? `${label}: ${reason}` : label}
          >
            {body}
          </span>
        )}
        {card === 'knight' && knightIntent?.slotId === slot.slotId && (
          <span
            className="knight-card-confirmation"
            role="group"
            aria-label={t('game:knightPreview')}
          >
            <button
              className="knight-card-choice knight-card-cancel"
              type="button"
              disabled={submitting}
              aria-label={t('game:cancelKnight')}
              title={t('game:cancelKnight')}
              onClick={() => {
                closeAfterKnightCommit.current = false;
                knightIntent.cancel();
              }}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <path d="M5 5 15 15M15 5 5 15" />
              </svg>
            </button>
            <button
              className="knight-card-choice knight-card-confirm"
              type="button"
              disabled={submitting}
              aria-label={t('game:playCard', { card: t('game:devknight') })}
              title={t('game:playCard', { card: t('game:devknight') })}
              onClick={() => {
                closeAfterKnightCommit.current = developmentDialog.current?.open ?? false;
                knightIntent.confirm();
              }}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <path d="m4 10 4 4 8-8" />
              </svg>
            </button>
          </span>
        )}
      </span>
    );
  });
  const inlineCardLimit = narrowHand
    ? MAX_NARROW_INLINE_DEVELOPMENT_CARDS
    : MAX_INLINE_DEVELOPMENT_CARDS;
  const useDevelopmentDialog = compactHand || developmentCards.length > inlineCardLimit;
  const visibleDevelopmentCards = compact
    ? developmentCards
    : developmentCards.slice(0, inlineCardLimit);
  const activeKnightSlot = knightIntent?.slotId;
  const activeKnightIsOverflow =
    activeKnightSlot !== undefined &&
    unrevealedSlots.findIndex((slot) => slot.slotId === activeKnightSlot) >= inlineCardLimit;
  useEffect(() => {
    const dialog = developmentDialog.current;
    if (!dialog || !useDevelopmentDialog) return;
    if (activeKnightSlot && (compactHand || activeKnightIsOverflow)) {
      if (!dialog.open) {
        dialog.showModal();
        intentOpenedDialog.current = true;
      }
    } else if (intentOpenedDialog.current || closeAfterKnightCommit.current) {
      if (dialog.open) dialog.close();
      intentOpenedDialog.current = false;
      closeAfterKnightCommit.current = false;
    }
  }, [activeKnightSlot, activeKnightIsOverflow, compactHand, useDevelopmentDialog]);
  return (
    <section className="hand-dock" aria-label={t('game:yourHand')}>
      <div className="section-heading">
        <h2>{t('game:yourHand')}</h2>
        {privateState && (
          <span className="hand-total">
            {t('game:handCardCount', {
              count: Object.values(privateState.hand).reduce((sum, count) => sum + count, 0),
            })}
            {compact && (
              <span className="hand-dev-total">
                {' '}
                ·{' '}
                {isKnights(state)
                  ? t('knights:progress.count', { count: progressHeld(state, revealedSeat ?? 0) })
                  : t('game:mobileDevCount', { count: developmentCards.length })}
              </span>
            )}
          </span>
        )}
        {revealedSeat !== null && (
          <div className="hand-controls">
            {compact && (
              <button
                className="button button-quiet hand-dev-control"
                type="button"
                aria-label={t('game:developmentCards', { count: developmentCards.length })}
                disabled={developmentCards.length === 0}
                onClick={() => {
                  if (developmentDialog.current && !developmentDialog.current.open)
                    developmentDialog.current.showModal();
                }}
              >
                <span>{t('game:cockpit.devTile')}</span>
                <b>{developmentCards.length}</b>
              </button>
            )}
            {!compact && useDevelopmentDialog && privateState && developmentCards.length > 0 && (
              <button
                className="button button-quiet"
                type="button"
                aria-label={t('game:developmentCards', { count: developmentCards.length })}
                onClick={() => {
                  if (developmentDialog.current && !developmentDialog.current.open)
                    developmentDialog.current.showModal();
                }}
              >
                {t('game:developmentCards', { count: developmentCards.length })}
              </button>
            )}
            {!compact && optionalViewingSeat !== null && (
              <button
                className="button button-quiet"
                type="button"
                onClick={() => useSessionStore.getState().leaveOptionalSeat()}
              >
                {t('game:returnToBoard')}
              </button>
            )}
            {allowManualHide && (
              <button
                className="button button-quiet hand-hide-control"
                type="button"
                aria-label={t('game:hideHand')}
                title={t('game:hideHand')}
                onClick={() => {
                  const store = useSessionStore.getState();
                  if (optionalViewingSeat !== null) store.leaveOptionalSeat();
                  else store.conceal();
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
                  <path
                    d="M3 3 21 21M10.6 5.2A10.8 10.8 0 0 1 12 5c4.6 0 8.5 2.7 10 7-0.5 1.2-1.2 2.2-2.2 3.2M6.2 6.3C4.4 7.5 3 9.5 2 12c1.5 4.3 5.4 7 10 7 1.8 0 3.5-0.4 4.9-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
      {!privateState || !seatState ? (
        <p className="muted">{t('game:handHidden')}</p>
      ) : (
        <>
          <div className="hand-cards">
            <div className="resource-hand">
              {cardKinds(state).map((resource) => (
                <div
                  className="resource-hand-card"
                  key={resource}
                  data-empty={(privateState.hand[resource] ?? 0) === 0}
                  data-commodity={isCommodity(resource)}
                  tabIndex={0}
                  title={t('game:resourceInHand', {
                    resource: kindLabel(t, resource),
                    count: privateState.hand[resource] ?? 0,
                  })}
                  aria-label={t('game:resourceInHand', {
                    resource: kindLabel(t, resource),
                    count: privateState.hand[resource] ?? 0,
                  })}
                >
                  <ResourceCard resource={resource} count={privateState.hand[resource] ?? 0} />
                </div>
              ))}
            </div>
            {isKnights(state) && revealedSeat !== null && (
              <ProgressHand
                state={state}
                seat={revealedSeat}
                priv={privateState}
                controller={knights}
              />
            )}
            {(compact || !compactHand) && developmentCards.length > 0 && (
              <div
                className={`development-hand ${developmentCards.length > 2 ? 'is-fanned' : ''} ${knightIntent ? 'has-knight-intent' : ''}`}
                data-card-count={visibleDevelopmentCards.length}
              >
                {visibleDevelopmentCards}
              </div>
            )}
          </div>
          {useDevelopmentDialog && developmentCards.length > 0 && (
            <dialog
              ref={developmentDialog}
              className="development-dialog"
              aria-labelledby="development-dialog-title"
              aria-busy={submitting}
              onCancel={(event) => {
                if (submitting) {
                  event.preventDefault();
                  return;
                }
                if (knightIntent) {
                  event.preventDefault();
                  closeAfterKnightCommit.current = false;
                  knightIntent.cancel();
                  developmentDialog.current?.close();
                }
              }}
              onClose={() => {
                intentOpenedDialog.current = false;
                closeAfterKnightCommit.current = false;
              }}
            >
              <h2 id="development-dialog-title">
                {t('game:developmentCards', { count: developmentCards.length })}
              </h2>
              {submitting && (
                <p className="action-pending" role="status">
                  <span className="action-spinner" aria-hidden="true" />
                  {t('game:submittingAction')}
                </p>
              )}
              <div className="development-hand">{developmentCards}</div>
              <button
                className="button button-quiet"
                type="button"
                disabled={submitting}
                onClick={() => {
                  closeAfterKnightCommit.current = false;
                  knightIntent?.cancel();
                  developmentDialog.current?.close();
                }}
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
  gameTitle?: string;
  connectionLabels?: Partial<Record<Seat, string>>;
  sessionNotice?: ReactNode;
  resultNotice?: ReactNode;
  menuActions?: ReactNode;
  devTools?: React.ReactNode;
  onRematch?: () => Promise<void>;
  onExportReplay: () => Promise<void>;
  onRendererReady?: (renderer: BoardRenderer) => void;
  onActionsChange?: (actions: ActionAvailability | null, revision: number) => void;
}

export function GameReadOnly({
  presentation,
  saveStatus,
  onLeave,
  gameTitle,
  connectionLabels,
  sessionNotice,
  resultNotice,
  menuActions,
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
      {...(gameTitle !== undefined ? { gameTitle } : {})}
      {...(connectionLabels !== undefined ? { connectionLabels } : {})}
      {...(sessionNotice !== undefined ? { sessionNotice } : {})}
      {...(resultNotice !== undefined ? { resultNotice } : {})}
      {...(menuActions !== undefined ? { menuActions } : {})}
      {...(devTools ? { devTools } : {})}
      {...(onRematch ? { onRematch } : {})}
      onExportReplay={onExportReplay}
      {...(onRendererReady ? { onRendererReady } : {})}
      {...(onActionsChange ? { onActionsChange } : {})}
    />
  );
}

function BankPanel({ state, hidden }: { state: GameState; hidden: boolean }) {
  const { t } = useTranslation('game');
  if (hidden) return <p className="bank-panel muted">{t('game:bankHidden')}</p>;
  return (
    <section className="bank-panel" aria-label={t('game:bank')}>
      <h2>{t('game:bank')}</h2>
      <div className="bank-cards">
        {cardKinds(state).map((resource) => (
          <span
            className="bank-card"
            key={resource}
            data-commodity={isCommodity(resource)}
            tabIndex={0}
            aria-label={t('game:resourceInBank', {
              resource: kindLabel(t, resource),
              count: state.bank[resource] ?? 0,
            })}
          >
            <ResourceCard resource={resource} count={state.bank[resource] ?? 0} size="sm" />
          </span>
        ))}
        {isKnights(state) ? (
          TRACKS.map((track) => (
            <span
              className="bank-card bank-progress"
              key={track}
              tabIndex={0}
              aria-label={t('knights:deckCount', {
                count: state.decks[`progress-${track}`]?.remaining ?? 0,
                track: t(`knights:track.${track}`),
              })}
            >
              <ProgressCardBack
                track={track}
                count={state.decks[`progress-${track}`]?.remaining ?? 0}
              />
            </span>
          ))
        ) : (
          <span
            className="bank-card bank-development"
            tabIndex={0}
            aria-label={t('game:developmentInBank', {
              count: state.decks.dev?.remaining ?? 0,
            })}
          >
            <span className="resource-card" data-size="sm">
              <img src={getGameArtUrl('cardBack')} alt="" aria-hidden="true" />
              <b className="resource-card-count">{state.decks.dev?.remaining ?? 0}</b>
              <span className="resource-card-name">{t('game:cockpit.devTile')}</span>
            </span>
          </span>
        )}
      </div>
    </section>
  );
}

function LiveGame({
  state,
  presentation,
  saveStatus,
  onLeave,
  gameTitle,
  connectionLabels,
  sessionNotice,
  resultNotice,
  menuActions,
  devTools,
  onRematch,
  onExportReplay,
  onRendererReady,
  onActionsChange,
}: GameScreenProps & { state: GameState }) {
  const { t } = useTranslation('game');
  const events = useSessionStore((store) => store.events);
  const derivedLog = useSessionStore((store) => store.derivedLog);
  const revision = useSessionStore((store) => store.revision);
  const pending = useSessionStore((store) => store.pending);
  const waitingSeat = useSessionStore((store) => store.waitingSeat);
  const revealedSeat = useSessionStore((store) => store.revealedSeat);
  const optionalChoices = useSessionStore((store) => store.optionalChoices);
  const optionalViewingSeat = useSessionStore((store) => store.optionalViewingSeat);
  const compact = useCompactCockpit();
  const { appearance, reducedMotion } = useBoardAppearance(presentation);
  const [gameInfoOpen, setGameInfoOpen] = useState(!compact);
  useEffect(() => setGameInfoOpen(!compact), [compact]);
  const [sheet, setSheet] = useState<{ kind: MobileTab } | { kind: 'player'; seat: Seat } | null>(
    null,
  );
  const sheetRef = useRef<HTMLDialogElement>(null);
  const sheetTrigger = useRef<HTMLButtonElement | null>(null);
  const actionsButton = useRef<HTMLButtonElement>(null);
  const restoreSheetFocus = useRef(true);
  const closeSheet = (restoreFocus: boolean) => {
    restoreSheetFocus.current = restoreFocus;
    if (sheetRef.current?.open) sheetRef.current.close();
    setSheet(null);
  };
  const openSheet = (
    next: { kind: MobileTab } | { kind: 'player'; seat: Seat },
    trigger: HTMLButtonElement,
  ) => {
    sheetTrigger.current = trigger;
    restoreSheetFocus.current = true;
    setGameInfoOpen(false);
    setSheet(next);
  };
  const [renderer, setRenderer] = useState<BoardRenderer | null>(null);
  const finished = Boolean(state.result);
  const [resultsOpen, setResultsOpen] = useState(finished);
  const [fixtureDialog, setFixtureDialog] = useState<string | null>(null);
  const wasFinished = useRef(finished);
  const resultsButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (finished && !wasFinished.current) setResultsOpen(true);
    if (!finished) setResultsOpen(false);
    wasFinished.current = finished;
  }, [finished]);
  const viewBoard = () => {
    setResultsOpen(false);
    requestAnimationFrame(() => resultsButton.current?.focus());
  };
  const boardRef = useRef<HTMLElement>(null);
  const { skip, overlay, receipts } = useVisualEffects(renderer, reducedMotion);
  const lastRoll = latestDiceRoll(events);
  const model = useMemo(() => toRenderModel(state, 'spectator'), [state]);
  const actions = useGameActions(state, pending, presentation, {
    compact,
    reducedMotion,
    onHandOff: () => closeSheet(false),
    onFormClosed: () => {
      if (compact)
        requestAnimationFrame(() => {
          if (!document.querySelector('dialog[open]')) actionsButton.current?.focus();
        });
    },
  });
  const forcedForm = actions.availability?.availableTypes.some(
    (type) => type === 'DISCARD' || type === 'STEAL' || type === 'CHOOSE_GOLD',
  );
  const lastRevealedSeat = useRef(revealedSeat);
  useEffect(() => {
    if (!compact || finished || forcedForm || revealedSeat !== lastRevealedSeat.current)
      closeSheet(false);
    lastRevealedSeat.current = revealedSeat;
  }, [compact, finished, forcedForm, revealedSeat]);
  const previewPlayer = appearance.players.find((player) => player.seat === actions.actorSeat);
  useEffect(
    () => onActionsChange?.(actions.availability, revision),
    [actions.availability, onActionsChange, revision],
  );
  const activeName = playerName(presentation, actions.actorSeat);
  const winner = state.result ? playerName(presentation, state.result.winner) : null;
  const mobileColor =
    presentation.players.find((player) => player.seat === (revealedSeat ?? actions.actorSeat))
      ?.color ?? 'blue';
  const baseOptions = state.config.options.base;
  const hideBankCounts =
    typeof baseOptions === 'object' &&
    baseOptions !== null &&
    'hideBankCounts' in baseOptions &&
    baseOptions.hideBankCounts === true;

  return (
    <div
      className="game-page"
      data-board-theme={appearance.theme}
      data-compact={compact ? 'true' : 'false'}
      style={{ backgroundImage: `url(${getGameArtUrl('background')})` }}
    >
      <details className="game-menu">
        <summary aria-label={t('game:openMenu')}>
          <span aria-hidden="true">☰</span>
        </summary>
        <div className="game-menu-panel">
          <strong>{gameTitle ?? t('game:gameTitle')}</strong>
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
          <FairnessStatus presentation={presentation} />
          {menuActions}
          <button className="button button-quiet" type="button" onClick={skip}>
            {t('game:skipAnimations')}
          </button>
          {finished && (
            <button
              className="button button-quiet"
              type="button"
              onClick={() => setResultsOpen(true)}
            >
              {t('game:results')}
            </button>
          )}
          <button className="button button-quiet" type="button" onClick={onLeave}>
            {t('game:leaveGame')}
          </button>
          {devTools}
        </div>
      </details>
      {compact && (
        <div className="mobile-topbar">
          <PlayerRail
            state={state}
            presentation={presentation}
            activeSeat={actions.actorSeat}
            receipts={receipts}
            compact
            {...(connectionLabels !== undefined ? { connectionLabels } : {})}
            onOpenPlayer={(seat, trigger) => openSheet({ kind: 'player', seat }, trigger)}
          />
        </div>
      )}
      {compact && sessionNotice !== undefined && (
        <div className="mobile-session-notice" role="status" aria-live="polite">
          {sessionNotice}
        </div>
      )}
      <div className="game-grid" data-knights={isKnights(state)}>
        <section ref={boardRef} className="game-board" aria-label={t('game:board')}>
          <BoardView
            model={model}
            appearance={appearance}
            reducedMotion={reducedMotion}
            label={t('game:board')}
            highlights={finished ? {} : actions.highlights}
            focusTarget={finished ? null : actions.focusTarget}
            {...(finished || !previewPlayer || !actions.placementConfirmation
              ? {}
              : {
                  focusPreview: {
                    piece: actions.placementConfirmation.piece,
                    color: previewPlayer.color,
                    marker: previewPlayer.marker,
                    ...(actions.placementConfirmation.knight
                      ? { knight: actions.placementConfirmation.knight }
                      : {}),
                  },
                })}
            onSelect={(hit) => {
              if (!finished) actions.onBoardSelect(hit);
            }}
            targetLabel={(hit) => actions.targetLabel(hit)}
            moduleIds={state.config.modules.map((module) => module.id)}
            onFixtureSelect={setFixtureDialog}
            onRendererReady={(readyRenderer) => {
              setRenderer(readyRenderer);
              onRendererReady?.(readyRenderer);
            }}
          />
          <DiceRollReadout dice={lastRoll} />
          {isKnights(state) && !compact && !finished && (
            <div className="knights-strip-overlay">
              <ImprovementsStrip
                state={state}
                seat={revealedSeat ?? actions.actorSeat}
                improvable={actions.knights?.improvable ?? []}
                onOpen={() => actions.knights?.openImprovements()}
              />
            </div>
          )}
          <ModuleHud
            state={state}
            presentation={presentation}
            renderer={renderer}
            openFixture={setFixtureDialog}
          />
          {fixtureDialog !== null && (
            <FixtureDialog
              fixtureId={fixtureDialog}
              state={state}
              presentation={presentation}
              onClose={() => setFixtureDialog(null)}
            />
          )}
          {compact && (
            <div className="mobile-board-awards">
              <AwardsPanel state={state} presentation={presentation} />
            </div>
          )}
          {!compact && !finished && actions.desktopStatus}
          {!finished && actions.placementConfirmation && (
            <PlacementConfirmation
              boardRef={boardRef}
              renderer={renderer}
              hit={actions.placementConfirmation.hit}
              piece={actions.placementConfirmation.piece}
              kind={actions.placementConfirmation.kind}
              move={actions.placementConfirmation.move}
              label={actions.placementConfirmation.label}
              onConfirm={actions.placementConfirmation.confirm}
              onCancel={actions.placementConfirmation.cancel}
              submitting={actions.submitting}
            />
          )}
          {!finished && (actions.offerOverlay || actions.tradeNotice) && (
            <div className="board-offers" inert={actions.submitting}>
              {actions.tradeNotice}
              {actions.offerOverlay}
            </div>
          )}
        </section>
        {!compact && (
          <aside className="game-sidebar" aria-label={t('game:players')}>
            {sessionNotice !== undefined && (
              <div role="status" aria-live="polite">
                {sessionNotice}
              </div>
            )}
            <PlayerRail
              state={state}
              presentation={presentation}
              activeSeat={actions.actorSeat}
              receipts={receipts}
              compact={compact}
              {...(connectionLabels !== undefined ? { connectionLabels } : {})}
              onOpenPlayer={(seat, trigger) => openSheet({ kind: 'player', seat }, trigger)}
            />
            {isKnights(state) && (
              <section
                className="knights-sidebar"
                aria-label={t('knights:improve.title')}
                data-testid="improvements-panel"
              >
                <h2>{t('knights:improve.title')}</h2>
                <ImprovementsBoard
                  state={state}
                  seat={revealedSeat ?? actions.actorSeat}
                  presentation={presentation}
                  captions="cost"
                  {...(revealedSeat !== null && actions.knights
                    ? {
                        buyable: actions.knights.improvable,
                        onBuy: (track: Track) => actions.knights?.improve(track),
                        disabled: actions.knights.disabled,
                      }
                    : {})}
                />
              </section>
            )}
            <details
              className="game-info"
              open={gameInfoOpen}
              onToggle={(event) => setGameInfoOpen(event.currentTarget.open)}
            >
              <summary>{t('game:gameInfo')}</summary>
              <AwardsPanel state={state} presentation={presentation} />
              <BankPanel state={state} hidden={hideBankCounts} />
              <EventLog events={events} presentation={presentation} derived={derivedLog} />
            </details>
          </aside>
        )}
        <div className="game-bottom">
          {compact ? (
            <div className="mobile-bottom-controls">
              {isKnights(state) && !finished && (
                <ImprovementsStrip
                  state={state}
                  seat={revealedSeat ?? actions.actorSeat}
                  improvable={actions.knights?.improvable ?? []}
                  onOpen={() => actions.knights?.openImprovements()}
                />
              )}
              <HandDock
                state={state}
                knightIntent={finished ? null : actions.knightIntent}
                toggleKnightIntent={actions.toggleKnightIntent}
                compact
                submitting={actions.submitting}
                knights={finished ? null : actions.knights}
              />
              <MobileGameControls
                step={finished ? null : actions.nextStep}
                hasOptional={optionalChoices.length > 0}
                playerColor={mobileColor}
                onOpenTab={(kind, trigger) => openSheet({ kind }, trigger)}
                {...(optionalViewingSeat !== null
                  ? { onReturnToBoard: () => useSessionStore.getState().leaveOptionalSeat() }
                  : {})}
                onResults={() => setResultsOpen(true)}
                resultsButton={resultsButton}
                actionsButton={actionsButton}
              />
            </div>
          ) : (
            <>
              {!finished && actions.desktopBuild}
              <HandDock
                state={state}
                knightIntent={finished ? null : actions.knightIntent}
                toggleKnightIntent={actions.toggleKnightIntent}
                compact={false}
                submitting={actions.submitting}
                knights={finished ? null : actions.knights}
              />
              {winner ? (
                <section className="action-dock finished-dock" aria-label={t('game:actions')}>
                  <h2>{t('game:gameOver')}</h2>
                  <p>{t('game:winner', { player: winner })}</p>
                  <button
                    ref={resultsButton}
                    className="button button-primary"
                    type="button"
                    onClick={() => setResultsOpen(true)}
                  >
                    {t('game:results')}
                  </button>
                </section>
              ) : (
                <>
                  {actions.desktopTrade}
                  {actions.desktopTurn}
                </>
              )}
            </>
          )}
        </div>
      </div>
      {!finished && actions.forms}
      {compact && sheet && !forcedForm && !(waitingSeat !== null && revealedSeat === null) && (
        <CockpitSheet
          title={
            sheet.kind === 'player'
              ? playerName(presentation, sheet.seat)
              : sheet.kind === 'build'
                ? t('game:buildPanel')
                : sheet.kind === 'trade'
                  ? t('game:tradePanel')
                  : sheet.kind === 'players'
                    ? t('game:players')
                    : t('game:eventLog')
          }
          dialogRef={sheetRef}
          swipeToDismiss
          onClosed={() => {
            setSheet(null);
            if (restoreSheetFocus.current)
              requestAnimationFrame(() => sheetTrigger.current?.focus());
            restoreSheetFocus.current = true;
          }}
        >
          {sheet.kind === 'build' ? (
            actions.mobileBuild
          ) : sheet.kind === 'trade' ? (
            <>
              {actions.mobileTrade}
              <BankPanel state={state} hidden={hideBankCounts} />
            </>
          ) : sheet.kind === 'players' ? (
            <div className="mobile-players-list">
              {state.seats.map(({ seat }) => (
                <PlayerDetails
                  key={seat}
                  state={state}
                  seat={seat}
                  presentation={presentation}
                  receipt={receipts.find((item) => item.seat === seat)}
                  activeSeat={actions.actorSeat}
                  summary
                  {...(connectionLabels !== undefined ? { connectionLabels } : {})}
                />
              ))}
              <AwardsPanel state={state} presentation={presentation} />
            </div>
          ) : sheet.kind === 'log' ? (
            <EventLog
              events={events}
              presentation={presentation}
              derived={derivedLog}
              initiallyOpen
            />
          ) : sheet.kind === 'player' ? (
            <PlayerDetails
              state={state}
              seat={sheet.seat}
              presentation={presentation}
              receipt={receipts.find((item) => item.seat === sheet.seat)}
              activeSeat={actions.actorSeat}
              {...(connectionLabels !== undefined ? { connectionLabels } : {})}
            />
          ) : null}
        </CockpitSheet>
      )}
      {finished && resultsOpen && (
        <GameOverPanel
          state={state}
          events={events}
          presentation={presentation}
          onViewBoard={viewBoard}
          {...(onRematch ? { onRematch } : {})}
          onExportReplay={onExportReplay}
          {...(resultNotice !== undefined ? { resultNotice } : {})}
        />
      )}
      {waitingSeat !== null && revealedSeat === null && !winner && (
        <PrivacyCover player={playerName(presentation, waitingSeat)} seat={waitingSeat} />
      )}
      {overlay}
    </div>
  );
}
