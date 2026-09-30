import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  getGameArtUrl,
  getPieceIconUrl,
  getResourceIconUrl,
  getSeafaringIconUrl,
  getShipIconUrl,
  type BoardHighlights,
  type BoardHit,
} from '@cp2p/renderer';
import type { EdgeId, HexId, VertexId } from '@cp2p/engine/geometry';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import {
  CITY_COST,
  DEV_COST,
  RESOURCES,
  ROAD_COST,
  SETTLEMENT_COST,
  SHIP_COST,
  type CommandShape,
  type GameEvent,
  type GameState,
  type Pending,
  type Resource,
  type Seat,
} from '@cp2p/engine';
import {
  deriveActionAvailability,
  type PlacementChoice,
  type PlacementKind,
} from '../actions/availability';
import {
  DiscardDialog,
  GoldDialog,
  MonopolyDialog,
  StealDialog,
  YearOfPlentyDialog,
} from '../dialogs';
import { ActionPendingContext } from '../dialogs/DialogFrame';
import { BankTradePicker, IncomingOffers, TradeComposer, TradeNotice } from '../trade';
import {
  sessionForActions,
  useSessionStore,
  type PlacementCandidate,
} from '../../store/session-store';
import { actingSeat } from '../../store/pending-actors';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { recordOrdinaryActionRejection } from './action-diagnostics';
import { BuildCostsDialog } from './BuildCostsDialog.js';
import { StealSheet } from './StealSheet';
import { useStealReveal } from './steal-reveal';
import { resourceLabel } from '../dialogs/resources.js';
import { fogDrawPending, isSeafaring } from './seafaring';
import { KnightsBuildButtons, KnightsBuildRows } from '../knights/BuildControls';
import { KnightsForms } from '../knights/KnightsForms';
import { KnightSheet } from '../knights/KnightSheet';
import { knightStatus } from '../knights/knight-status';
import {
  firstPicks,
  highlightStyle,
  isForcedKind,
  isTwoStepKind,
  kindInfo,
  previewOfKind,
  secondPicks,
  targetOfKind,
} from '../knights/board-modes';
import type { KnightsController } from '../knights/controller';
import { cardInfo } from '../knights/catalogue';
import { improvableTracks } from '../knights/improve';
import { CARD_KINDS, KNIGHTS_PLACEMENT_KINDS } from '../knights/placements';
import { isKnights, knightLevel, knightsState } from '../knights/state';

/** A retired seat is not a failure: its controller moved (transfer) or a bot took over. */
function stoppedText(t: TFunction<'game'>, status: { readonly code?: string }): string {
  return status.code === 'seat-retired' ? t('game:seatRetired') : t('game:sessionStopped');
}

const boardOrder: readonly PlacementKind[] = [
  'settlement',
  'road',
  'ship',
  'city',
  'freeRoad',
  'freeShip',
  'robber',
  'pirate',
  'moveShip',
  ...KNIGHTS_PLACEMENT_KINDS,
];
/** Kinds that only exist while a placement is forced, so they sit beside the board. */
const STATUS_KINDS: ReadonlySet<PlacementKind> = new Set([
  'freeRoad',
  'freeShip',
  'robber',
  'pirate',
  'relocate',
  'pillage',
  'metropolis',
  'deserterRemove',
  'deserterPlace',
]);
type EdgeKind = 'road' | 'freeRoad' | 'ship' | 'freeShip' | 'moveShip';
const EDGE_KINDS: ReadonlySet<PlacementKind> = new Set([
  'road',
  'freeRoad',
  'ship',
  'freeShip',
  'moveShip',
]);

function isEdgeKind(kind: PlacementKind | undefined): kind is EdgeKind {
  return kind !== undefined && (EDGE_KINDS.has(kind) || targetOfKind(kind) === 'edge');
}

/** Which forced choice a kind belongs to: a route piece, a free piece or the blocker. */
function choiceFamily(kind: PlacementKind): 'route' | 'free' | 'blocker' | null {
  if (kind === 'road' || kind === 'ship') return 'route';
  if (kind === 'freeRoad' || kind === 'freeShip') return 'free';
  if (kind === 'robber' || kind === 'pirate') return 'blocker';
  return null;
}

/** The piece a confirmed placement puts on the board. */
type ConfirmPiece = 'road' | 'ship' | 'settlement' | 'city' | 'knight' | 'wall' | 'mark';
function placedPiece(kind: PlacementKind): ConfirmPiece | null {
  if (kind === 'road' || kind === 'freeRoad') return 'road';
  if (kind === 'ship' || kind === 'freeShip' || kind === 'moveShip') return 'ship';
  if (kind === 'settlement' || kind === 'city') return kind;
  return previewOfKind(kind);
}
const normalActionOrder: Readonly<Record<string, number>> = {
  ROLL_DICE: 0,
  END_TURN: 0,
  END_SBP: 0,
  MARITIME_TRADE: 1,
  OFFER_TRADE: 2,
  PROPOSE_TRADE: 2,
};
const actionPaths: Readonly<Record<string, string>> = {
  ROLL_DICE: 'M5 5h6v6H5zM13 13h6v6h-6zM7.5 7.5h1M15.5 15.5h1',
  END_TURN: 'M4 12h15m-6-6 6 6-6 6',
  END_SBP: 'M4 12h15m-6-6 6 6-6 6',
  MARITIME_TRADE: 'M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4',
  OFFER_TRADE:
    'M7 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM3 17v-2a4 4 0 0 1 7-2.6M21 17v-2a4 4 0 0 0-7-2.6M9 16h6m-2-2 2 2-2 2',
  PROPOSE_TRADE:
    'M7 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM3 17v-2a4 4 0 0 1 7-2.6M21 17v-2a4 4 0 0 0-7-2.6M9 16h6m-2-2 2 2-2 2',
  robber: 'M12 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM8 20v-4a4 4 0 0 1 8 0v4Z',
  BUY_DEV_CARD: 'M5 4h12v15H5zM8 7h12v15H8z',
  PLAY_DEV_CARD: 'M5 4h12v15H5zM8 7h12v15H8z',
};
/** How long the steal sheet waits for a fair result before it gives up and closes. */
const STEAL_RESULT_WAIT_MS = 30_000;
const noChoices = [] as const;
/** Commands that end or advance the seat's own phase; shown as the promoted turn button. */
const TURN_COMMANDS: ReadonlySet<string> = new Set(['ROLL_DICE', 'END_TURN', 'END_SBP']);
const closeForm = () => useSessionStore.getState().closeActionDialog();

function ActionIcon({ kind, color }: { kind: string; color?: string | undefined }) {
  if (kind === 'ship' || kind === 'freeShip' || kind === 'moveShip')
    return <img className="action-icon" src={getShipIconUrl(color)} alt="" aria-hidden="true" />;
  if (kind === 'pirate')
    return (
      <img className="action-icon" src={getSeafaringIconUrl('pirate')} alt="" aria-hidden="true" />
    );
  const piece = kind === 'freeRoad' ? 'road' : kind;
  if (piece === 'road' || piece === 'settlement' || piece === 'city')
    return (
      <img className="action-icon" src={getPieceIconUrl(piece, color)} alt="" aria-hidden="true" />
    );
  const path = actionPaths[kind] ?? 'M5 12h14m-5-5 5 5-5 5';
  return (
    <svg className="action-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function boardHitKind(kind: PlacementKind): BoardHit['kind'] {
  const knights = targetOfKind(kind);
  if (knights !== null) return knights;
  return isEdgeKind(kind) ? 'edge' : kind === 'robber' || kind === 'pirate' ? 'hex' : 'vertex';
}

function isEdgeId(id: string): id is EdgeId {
  return /^e:-?\d+,-?\d+,(NE|NW|W)$/.test(id);
}

function isVertexId(id: string): id is VertexId {
  return /^v:-?\d+,-?\d+,(N|S)$/.test(id);
}

function isHexId(id: string): id is HexId {
  return /^h:-?\d+,-?\d+$/.test(id);
}

function placementHit(candidate: PlacementCandidate): BoardHit | null {
  const kind = boardHitKind(candidate.kind);
  if (kind === 'edge' && isEdgeId(candidate.id)) return { kind, id: candidate.id };
  if (kind === 'vertex' && isVertexId(candidate.id)) return { kind, id: candidate.id };
  if (kind === 'hex' && isHexId(candidate.id)) return { kind, id: candidate.id };
  return null;
}

const NO_EVENTS: readonly GameEvent[] = [];

export interface GameActionController {
  actorSeat: Seat;
  availability: ReturnType<typeof deriveActionAvailability> | null;
  highlights: BoardHighlights;
  focusTarget: BoardHit | null;
  placementConfirmation: {
    piece: ConfirmPiece;
    /** True when the ship already exists and only sails to the marked edge. */
    move: boolean;
    hit: BoardHit;
    label: string;
    /** Knights placements name their own action instead of a piece. */
    kind: PlacementKind;
    /** For a knight preview: its strength and whether it stands active. */
    knight?: { level: 1 | 2 | 3; active: boolean };
    confirm: () => void;
    cancel: () => void;
  } | null;
  onBoardSelect(hit: BoardHit): void;
  targetLabel(hit: BoardHit): string;
  offerOverlay: React.ReactNode;
  /** How the viewer's last open trade ended, shown briefly above the offers. */
  tradeNotice: React.ReactNode;
  placementActive: boolean;
  knightIntent: { slotId: string; confirm: () => void; cancel: () => void } | null;
  toggleKnightIntent: (slotId: string) => void;
  dock: React.ReactNode;
  desktopBuild: React.ReactNode;
  desktopStatus: React.ReactNode;
  desktopTrade: React.ReactNode;
  desktopTurn: React.ReactNode;
  mobileBuild: React.ReactNode;
  mobileTrade: React.ReactNode;
  forms: React.ReactNode;
  /** Improvements, progress cards and the like; null in a game without knights. */
  knights: KnightsController | null;
  nextStep: NextStep;
  actionCount: number;
  submitting: boolean;
}

export type NextStep =
  | { kind: 'command'; label: string; rollDice: boolean; run: () => void }
  | {
      kind: 'board';
      text: string;
      cancel?: () => void;
      /** Ends a two-pick action at the first pick, such as a Diplomat that builds no road. */
      finish?: { label: string; run: () => void };
      /** Pieces the seat may pick between for one forced placement, such as robber or pirate. */
      alternatives?: readonly {
        kind: PlacementKind;
        label: string;
        active: boolean;
        select: () => void;
      }[];
    }
  | {
      kind: 'pending';
      text: string;
      turnAction?: { label: string; rollDice: boolean };
    }
  | { kind: 'text'; text: string; tone: 'muted' | 'alert' };

/** The knight a placement puts on the board, for its preview: strength and active state. */
function knightPreview(
  state: GameState,
  kind: PlacementKind | undefined,
  moveFrom: string | null,
  choice: PlacementChoice | undefined,
): { knight?: { level: 1 | 2 | 3; active: boolean } } {
  const ext = knightsState(state);
  if (!ext || kind === undefined || previewOfKind(kind) !== 'knight') return {};
  if (kind === 'moveKnight' || kind === 'displaceKnight') {
    const moving = ext.knights.find((knight) => knight.vertex === moveFrom);
    return moving ? { knight: { level: knightLevel(moving.level), active: false } } : {};
  }
  if (kind === 'relocate') {
    const frame = state.turn.phase.at(-1);
    const data: unknown = frame?.data;
    const stored =
      typeof data === 'object' && data !== null
        ? { level: Reflect.get(data, 'level'), active: Reflect.get(data, 'active') }
        : null;
    return stored && typeof stored.level === 'number'
      ? { knight: { level: knightLevel(stored.level), active: stored.active === true } }
      : { knight: { level: 1, active: false } };
  }
  if (kind === 'deserterPlace')
    return { knight: { level: knightLevel(Number(choice?.command.level) || 1), active: false } };
  return { knight: { level: 1, active: false } };
}

/**
 * The knight a tap with no board action lands on: at the vertex hit, or, since a tap on a knight
 * often resolves to one of the roads beside it, at an end of the edge hit.
 */
function knightAtHit(
  state: GameState,
  graph: ReturnType<typeof buildBoardGraph>,
  hit: BoardHit,
): string | null {
  const standing = new Set(knightsState(state)?.knights.map((knight) => knight.vertex) ?? []);
  if (standing.size === 0) return null;
  if (hit.kind === 'vertex') return standing.has(hit.id) ? hit.id : null;
  if (hit.kind !== 'edge') return null;
  const ends = graph.edgeVertices[graph.edgeIndex[hit.id] ?? -1] ?? [];
  return ends.find((vertex) => standing.has(vertex)) ?? null;
}

/** Let React commit pending feedback before synchronous proof work starts. */
function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (document.visibilityState !== 'visible' || !window.requestAnimationFrame) {
      window.setTimeout(resolve, 0);
      return;
    }
    let frame = 0;
    const finish = () => {
      window.clearTimeout(timeout);
      window.cancelAnimationFrame(frame);
      resolve();
    };
    // A tab can become hidden between frames, suspending animation callbacks.
    const timeout = window.setTimeout(finish, 100);
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(finish);
    });
  });
}

/** How long a gold reveal plays on the board before its choice dialog covers it. */
const GOLD_AFTER_REVEAL_MS = 1100;

/** The controller only offers engine-provided commands and checks the live revision on submission. */
export function useGameActions(
  state: GameState,
  pending: readonly Pending[],
  presentation: GamePresentation,
  options: {
    compact?: boolean;
    reducedMotion?: boolean;
    /**
     * The "pick the card to steal" setting: steals go through the steal sheet. Null while the
     * settings load: the victim choice waits, so a steal never takes the wrong path.
     */
    pickStealCard?: boolean | null;
    onHandOff?: () => void;
    onFormClosed?: () => void;
  } = {},
): GameActionController {
  const { t } = useTranslation('game');
  const seat = useSessionStore((store) => store.revealedSeat);
  const priv = useSessionStore((store) => store.privateState);
  const legal = useSessionStore((store) => store.legal);
  const status = useSessionStore((store) => store.status);
  const voided = status?.kind === 'void';
  const conflicted = useSessionStore((store) => store.conflicted);
  const revision = useSessionStore((store) => store.revision);
  // Some test stores leave the log out; a shared empty list keeps the notice's input stable.
  const events = useSessionStore((store) => store.events) ?? NO_EVENTS;
  const lastEvent = events.at(-1);
  const boardKind = useSessionStore((store) => store.placementMode);
  const boardCancelled = useSessionStore((store) => store.placementCancelled);
  const previewPlacement = useSessionStore((store) => store.previewPlacement);
  const shipMoveFrom = useSessionStore((store) => store.shipMoveFrom);
  const form = useSessionStore((store) => store.openDialog);
  const slotId = useSessionStore((store) => store.selectedCardSlot);
  const optionalChoices = useSessionStore((store) => store.optionalChoices);
  const optionalViewingSeat = useSessionStore((store) => store.optionalViewingSeat);
  const [error, setError] = useState<string | null>(null);
  const [buildCostsOpen, setBuildCostsOpen] = useState(false);
  /** The knight tapped with no board action chosen: its status sheet is open. */
  const [inspectedKnight, setInspectedKnight] = useState<string | null>(null);
  const submitting = useRef(false);
  const [submittingCommand, setSubmittingCommand] = useState<CommandShape['type'] | null>(null);
  const isSubmitting = submittingCommand !== null;
  const actorSeat = actingSeat(state, pending);
  // A gold reveal is answered at once, but its dialog waits until the tile has turned over.
  const goldReveal = lastEvent?.type === 'fogRevealed' && lastEvent.terrain === 'gold';
  const [goldShownAt, setGoldShownAt] = useState<number | null>(null);
  const goldHeld = goldReveal && goldShownAt !== revision && !options.reducedMotion;
  useEffect(() => {
    if (!goldHeld) return undefined;
    const timer = window.setTimeout(() => setGoldShownAt(revision), GOLD_AFTER_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [goldHeld, revision]);
  const revealing = fogDrawPending(pending) !== null || goldHeld;
  const availability = useMemo(
    () =>
      !voided && seat !== null && legal ? deriveActionAvailability(legal, pending, seat) : null,
    [legal, pending, seat, voided],
  );
  const graph = useMemo(() => buildBoardGraph(state.board.hexes), [state.board.hexes]);
  const availableBoardKinds = boardOrder.filter((kind) => availability?.placements[kind].length);
  const phase = state.turn.phase.at(-1)?.id;
  const mandatoryPlacement =
    phase === 'setup' ||
    phase === 'roadBuilding' ||
    phase === 'moveRobber' ||
    availableBoardKinds.some(isForcedKind);
  const selectedKind = boardCancelled
    ? undefined
    : boardKind && availableBoardKinds.includes(boardKind)
      ? boardKind
      : mandatoryPlacement
        ? availableBoardKinds[0]
        : undefined;
  const rawChoices =
    selectedKind && availability ? availability.placements[selectedKind] : noChoices;
  const twoStep = isTwoStepKind(selectedKind);
  const movingShip = selectedKind === 'moveShip';
  const moveFrom =
    twoStep && shipMoveFrom !== null && rawChoices.some((choice) => choice.from === shipMoveFrom)
      ? shipMoveFrom
      : null;
  const second = useMemo(
    () => (twoStep && moveFrom !== null ? secondPicks(rawChoices, moveFrom) : null),
    [twoStep, moveFrom, rawChoices],
  );
  const choices = useMemo(() => {
    if (!twoStep) return rawChoices;
    if (second) return second.targets;
    // Choosing the piece comes first: one target for each ship, knight or road that has a move.
    return firstPicks(rawChoices);
  }, [twoStep, second, rawChoices]);
  const selectedPlacement =
    selectedKind && previewPlacement?.kind === selectedKind
      ? choices.find((choice) => choice.id === previewPlacement.id)
      : undefined;
  const focusTarget: BoardHit | null =
    selectedPlacement && previewPlacement ? placementHit(previewPlacement) : null;
  const hitKind = selectedKind ? boardHitKind(selectedKind) : null;
  const highlights: BoardHighlights = useMemo(() => {
    if (!hitKind) return {};
    const knightsStyle = selectedKind
      ? highlightStyle(selectedKind, twoStep && moveFrom === null)
      : {};
    return {
      ...(hitKind === 'edge' ? { edges: choices.map((choice) => choice.id).filter(isEdgeId) } : {}),
      ...(hitKind === 'vertex'
        ? { vertices: choices.map((choice) => choice.id).filter(isVertexId) }
        : {}),
      ...(hitKind === 'hex' ? { hexes: choices.map((choice) => choice.id).filter(isHexId) } : {}),
      mode: hitKind,
      ...(moveFrom !== null && isEdgeId(moveFrom) ? { selectedEdges: [moveFrom] } : {}),
      ...(moveFrom !== null && isVertexId(moveFrom) ? { selectedVertices: [moveFrom] } : {}),
      ...(moveFrom !== null && isHexId(moveFrom) ? { selectedHexes: [moveFrom] } : {}),
      style: {
        color: 0x61b89a,
        pulse: true,
        ...(selectedKind === 'settlement'
          ? { vertexTarget: 'site' as const }
          : selectedKind === 'city'
            ? { vertexTarget: 'upgrade' as const }
            : {}),
        ...(movingShip && moveFrom === null
          ? { edgeTarget: 'ring' as const }
          : movingShip || selectedKind === 'ship' || selectedKind === 'freeShip'
            ? { edgeTarget: 'wake' as const }
            : {}),
        ...knightsStyle,
      },
    };
  }, [choices, hitKind, selectedKind, twoStep, movingShip, moveFrom]);
  /** The name of a board action: a build for the base kinds, its own short label for a knights kind. */
  const actionLabel = (kind: PlacementKind): string =>
    kindInfo(kind) ? t(`knights:action.${kind}`) : t(`game:buildAction.${kind}`);
  const playerLabel = (candidate: Seat) =>
    presentation.players.find((player) => player.seat === candidate)?.name ??
    t('game:playerFallback', { number: candidate + 1 });
  const playerColor =
    seat === null ? undefined : presentation.players.find((player) => player.seat === seat)?.color;

  const submit = (command: CommandShape) => {
    if (seat === null || submitting.current) return;
    const session = sessionForActions();
    const latest = useSessionStore.getState();
    if (
      !session ||
      latest.conflicted ||
      latest.status?.kind === 'void' ||
      latest.revision !== revision ||
      latest.revealedSeat !== seat
    ) {
      setError(t('game:staleAction'));
      return;
    }
    submitting.current = true;
    setSubmittingCommand(command.type);
    setError(null);
    void (async () => {
      try {
        await afterNextPaint();
        const current = useSessionStore.getState();
        if (
          sessionForActions() !== session ||
          current.revision !== revision ||
          current.revealedSeat !== seat ||
          current.status?.kind === 'void' ||
          current.conflicted
        ) {
          setError(t('game:staleAction'));
          return;
        }
        const validated = await session.validate(seat, command);
        if (!validated.ok) {
          recordOrdinaryActionRejection();
          setError(
            t(
              validated.error.code === 'stale-revision' ? 'game:staleAction' : 'game:invalidAction',
            ),
          );
          return;
        }
        const afterValidation = useSessionStore.getState();
        if (
          sessionForActions() !== session ||
          afterValidation.revision !== revision ||
          afterValidation.revealedSeat !== seat ||
          afterValidation.status?.kind === 'void' ||
          afterValidation.conflicted
        ) {
          setError(t('game:staleAction'));
          return;
        }
        const result = await session.submit(seat, command, { expectedRevision: revision });
        if (result.ok) {
          if (sessionForActions() === session) useSessionStore.getState().closeActionDialog();
        } else {
          recordOrdinaryActionRejection();
          setError(
            t(result.error.code === 'stale-revision' ? 'game:staleAction' : 'game:invalidAction'),
          );
        }
      } catch {
        recordOrdinaryActionRejection();
        setError(t('game:invalidAction'));
      } finally {
        submitting.current = false;
        setSubmittingCommand(null);
      }
    })();
  };
  useEffect(() => setError(null), [seat, phase]);
  const stealReveal = useStealReveal((store) => store.active);
  const stealAnnounced = useStealReveal((store) => store.announced);
  const stealCommand =
    stealReveal === null
      ? undefined
      : availability?.stealTargets.find((target) => target.seat === stealReveal.victim)?.command;
  const openStealSheet = useCallback(
    (victim: Seat, handSize: number) => {
      const reveals = useStealReveal.getState();
      if (seat !== null && reveals.active === null) reveals.open(seat, victim, handSize);
    },
    [seat],
  );
  const stealStage =
    stealReveal === null
      ? null
      : stealReveal.face !== null
        ? 'revealed'
        : stealReveal.picked === null
          ? 'choosing'
          : 'drawing';
  useEffect(() => {
    // The steal is no longer this seat's to make (a timeout stole, or the game moved on).
    if (stealStage === 'choosing' && !stealCommand) useStealReveal.getState().reset();
  }, [stealCommand, stealStage]);
  useEffect(() => {
    // The steal could not be submitted: the thief may tap again.
    if (stealStage === 'drawing' && stealCommand && !isSubmitting && error !== null)
      useStealReveal.getState().unpick();
  }, [error, isSubmitting, stealCommand, stealStage]);
  useEffect(() => {
    // A result that never comes (a lost connection) must not keep the sheet open for good.
    if (stealStage !== 'drawing') return undefined;
    const timer = window.setTimeout(() => useStealReveal.getState().reset(), STEAL_RESULT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [stealStage]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        seat === null ||
        submitting.current ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.repeat
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
      )
        return;
      if (document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') {
        if (previewPlacement) {
          useSessionStore.getState().clearPlacementCandidate();
          return;
        }
        if (moveFrom !== null) {
          useSessionStore.getState().selectShipToMove(null);
          return;
        }
        if (!mandatoryPlacement) useSessionStore.getState().cancelPlacement();
        useSessionStore.getState().closeActionDialog();
        return;
      }
      if (form === 'knight') return;
      const shortcuts: Record<string, PlacementKind> = {
        '1': 'road',
        '2': 'settlement',
        '3': 'city',
        '4': 'ship',
      };
      const kind = shortcuts[event.key];
      if (previewPlacement) return;
      if (kind && availableBoardKinds.includes(kind)) {
        useSessionStore.getState().choosePlacement(kind);
        event.preventDefault();
        return;
      }
      const commandTypes =
        event.key.toLowerCase() === 'r'
          ? ['ROLL_DICE']
          : event.key.toLowerCase() === 'e'
            ? ['END_TURN', 'END_SBP']
            : [];
      const command = availability?.primary.find((group) => commandTypes.includes(group.type))
        ?.commands[0];
      if (command) {
        event.preventDefault();
        submit(command);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });
  const onBoardSelect = (hit: BoardHit) => {
    if (submitting.current) return;
    // With no board action chosen, a tap on a knight explains what it can do now.
    const tappedKnight = hitKind ? null : knightAtHit(state, graph, hit);
    if (tappedKnight !== null) {
      setInspectedKnight(tappedKnight);
      return;
    }
    if (hit.kind !== hitKind) return;
    const choice = choices.find((item) => item.id === hit.id);
    if (!choice) return;
    if (
      previewPlacement &&
      previewPlacement.kind === selectedKind &&
      previewPlacement.id === hit.id
    ) {
      useSessionStore.getState().clearPlacementCandidate();
      return;
    }
    if (twoStep && moveFrom === null && selectedKind) {
      // A first pick with no second step is complete: it goes straight to the confirmation.
      const rest = secondPicks(rawChoices, hit.id);
      if (rest.targets.length === 0 && rest.finish)
        useSessionStore.getState().selectPlacementCandidate({ kind: selectedKind, id: hit.id });
      else useSessionStore.getState().selectShipToMove(hit.id);
      return;
    }
    if (isEdgeKind(selectedKind) && hit.kind === 'edge') {
      useSessionStore.getState().selectPlacementCandidate({ kind: selectedKind, id: hit.id });
      return;
    }
    if ((selectedKind === 'settlement' || selectedKind === 'city') && hit.kind === 'vertex') {
      useSessionStore.getState().selectPlacementCandidate({ kind: selectedKind, id: hit.id });
      return;
    }
    if (selectedKind && kindInfo(selectedKind)) {
      useSessionStore.getState().selectPlacementCandidate({ kind: selectedKind, id: hit.id });
      return;
    }
    submit(choice.command);
  };
  const targetLabel = (hit: BoardHit) => {
    const number = choices.findIndex((item) => item.id === hit.id) + 1;
    const edgeIndex = hit.kind === 'edge' ? graph.edgeIndex[hit.id] : undefined;
    const vertexIndex = hit.kind === 'vertex' ? graph.vertexIndex[hit.id] : undefined;
    const hexIds: readonly string[] =
      hit.kind === 'hex'
        ? [hit.id]
        : edgeIndex !== undefined
          ? (graph.edgeHexes[edgeIndex] ?? [])
          : vertexIndex !== undefined
            ? (graph.vertexHexes[vertexIndex] ?? [])
            : [];
    const tiles = hexIds
      .map((id) => state.board.hexes.find((hex) => hex.id === id))
      .filter((hex) => hex !== undefined)
      .map((hex) =>
        hex.token === null
          ? t(`game:terrain.${hex.terrain}`)
          : t('game:tileWithToken', {
              terrain: t(`game:terrain.${hex.terrain}`),
              token: hex.token,
            }),
      )
      .join(', ');
    const harbor = state.board.harbors.find((port) => {
      if (hit.kind === 'edge') return port.edge === hit.id;
      if (vertexIndex === undefined) return false;
      return (graph.vertexEdges[vertexIndex] ?? []).some((edge) => edge === port.edge);
    });
    const harborLabel = harbor
      ? harbor.kind === 'generic'
        ? t('game:genericHarbor')
        : RESOURCES.some((resource) => resource === harbor.kind)
          ? t('game:resourceHarbor', { resource: t(`game:${harbor.kind}`) })
          : t('game:unknownHarbor')
      : null;
    const context = harborLabel ? t('game:tileAndHarbor', { tiles, harbor: harborLabel }) : tiles;
    if (selectedKind && kindInfo(selectedKind))
      return t('game:targetOptionDetail', {
        action: t(`knights:placement.${selectedKind}${moveFrom !== null ? 'Target' : ''}`),
        number,
        context,
      });
    return t('game:targetOptionDetail', {
      action: t(
        `game:placement.${selectedKind === 'moveShip' && moveFrom !== null ? 'moveShipTarget' : (selectedKind ?? 'road')}`,
      ),
      number,
      context,
    });
  };

  const formProps =
    seat !== null && priv && legal
      ? {
          legal,
          privateState: priv,
          state,
          seat,
          playerLabel,
          validationKey: `${revision}:${seat}`,
          validationSession: sessionForActions(),
          validate: (command: CommandShape) =>
            sessionForActions()?.validate(seat, command) ?? {
              ok: false as const,
              error: { code: 'session-inactive', message: 'Session unavailable' },
            },
          onSubmit: submit,
        }
      : null;
  const forcedForm = availability?.availableTypes.includes('DISCARD')
    ? 'discard'
    : availability?.availableTypes.includes('STEAL')
      ? 'steal'
      : availability?.availableTypes.includes('CHOOSE_GOLD') && !goldHeld
        ? 'gold'
        : null;
  const visibleForm = forcedForm ?? form;
  const cardPlays = availability?.cardPlays ?? [];
  const closeFormAndFocus = () => {
    if (submitting.current) return;
    closeForm();
    options.onFormClosed?.();
  };
  const selectedKnight =
    form === 'knight' && slotId
      ? cardPlays.find(
          (card) => card.slotId === slotId && (card.card ?? priv?.slots[card.slotId]) === 'knight',
        )
      : undefined;
  const seenCardKinds = new Set<string>();
  const dockCardPlays = cardPlays.filter((card) => {
    const kind = card.card ?? priv?.slots[card.slotId] ?? 'Hidden';
    if (kind === 'knight' && selectedKnight) return card.slotId === selectedKnight.slotId;
    if (seenCardKinds.has(kind)) return false;
    seenCardKinds.add(kind);
    return true;
  });
  const toggleKnightIntent = (cardSlotId: string) => {
    if (submitting.current) return;
    const card = cardPlays.find(
      (item) => item.slotId === cardSlotId && (item.card ?? priv?.slots[item.slotId]) === 'knight',
    );
    if (!card?.commands[0]) return;
    if (form === 'knight' && slotId === cardSlotId) closeFormAndFocus();
    else useSessionStore.getState().openActionDialog('knight', cardSlotId);
  };
  const primary = availability?.primary ?? [];
  const normalGroups = primary
    .filter((group) => group.type in normalActionOrder)
    .toSorted(
      (left, right) => (normalActionOrder[left.type] ?? 0) - (normalActionOrder[right.type] ?? 0),
    );
  const contextualGroups = primary.filter((group) => !(group.type in normalActionOrder));
  const promoted = options.compact
    ? normalGroups.find((group) => TURN_COMMANDS.has(group.type))
    : undefined;
  const sheetNormalGroups = normalGroups.filter((group) => group !== promoted);
  const actionsEnabled = !isSubmitting && !conflicted && !voided && status?.kind !== 'error';
  const chooseBoardAction = (kind: PlacementKind) => {
    options.onHandOff?.();
    const store = useSessionStore.getState();
    if (selectedKind !== kind) store.choosePlacement(kind);
    else if (isTwoStepKind(kind) && moveFrom !== null) store.selectShipToMove(null);
    else if (mandatoryPlacement) store.clearPlacementCandidate();
    else store.cancelPlacement();
  };
  const openTrade = (dialog: 'bank' | 'trade') => {
    options.onHandOff?.();
    useSessionStore.getState().openActionDialog(dialog);
  };
  const actionButtons = (groups: typeof primary) =>
    groups.flatMap((group) => {
      if (
        [
          'RESPOND_TRADE',
          'CANCEL_TRADE',
          'CONFIRM_TRADE',
          'STEAL',
          'DISCARD',
          'CHOOSE_GOLD',
        ].includes(group.type)
      )
        return [];
      const buttonClass = `button button-quiet action-control ${group.type in normalActionOrder ? 'action-normal-control' : ''} ${group.type === 'ROLL_DICE' ? 'action-roll-dice' : ''}`;
      if (group.type === 'OFFER_TRADE' || group.type === 'PROPOSE_TRADE')
        return [
          <button
            className={buttonClass}
            type="button"
            disabled={!actionsEnabled}
            key={group.type}
            title={t('game:command.trade')}
            onClick={() => {
              openTrade('trade');
            }}
          >
            <ActionIcon kind={group.type} />
            <span>{t('game:normalTrade')}</span>
          </button>,
        ];
      if (group.type === 'MARITIME_TRADE')
        return [
          <button
            className={buttonClass}
            type="button"
            disabled={!actionsEnabled}
            key={group.type}
            title={t('game:command.bank')}
            onClick={() => {
              openTrade('bank');
            }}
          >
            <ActionIcon kind={group.type} />
            <span>{t('game:normalBank')}</span>
          </button>,
        ];
      return group.commands.map((command, index) => (
        <button
          className={buttonClass}
          type="button"
          disabled={!actionsEnabled}
          key={`${group.type}:${index}`}
          onClick={() => {
            options.onHandOff?.();
            submit(command);
          }}
        >
          <ActionIcon kind={group.type} />
          <span>{t(`game:command.${group.type}`)}</span>
        </button>
      ));
    });
  const cardPlayButtons = dockCardPlays.map((card) => {
    const cardKind = card.card ?? priv?.slots[card.slotId] ?? 'Hidden';
    const knightSelected = cardKind === 'knight' && form === 'knight' && slotId === card.slotId;
    return (
      <button
        className={`button action-control ${knightSelected ? 'button-primary' : 'button-quiet'}`}
        type="button"
        disabled={!actionsEnabled}
        key={card.slotId}
        {...(cardKind === 'knight' ? { 'aria-pressed': knightSelected } : {})}
        onClick={() => {
          options.onHandOff?.();
          if (cardKind === 'knight') toggleKnightIntent(card.slotId);
          else if (cardKind === 'yearOfPlenty')
            useSessionStore.getState().openActionDialog('plenty', card.slotId);
          else if (cardKind === 'monopoly')
            useSessionStore.getState().openActionDialog('monopoly', card.slotId);
          else if (card.commands[0]) submit(card.commands[0]);
        }}
      >
        <ActionIcon kind="PLAY_DEV_CARD" />
        <span>{t('game:playCard', { card: t(`game:dev${cardKind}`) })}</span>
      </button>
    );
  });
  const optionalTradeChooser =
    optionalChoices.length > 0 && optionalViewingSeat === null ? (
      <details className="optional-trade-chooser">
        <summary>{t('game:optionalTrade')}</summary>
        <div>
          {optionalChoices.map((choiceSeat) => (
            <button
              className="button button-quiet"
              type="button"
              disabled={isSubmitting}
              key={choiceSeat}
              onClick={() => {
                options.onHandOff?.();
                useSessionStore.getState().viewOptionalSeat(choiceSeat);
              }}
            >
              {t('game:viewOptionalTrade', { player: playerLabel(choiceSeat) })}
            </button>
          ))}
        </div>
      </details>
    ) : null;
  const knightsKind = selectedKind !== undefined && kindInfo(selectedKind) !== null;
  const placementInstruction = selectedKind
    ? knightsKind
      ? selectedPlacement
        ? t('knights:instruction.confirm')
        : t(`knights:instruction.${selectedKind}${moveFrom !== null ? 'Target' : ''}`, {
            count: choices.length,
          })
      : selectedPlacement
        ? t('game:placementSelectedInstruction', {
            piece: t(`game:piece.${placedPiece(selectedKind) ?? 'road'}`),
          })
        : selectedKind === 'road' || selectedKind === 'freeRoad'
          ? t('game:roadInstruction', { count: choices.length })
          : selectedKind === 'ship' || selectedKind === 'freeShip'
            ? t('game:shipInstruction', { count: choices.length })
            : selectedKind === 'moveShip'
              ? t(moveFrom === null ? 'game:moveShipPick' : 'game:moveShipTarget', {
                  count: choices.length,
                })
              : selectedKind === 'settlement' || selectedKind === 'city'
                ? t('game:buildingInstruction', { count: choices.length })
                : t('game:boardInstruction', { action: t(`game:placement.${selectedKind}`) })
    : null;
  const alternativeFamily = selectedKind ? choiceFamily(selectedKind) : null;
  const alternatives =
    mandatoryPlacement && alternativeFamily !== null
      ? availableBoardKinds.filter((kind) => choiceFamily(kind) === alternativeFamily)
      : [];
  const contextKinds = availableBoardKinds.filter(
    (kind) => STATUS_KINDS.has(kind) || (alternatives.length > 1 && alternatives.includes(kind)),
  );

  const dock = (
    <section className="action-dock" aria-label={t('game:actions')} aria-busy={isSubmitting}>
      <div className="action-dock-heading">
        <h2>{t('game:actions')}</h2>
        {isSubmitting || revealing ? (
          <span className="action-pending" role="status">
            <span className="action-spinner" aria-hidden="true" />
            {t(isSubmitting ? 'game:submittingAction' : 'game:fogRevealing')}
          </span>
        ) : (
          <button
            className="button button-quiet action-costs-trigger"
            type="button"
            onClick={() => {
              options.onHandOff?.();
              setBuildCostsOpen(true);
            }}
          >
            {t('game:buildCostsTitle')}
          </button>
        )}
      </div>
      {conflicted ? (
        <p role="alert">{t('game:saveConflictStopped')}</p>
      ) : status?.kind === 'error' ? (
        <p role="alert">{stoppedText(t, status)}</p>
      ) : voided ? (
        <p role="status">{t('lobby:onlineGameVoidTitle')}</p>
      ) : seat === null || !availability ? (
        <>
          <p className="muted">{t('game:awaitingAction')}</p>
          {optionalTradeChooser}
        </>
      ) : (
        <>
          <div className={`action-dock-layout ${normalGroups.length ? 'has-normal' : ''}`}>
            <div className="action-context">
              {availableBoardKinds.length > 0 && (
                <div
                  className="action-context-buttons"
                  role="group"
                  aria-label={t('game:chooseBoardAction')}
                >
                  {availableBoardKinds.map((kind) => (
                    <button
                      className={`button action-control ${selectedKind === kind ? 'button-primary' : 'button-quiet'}`}
                      type="button"
                      disabled={isSubmitting}
                      key={kind}
                      aria-pressed={selectedKind === kind}
                      onClick={() => chooseBoardAction(kind)}
                    >
                      <ActionIcon kind={kind} color={playerColor} />
                      <span>{actionLabel(kind)}</span>
                    </button>
                  ))}
                  {selectedKind && !mandatoryPlacement && !selectedPlacement && (
                    <button
                      className="button button-quiet action-control action-cancel"
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => useSessionStore.getState().cancelPlacement()}
                    >
                      <span>{t('game:cancelAction')}</span>
                    </button>
                  )}
                </div>
              )}
              {(contextualGroups.length > 0 || dockCardPlays.length > 0) && (
                <div
                  className="action-context-buttons"
                  role="group"
                  aria-label={t('game:contextActions')}
                >
                  {actionButtons(contextualGroups)}
                  {cardPlayButtons}
                </div>
              )}
              {placementInstruction && (
                <p className="action-context-hint" role="status">
                  {placementInstruction}
                </p>
              )}
              {optionalTradeChooser}
            </div>
            {sheetNormalGroups.length > 0 && (
              <div
                className="action-normal-buttons"
                role="group"
                aria-label={t('game:normalActions')}
              >
                {actionButtons(sheetNormalGroups)}
              </div>
            )}
          </div>
        </>
      )}
      {error && !options.compact && (
        <p className="action-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );

  const costTitle = (cost: Readonly<Record<Resource, number>>) =>
    RESOURCES.filter((resource) => cost[resource] > 0)
      .map((resource) =>
        t('game:buildCostResource', { count: cost[resource], resource: t(`game:${resource}`) }),
      )
      .join(', ');
  const costIcons = (cost: Readonly<Record<Resource, number>>) => (
    <span className="mobile-build-cost" role="img" aria-label={costTitle(cost)}>
      {RESOURCES.flatMap((resource) =>
        Array.from({ length: cost[resource] }, (_, index) => (
          <img
            src={getResourceIconUrl(resource)}
            alt=""
            aria-hidden="true"
            key={`${resource}:${index}`}
          />
        )),
      )}
    </span>
  );
  const seafaring = isSeafaring(state);
  const knights = isKnights(state);
  const shipsLeft = state.seats.find((item) => item.seat === (seat ?? actorSeat))?.piecesLeft.ship;
  const buildChoices = [
    { kind: 'road', label: t('game:buildCosts.road'), cost: ROAD_COST },
    { kind: 'settlement', label: t('game:buildCosts.settlement'), cost: SETTLEMENT_COST },
    { kind: 'city', label: t('game:buildCosts.city'), cost: CITY_COST },
    ...(seafaring
      ? [
          {
            kind: 'ship' as const,
            label: t('game:buildCosts.ship'),
            cost: { ...SHIP_COST, brick: 0, grain: 0, ore: 0 },
          },
        ]
      : []),
  ] as const;
  const pieceIcon = (kind: (typeof buildChoices)[number]['kind']) =>
    kind === 'ship' ? getShipIconUrl(playerColor) : getPieceIconUrl(kind, playerColor);
  const supplyLabel = (kind: (typeof buildChoices)[number]['kind']) =>
    kind === 'ship' ? t('game:shipsLeft', { count: shipsLeft ?? 0 }) : '';
  const moveShipAvailable = availability?.placements.moveShip.length ?? 0;
  const buyDevCard = primary.find((group) => group.type === 'BUY_DEV_CARD')?.commands[0];
  const bankTrade = normalGroups.find((group) => group.type === 'MARITIME_TRADE');
  const playerTrade = normalGroups.find(
    (group) => group.type === 'OFFER_TRADE' || group.type === 'PROPOSE_TRADE',
  );
  const turnGroup = normalGroups.find((group) => TURN_COMMANDS.has(group.type));
  const turnCommand = turnGroup?.commands[0];
  const desktopBuild = (
    <section
      className="desktop-build-panel"
      aria-label={t('game:buildPanel')}
      aria-busy={isSubmitting}
    >
      <div className="desktop-action-panel-heading">
        <h2>{t('game:buildPanel')}</h2>
        <button
          className="button button-quiet desktop-build-costs"
          type="button"
          aria-label={t('game:buildCostsTitle')}
          title={t('game:buildCostsTitle')}
          onClick={() => {
            options.onHandOff?.();
            setBuildCostsOpen(true);
          }}
        >
          ?
        </button>
      </div>
      <div
        className="desktop-build-grid"
        data-seafaring={seafaring}
        data-knights={knights}
        role="group"
        aria-label={t('game:chooseBoardAction')}
      >
        {buildChoices.map(({ kind, label, cost }) => {
          const available = availability?.placements[kind].length;
          const supply = supplyLabel(kind);
          return (
            <button
              className={`desktop-build-button ${selectedKind === kind ? 'is-selected' : ''}`}
              type="button"
              key={kind}
              disabled={!actionsEnabled || !available}
              aria-label={
                supply
                  ? `${t(`game:buildAction.${kind}`)}, ${supply}`
                  : t(`game:buildAction.${kind}`)
              }
              title={`${label} · ${costTitle(cost)}${supply ? ` · ${supply}` : ''}`}
              aria-pressed={selectedKind === kind}
              onClick={() => chooseBoardAction(kind)}
            >
              <img src={pieceIcon(kind)} alt="" aria-hidden="true" />
              {kind === 'ship' && (
                <b className="build-supply" aria-hidden="true">
                  {shipsLeft ?? 0}
                </b>
              )}
            </button>
          );
        })}
        {seafaring && (
          <button
            className={`desktop-build-button ${selectedKind === 'moveShip' ? 'is-selected' : ''}`}
            type="button"
            disabled={!actionsEnabled || moveShipAvailable === 0}
            aria-label={t('game:buildAction.moveShip')}
            title={`${t('game:buildAction.moveShip')} · ${t('game:moveShipOnce')}`}
            aria-pressed={selectedKind === 'moveShip'}
            onClick={() => chooseBoardAction('moveShip')}
          >
            <img src={getShipIconUrl(playerColor, 5)} alt="" aria-hidden="true" />
            <b className="build-supply build-move" aria-hidden="true">
              ⇄
            </b>
          </button>
        )}
        {knights ? (
          <KnightsBuildButtons
            availability={availability}
            selectedKind={selectedKind}
            disabled={!actionsEnabled}
            color={playerColor}
            onChoose={chooseBoardAction}
          />
        ) : (
          <button
            className="desktop-build-button"
            type="button"
            disabled={!actionsEnabled || !buyDevCard}
            aria-label={t('game:command.BUY_DEV_CARD')}
            title={`${t('game:buildCosts.developmentCard')} · ${costTitle(DEV_COST)}`}
            onClick={() => {
              if (buyDevCard) {
                options.onHandOff?.();
                submit(buyDevCard);
              }
            }}
          >
            <img src={getGameArtUrl('cardBack')} alt="" aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  );
  const desktopStatus = (
    <div className="desktop-action-status" aria-busy={isSubmitting || revealing}>
      {revealing && (
        <p className="desktop-fog-revealing action-pending" role="status">
          <span className="action-spinner" aria-hidden="true" />
          {t('game:fogRevealing')}
        </p>
      )}
      {(contextKinds.length > 0 || contextualGroups.length > 0 || cardPlayButtons.length > 0) && (
        <div className="desktop-context-actions" role="group" aria-label={t('game:contextActions')}>
          {contextKinds.map((kind) => (
            <button
              className={`button action-control ${selectedKind === kind ? 'button-primary' : 'button-quiet'}`}
              type="button"
              key={kind}
              disabled={!actionsEnabled}
              aria-pressed={selectedKind === kind}
              onClick={() => chooseBoardAction(kind)}
            >
              <ActionIcon kind={kind} color={playerColor} />
              <span>{actionLabel(kind)}</span>
            </button>
          ))}
          {actionButtons(contextualGroups.filter((group) => group.type !== 'BUY_DEV_CARD'))}
          {cardPlayButtons}
        </div>
      )}
      {placementInstruction && (
        <p className="desktop-placement-instruction" role="status">
          {placementInstruction}
        </p>
      )}
      {selectedKind && !mandatoryPlacement && !selectedPlacement && (
        <button
          className="button button-quiet desktop-placement-cancel"
          type="button"
          disabled={!actionsEnabled}
          onClick={() => useSessionStore.getState().cancelPlacement()}
        >
          {t('game:cancelAction')}
        </button>
      )}
      {optionalTradeChooser}
      {voided && <p role="status">{t('lobby:onlineGameVoidTitle')}</p>}
      {seat === null && !conflicted && !voided && status?.kind !== 'error' && (
        <p className="desktop-awaiting-action" role="status">
          {t('game:awaitingAction')}
        </p>
      )}
    </div>
  );
  const desktopTrade = (
    <section className="desktop-trade-panel" aria-label={t('game:tradePanel')}>
      <h2>{t('game:tradePanel')}</h2>
      <div className="desktop-trade-buttons" role="group" aria-label={t('game:normalTrade')}>
        <button
          className="desktop-trade-button"
          type="button"
          disabled={!actionsEnabled || !bankTrade}
          title={t('game:command.bank')}
          onClick={() => openTrade('bank')}
        >
          <img src={getGameArtUrl('bankTrade')} alt="" aria-hidden="true" />
          <span>{t('game:bank')}</span>
        </button>
        <button
          className="desktop-trade-button"
          type="button"
          disabled={!actionsEnabled || !playerTrade}
          title={t('game:command.trade')}
          onClick={() => openTrade('trade')}
        >
          <img src={getGameArtUrl('playerTrade')} alt="" aria-hidden="true" />
          <span>{t('game:players')}</span>
        </button>
      </div>
    </section>
  );
  const desktopTurn = (
    <div className="desktop-turn-control" aria-busy={isSubmitting}>
      {turnCommand && (
        <button
          className={`desktop-turn-button ${turnGroup.type === 'ROLL_DICE' ? 'action-roll-dice' : ''}`}
          type="button"
          disabled={!actionsEnabled}
          onClick={() => {
            options.onHandOff?.();
            submit(turnCommand);
          }}
        >
          <span>{t(`game:command.${turnGroup.type}`)}</span>
          <small>{turnGroup.type === 'ROLL_DICE' ? 'R' : 'E'}</small>
        </button>
      )}
      {isSubmitting && (
        <span className="action-pending" role="status">
          <span className="action-spinner" aria-hidden="true" />
          {t('game:submittingAction')}
        </span>
      )}
      {error && (
        <p className="action-error" role="alert">
          {error}
        </p>
      )}
      {conflicted && <p role="alert">{t('game:saveConflictStopped')}</p>}
      {status?.kind === 'error' && <p role="alert">{stoppedText(t, status)}</p>}
    </div>
  );
  const mobileBuild = (
    <section
      className="mobile-build-panel"
      aria-label={t('game:buildPanel')}
      aria-busy={isSubmitting}
    >
      <div className="mobile-build-list">
        {buildChoices.map(({ kind, label, cost }) => (
          <button
            className={`mobile-build-row ${selectedKind === kind ? 'is-selected' : ''}`}
            type="button"
            key={kind}
            disabled={!actionsEnabled || !availability?.placements[kind].length}
            aria-label={t(`game:buildAction.${kind}`)}
            title={`${label} · ${costTitle(cost)}`}
            aria-pressed={selectedKind === kind}
            onClick={() => chooseBoardAction(kind)}
          >
            <img className="mobile-build-art" src={pieceIcon(kind)} alt="" aria-hidden="true" />
            <span className="mobile-build-copy">
              <strong>{label}</strong>
              {costIcons(cost)}
              {supplyLabel(kind) && (
                <small className="build-supply-text">{supplyLabel(kind)}</small>
              )}
            </span>
          </button>
        ))}
        {seafaring && (
          <button
            className={`mobile-build-row ${selectedKind === 'moveShip' ? 'is-selected' : ''}`}
            type="button"
            disabled={!actionsEnabled || moveShipAvailable === 0}
            aria-label={t('game:buildAction.moveShip')}
            aria-pressed={selectedKind === 'moveShip'}
            onClick={() => chooseBoardAction('moveShip')}
          >
            <img
              className="mobile-build-art"
              src={getShipIconUrl(playerColor, 5)}
              alt=""
              aria-hidden="true"
            />
            <span className="mobile-build-copy">
              <strong>{t('game:buildAction.moveShip')}</strong>
              <small className="build-supply-text">{t('game:moveShipOnce')}</small>
            </span>
          </button>
        )}
        {knights ? (
          <KnightsBuildRows
            availability={availability}
            selectedKind={selectedKind}
            disabled={!actionsEnabled}
            color={playerColor}
            onChoose={chooseBoardAction}
          />
        ) : (
          <button
            className="mobile-build-row"
            type="button"
            disabled={!actionsEnabled || !buyDevCard}
            aria-label={t('game:command.BUY_DEV_CARD')}
            title={`${t('game:buildCosts.developmentCard')} · ${costTitle(DEV_COST)}`}
            onClick={() => {
              if (buyDevCard) {
                options.onHandOff?.();
                submit(buyDevCard);
              }
            }}
          >
            <img
              className="mobile-build-art"
              src={getGameArtUrl('cardBack')}
              alt=""
              aria-hidden="true"
            />
            <span className="mobile-build-copy">
              <strong>{t('game:buildCosts.developmentCard')}</strong>
              {costIcons(DEV_COST)}
            </span>
          </button>
        )}
      </div>
      <div className="mobile-build-context">{desktopStatus}</div>
    </section>
  );
  const mobileTrade = (
    <section className="mobile-trade-panel" aria-label={t('game:tradePanel')}>
      <div className="mobile-trade-options">
        <button
          className="mobile-trade-option"
          type="button"
          disabled={!actionsEnabled || !bankTrade}
          title={t('game:command.bank')}
          onClick={() => openTrade('bank')}
        >
          <img src={getGameArtUrl('bankTrade')} alt="" aria-hidden="true" />
          <span>{t('game:bank')}</span>
        </button>
        <button
          className="mobile-trade-option"
          type="button"
          disabled={!actionsEnabled || !playerTrade}
          title={t('game:command.trade')}
          onClick={() => openTrade('trade')}
        >
          <img src={getGameArtUrl('playerTrade')} alt="" aria-hidden="true" />
          <span>{t('game:players')}</span>
        </button>
      </div>
    </section>
  );

  const inspected =
    inspectedKnight !== null
      ? knightStatus(state, seat, inspectedKnight, legal?.commands ?? [])
      : null;
  const closeKnightSheet = () => {
    setInspectedKnight(null);
    options.onFormClosed?.();
  };
  const knightSheet = inspected ? (
    <KnightSheet
      status={inspected}
      owner={playerLabel(inspected.seat)}
      color={presentation.players.find((player) => player.seat === inspected.seat)?.color ?? 'blue'}
      disabled={isSubmitting || !actionsEnabled}
      onChoose={(kind) => {
        const store = useSessionStore.getState();
        setInspectedKnight(null);
        options.onHandOff?.();
        store.choosePlacement(kind);
        store.selectShipToMove(inspected.vertex);
      }}
      onSubmit={(command) => {
        setInspectedKnight(null);
        submit(command);
      }}
      onClose={closeKnightSheet}
    />
  ) : null;

  const forms = (
    <ActionPendingContext.Provider value={isSubmitting}>
      <div className="action-forms" aria-busy={isSubmitting}>
        {!conflicted && status?.kind !== 'error' && availability && formProps && (
          <>
            {visibleForm === 'discard' && <DiscardDialog {...formProps} />}
            {visibleForm === 'steal' && !stealReveal && options.pickStealCard !== null && (
              <StealDialog
                {...formProps}
                onPickCard={options.pickStealCard ? openStealSheet : undefined}
              />
            )}
            {visibleForm === 'gold' && <GoldDialog {...formProps} />}
            {visibleForm === 'trade' && (
              <TradeComposer {...formProps} onCancel={closeFormAndFocus} />
            )}
            {visibleForm === 'bank' && (
              <BankTradePicker {...formProps} onCancel={closeFormAndFocus} />
            )}
            {visibleForm === 'plenty' && (
              <YearOfPlentyDialog
                {...formProps}
                onCancel={closeFormAndFocus}
                {...(slotId ? { slotId } : {})}
              />
            )}
            {visibleForm === 'monopoly' && (
              <MonopolyDialog
                {...formProps}
                onCancel={closeFormAndFocus}
                {...(slotId ? { slotId } : {})}
              />
            )}
            {knights && (
              <KnightsForms
                {...formProps}
                availability={availability}
                presentation={presentation}
                form={form}
                slotId={slotId}
                onCancel={closeFormAndFocus}
              />
            )}
          </>
        )}
        {stealReveal && seat !== null && (
          <StealSheet
            key={stealReveal.id}
            reveal={stealReveal}
            victimName={playerLabel(stealReveal.victim)}
            victimColor={
              presentation.players.find((player) => player.seat === stealReveal.victim)?.color ??
              'blue'
            }
            reducedMotion={options.reducedMotion ?? false}
            onPick={(index) => {
              useStealReveal.getState().pick(index);
              // Only the victim goes out: the tapped card is the sheet's own business.
              if (stealReveal.face === null && stealCommand) submit(stealCommand);
            }}
            onCancel={
              (availability?.stealTargets.length ?? 0) > 1
                ? () => useStealReveal.getState().reset()
                : undefined
            }
            onDone={(from) => {
              const done = useStealReveal.getState().finish();
              // The sheet closes first; the card then flies on from where it turned over.
              requestAnimationFrame(() => done?.launch?.(from));
              if (!useStealReveal.getState().active) options.onFormClosed?.();
            }}
          />
        )}
        <p className="steal-announcer" role="status">
          {stealAnnounced
            ? t('rules:steal.stole', {
                resource: resourceLabel(t, stealAnnounced.face),
                player: playerLabel(stealAnnounced.victim),
              })
            : ''}
        </p>
        {knightSheet}
        {buildCostsOpen && (
          <BuildCostsDialog
            knights={isKnights(state)}
            onClose={() => {
              setBuildCostsOpen(false);
              options.onFormClosed?.();
            }}
          />
        )}
      </div>
    </ActionPendingContext.Provider>
  );

  const promotedCommand = promoted?.commands[0];
  let nextStep: NextStep;
  if (conflicted) {
    nextStep = { kind: 'text', tone: 'alert', text: t('game:saveConflictStopped') };
  } else if (status?.kind === 'error') {
    nextStep = { kind: 'text', tone: 'alert', text: stoppedText(t, status) };
  } else if (voided) {
    nextStep = { kind: 'text', tone: 'muted', text: t('lobby:onlineGameVoidTitle') };
  } else if (isSubmitting) {
    nextStep = {
      kind: 'pending',
      text: t('game:submittingAction'),
      ...(submittingCommand !== null && TURN_COMMANDS.has(submittingCommand)
        ? {
            turnAction: {
              label: t(`game:command.${submittingCommand}`),
              rollDice: submittingCommand === 'ROLL_DICE',
            },
          }
        : {}),
    };
  } else if (revealing) {
    nextStep = { kind: 'pending', text: t('game:fogRevealing') };
  } else if (error) {
    nextStep = { kind: 'text', tone: 'alert', text: error };
  } else if (seat === null || !availability) {
    nextStep = { kind: 'text', tone: 'muted', text: t('game:awaitingAction') };
  } else if (selectedKind) {
    nextStep = {
      kind: 'board',
      text: selectedPlacement
        ? t('game:cockpit.confirmOnBoard')
        : t('game:cockpit.tapTarget', {
            target: knightsKind
              ? t(`knights:placement.${selectedKind}${moveFrom !== null ? 'Target' : ''}`)
              : t(
                  `game:placement.${selectedKind === 'moveShip' && moveFrom !== null ? 'moveShipTarget' : selectedKind}`,
                ),
          }),
      ...(second?.finish && !selectedPlacement
        ? {
            finish: {
              label: t(`knights:finish.${selectedKind}`),
              run: () => {
                if (second.finish) submit(second.finish.command);
              },
            },
          }
        : {}),
      ...(!mandatoryPlacement && !selectedPlacement
        ? {
            cancel: () =>
              moveFrom !== null
                ? useSessionStore.getState().selectShipToMove(null)
                : useSessionStore.getState().cancelPlacement(),
          }
        : {}),
      ...(alternatives.length > 1
        ? {
            alternatives: alternatives.map((kind) => ({
              kind,
              label: t(`game:choice.${kind}`),
              active: kind === selectedKind,
              select: () => chooseBoardAction(kind),
            })),
          }
        : {}),
    };
  } else if (promotedCommand) {
    nextStep = {
      kind: 'command',
      label: t(`game:command.${promoted?.type}`),
      rollDice: promoted?.type === 'ROLL_DICE',
      run: () => submit(promotedCommand),
    };
  } else {
    nextStep = { kind: 'text', tone: 'muted', text: t('game:cockpit.chooseAction') };
  }
  const actionCount =
    availableBoardKinds.length +
    dockCardPlays.length +
    contextualGroups.length +
    sheetNormalGroups.length;

  const confirmedPiece = selectedKind ? placedPiece(selectedKind) : null;
  const placementConfirmation =
    selectedPlacement && focusTarget && confirmedPiece
      ? {
          piece: confirmedPiece,
          move: selectedKind === 'moveShip',
          hit: focusTarget,
          label: targetLabel(focusTarget),
          kind: selectedKind ?? 'road',
          ...knightPreview(state, selectedKind, moveFrom, selectedPlacement),
          confirm: () => submit(selectedPlacement.command),
          cancel: () => {
            if (!submitting.current) useSessionStore.getState().clearPlacementCandidate();
          },
        }
      : null;
  const knightsController: KnightsController | null = knights
    ? {
        improvable: improvableTracks(availability?.improvements ?? []),
        improve: (track) => {
          const command = availability?.improvements.find((item) => item.track === track);
          if (command) submit(command);
        },
        playCard: (cardSlot, card) => {
          if (submitting.current) return;
          const info = cardInfo(card);
          const store = useSessionStore.getState();
          if (info.play === 'victory') return;
          options.onHandOff?.();
          const board = CARD_KINDS[card];
          if (info.play === 'board' && board !== undefined) store.choosePlacement(board);
          else store.openActionDialog('progress', cardSlot);
        },
        playable: (cardSlot) =>
          availability?.progressPlays.some(
            (item) => item.slotId === cardSlot && item.commands.length > 0,
          ) ?? false,
        openDiscard: () => {
          options.onHandOff?.();
          useSessionStore.getState().openActionDialog('discardProgress');
        },
        openImprovements: () => {
          options.onHandOff?.();
          useSessionStore.getState().openActionDialog('improve');
        },
        openHarbor: () => useSessionStore.getState().openActionDialog('harbor'),
        disabled: !actionsEnabled,
        harborOpen: availability?.availableTypes.includes('HARBOR_OFFER') ?? false,
      }
    : null;
  const offerOverlay =
    formProps &&
    legal?.commands.some(
      (command) =>
        ['RESPOND_TRADE', 'CANCEL_TRADE', 'CONFIRM_TRADE'].includes(command.type) &&
        typeof command.offerId === 'number',
    ) ? (
      <IncomingOffers {...formProps} collapsedWhilePlacing={selectedKind !== undefined} />
    ) : null;
  const tradeNotice =
    seat !== null ? (
      <TradeNotice state={state} events={events} seat={seat} playerLabel={playerLabel} />
    ) : null;

  return {
    actorSeat,
    availability,
    highlights,
    focusTarget,
    placementConfirmation,
    onBoardSelect,
    targetLabel,
    offerOverlay,
    tradeNotice,
    placementActive: selectedKind !== undefined,
    knightIntent:
      selectedKnight && slotId
        ? {
            slotId,
            confirm: () => {
              if (selectedKnight.commands[0]) submit(selectedKnight.commands[0]);
            },
            cancel: closeFormAndFocus,
          }
        : null,
    toggleKnightIntent,
    dock,
    desktopBuild,
    desktopStatus,
    desktopTrade,
    desktopTurn,
    mobileBuild,
    mobileTrade,
    forms,
    knights: knightsController,
    nextStep,
    actionCount,
    submitting: isSubmitting,
  };
}
