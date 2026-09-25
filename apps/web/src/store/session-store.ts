import { create } from 'zustand';
import type {
  GameEvent,
  GameState,
  LegalCommandSet,
  Pending,
  PrivateState,
  Seat,
} from '@cp2p/engine';
import type { GameSession, SessionStatus, SessionTimer } from '../session';
import type { EdgeId, VertexId } from '@cp2p/engine/geometry';
import { requiredHumanSeat } from './pending-actors';

export type PlacementCandidate =
  | { readonly kind: 'road' | 'freeRoad'; readonly id: EdgeId }
  | { readonly kind: 'settlement' | 'city'; readonly id: VertexId };

interface SessionView {
  gameId: string | null;
  state: GameState | null;
  events: readonly GameEvent[];
  pending: readonly Pending[];
  timers: readonly SessionTimer[];
  status: SessionStatus | null;
  revision: number;
  waitingSeat: Seat | null;
  revealedSeat: Seat | null;
  privateState: PrivateState | null;
  legal: LegalCommandSet | null;
  placementMode: 'road' | 'settlement' | 'city' | 'freeRoad' | 'robber' | null;
  placementCancelled: boolean;
  previewPlacement: PlacementCandidate | null;
  openDialog: 'discard' | 'steal' | 'trade' | 'bank' | 'plenty' | 'monopoly' | null;
  selectedCardSlot: string | null;
  optionalChoices: readonly Seat[];
  optionalViewingSeat: Seat | null;
  conflicted: boolean;
  finalHiddenVictoryPoints: Partial<Record<Seat, number | null>>;
}

interface SessionActions {
  reveal(seat: Seat): void;
  autoReveal(seat: Seat): void;
  conceal(): void;
  choosePlacement(mode: SessionView['placementMode']): void;
  cancelPlacement(): void;
  selectPlacementCandidate(candidate: PlacementCandidate): void;
  clearPlacementCandidate(): void;
  openActionDialog(dialog: SessionView['openDialog'], slotId?: string): void;
  closeActionDialog(): void;
  viewOptionalSeat(seat: Seat): void;
  leaveOptionalSeat(): void;
}

export type SessionStore = SessionView & SessionActions;

const emptyView: SessionView = {
  gameId: null,
  state: null,
  events: [],
  pending: [],
  timers: [],
  status: null,
  revision: 0,
  waitingSeat: null,
  revealedSeat: null,
  privateState: null,
  legal: null,
  placementMode: null,
  placementCancelled: false,
  previewPlacement: null,
  openDialog: null,
  selectedCardSlot: null,
  optionalChoices: [],
  optionalViewingSeat: null,
  conflicted: false,
  finalHiddenVictoryPoints: {},
};

let liveSession: GameSession | null = null;
let privacyPaused = false;
let externalPaused = false;
let manuallyConcealed = false;
let lastRequiredSeat: Seat | null = null;
let lastActionContext = '';
let optionalSeat: Seat | null = null;

const emptyActionView = {
  placementMode: null,
  placementCancelled: false,
  previewPlacement: null,
  openDialog: null,
  selectedCardSlot: null,
} as const;

function setPrivacyPaused(paused: boolean): void {
  if (privacyPaused === paused) return;
  privacyPaused = paused;
  liveSession?.setPaused?.(privacyPaused || externalPaused);
}

/** Restore the store's pause reasons after a temporary navigation save pause. */
export function restoreSessionPause(): void {
  liveSession?.setPaused?.(privacyPaused || externalPaused);
}

/** An external writer stops bots and timers until this session is discarded. */
export function pauseForExternalConflict(): void {
  externalPaused = true;
  liveSession?.setPaused?.(true);
  useSessionStore.setState({
    conflicted: true,
    revealedSeat: null,
    privateState: null,
    legal: null,
    ...emptyActionView,
  });
}

export const useSessionStore = create<SessionStore>((set) => ({
  ...emptyView,
  autoReveal: (seat) => {
    if (!manuallyConcealed) useSessionStore.getState().reveal(seat);
  },
  reveal: (seat) => {
    const session = liveSession;
    if (externalPaused || !session || !session.controllableSeats().includes(seat)) return;
    const humans = session.controllableSeats();
    const required = requiredHumanSeat(session.getState(), session.getPending(), humans);
    if ((optionalSeat ?? required) !== seat && !(required === null && humans.length === 1)) return;
    const privateState = session.getPrivate(seat);
    if (!privateState) return;
    manuallyConcealed = false;
    set({
      revealedSeat: seat,
      privateState,
      legal: session.getLegalCommands(seat),
      ...emptyActionView,
    });
    setPrivacyPaused(false);
  },
  conceal: () => {
    manuallyConcealed = true;
    const onlyHuman = liveSession?.controllableSeats().length === 1;
    set((current) => ({
      waitingSeat: onlyHuman ? current.revealedSeat : current.waitingSeat,
      revealedSeat: null,
      privateState: null,
      legal: null,
      ...emptyActionView,
    }));
    setPrivacyPaused(true);
  },
  choosePlacement: (mode) =>
    set({
      placementMode: mode,
      placementCancelled: false,
      previewPlacement: null,
      openDialog: null,
    }),
  cancelPlacement: () =>
    set({ placementMode: null, placementCancelled: true, previewPlacement: null }),
  selectPlacementCandidate: (candidate) => set({ previewPlacement: candidate }),
  clearPlacementCandidate: () => set({ previewPlacement: null }),
  openActionDialog: (dialog, slotId) =>
    set({
      openDialog: dialog,
      selectedCardSlot: slotId ?? null,
      placementMode: null,
      previewPlacement: null,
    }),
  closeActionDialog: () => set({ openDialog: null, selectedCardSlot: null }),
  viewOptionalSeat: (seat) => {
    const session = liveSession;
    if (externalPaused || !session || !useSessionStore.getState().optionalChoices.includes(seat))
      return;
    optionalSeat = seat;
    manuallyConcealed = false;
    set({
      optionalViewingSeat: seat,
      waitingSeat: seat,
      revealedSeat: null,
      privateState: null,
      legal: null,
      ...emptyActionView,
    });
    setPrivacyPaused(true);
  },
  leaveOptionalSeat: () => {
    optionalSeat = null;
    manuallyConcealed = false;
    const session = liveSession;
    const required = session
      ? requiredHumanSeat(session.getState(), session.getPending(), session.controllableSeats())
      : null;
    set({
      optionalViewingSeat: null,
      waitingSeat: required,
      revealedSeat: null,
      privateState: null,
      legal: null,
      ...emptyActionView,
    });
    setPrivacyPaused(required !== null);
  },
}));

/** The UI owns the subscription; the store never persists or copies other seats' secrets. */
export function attachSession(gameId: string, session: GameSession): () => void {
  if (liveSession && liveSession !== session)
    throw new Error('Another game session is still attached');
  liveSession = session;
  privacyPaused = false;
  externalPaused = false;
  manuallyConcealed = false;
  lastRequiredSeat = null;
  lastActionContext = '';
  optionalSeat = null;
  useSessionStore.setState({ ...emptyView, gameId });
  const unsubscribe = session.subscribe((update) => {
    const current = useSessionStore.getState();
    const humans = session.controllableSeats();
    const requiredSeat = requiredHumanSeat(update.state, update.pending, humans);
    const mandatoryDiscard = update.pending.some(
      (item) => item.kind === 'player' && item.allowed.includes('DISCARD'),
    );
    const optionalChoices =
      mandatoryDiscard || humans.length <= 1
        ? []
        : update.pending.flatMap((item) =>
            item.kind === 'player' &&
            item.seat !== update.state.turn.activeSeat &&
            humans.includes(item.seat) &&
            item.allowed.some(
              (type) =>
                type === 'PROPOSE_TRADE' || type === 'CANCEL_TRADE' || type === 'RESPOND_TRADE',
            )
              ? [item.seat]
              : [],
          );
    if (optionalSeat !== null && !optionalChoices.includes(optionalSeat)) optionalSeat = null;
    const desiredSeat = optionalSeat ?? requiredSeat;
    const activePending = update.pending.find(
      (item) => item.kind === 'player' && item.seat === requiredSeat,
    );
    const actionContext = `${desiredSeat ?? 'none'}:${update.state.turn.phase
      .map((phase) => phase.id)
      .join('/')}:${activePending?.kind === 'player' ? activePending.allowed.join(',') : ''}`;
    const resetAction = actionContext !== lastActionContext;
    lastActionContext = actionContext;
    if (desiredSeat !== lastRequiredSeat) manuallyConcealed = false;
    lastRequiredSeat = desiredSeat;
    const keepPrivate = current.revealedSeat !== null && current.revealedSeat === desiredSeat;
    const visibleSeat = externalPaused
      ? null
      : desiredSeat !== null
        ? keepPrivate || (humans.length === 1 && !manuallyConcealed)
          ? desiredSeat
          : null
        : humans.length === 1 && !manuallyConcealed
          ? (humans[0] ?? null)
          : null;
    const coverSeat =
      desiredSeat ?? (humans.length === 1 && manuallyConcealed ? (humans[0] ?? null) : null);
    const finalHiddenVictoryPoints: Partial<Record<Seat, number | null>> = {};
    if (update.state.result) {
      for (const seat of update.state.config.seats) {
        const privateState = session.getPrivate(seat);
        const publicSeat = update.state.seats.find((item) => item.seat === seat);
        finalHiddenVictoryPoints[seat] =
          privateState && publicSeat
            ? publicSeat.cardSlots.filter(
                (slot) => !slot.revealed && privateState.slots[slot.slotId] === 'victoryPoint',
              ).length
            : null;
      }
    }
    useSessionStore.setState({
      gameId,
      state: update.state,
      events: session.getEvents(),
      pending: update.pending,
      timers: update.timers,
      status: update.status,
      revision: update.revision,
      waitingSeat: coverSeat,
      revealedSeat: visibleSeat,
      privateState: visibleSeat === null ? null : session.getPrivate(visibleSeat),
      legal: visibleSeat === null ? null : session.getLegalCommands(visibleSeat),
      optionalChoices,
      optionalViewingSeat: optionalSeat,
      conflicted: externalPaused,
      finalHiddenVictoryPoints,
      ...(resetAction || visibleSeat === null
        ? emptyActionView
        : update.revision !== current.revision
          ? { previewPlacement: null }
          : {}),
    });
    setPrivacyPaused(coverSeat !== null && visibleSeat === null);
  });
  session.setPaused?.(privacyPaused || externalPaused);
  return () => {
    unsubscribe();
    if (liveSession === session) liveSession = null;
    privacyPaused = false;
    externalPaused = false;
    manuallyConcealed = false;
    lastRequiredSeat = null;
    lastActionContext = '';
    optionalSeat = null;
    useSessionStore.setState({ ...emptyView });
  };
}

export function sessionForActions(): GameSession | null {
  return liveSession;
}
