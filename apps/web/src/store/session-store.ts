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
}

interface SessionActions {
  reveal(seat: Seat): void;
  conceal(): void;
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
};

let liveSession: GameSession | null = null;
let privacyPaused = false;
let externalPaused = false;
let manuallyConcealed = false;
let lastRequiredSeat: Seat | null = null;

function setPrivacyPaused(paused: boolean): void {
  if (privacyPaused === paused) return;
  privacyPaused = paused;
  liveSession?.setPaused?.(privacyPaused || externalPaused);
}

/** An external writer stops bots and timers until this session is discarded. */
export function pauseForExternalConflict(): void {
  externalPaused = true;
  liveSession?.setPaused?.(true);
}

function requiredHumanSeat(
  state: GameState,
  pending: readonly Pending[],
  humans: readonly Seat[],
): Seat | null {
  const players = pending.filter((entry) => entry.kind === 'player');
  const interrupt = players.find(
    (entry) =>
      humans.includes(entry.seat) &&
      entry.allowed.some((type) => type === 'DISCARD' || type === 'RESPOND_TRADE'),
  );
  if (interrupt) return interrupt.seat;
  const required = players.find(
    (entry) =>
      humans.includes(entry.seat) && entry.allowed.some((type) => type !== 'CLAIM_VICTORY'),
  );
  if (required) return required.seat;
  const active = players.find((entry) => entry.seat === state.turn.activeSeat);
  return active && humans.includes(active.seat) ? active.seat : null;
}

export const useSessionStore = create<SessionStore>((set) => ({
  ...emptyView,
  reveal: (seat) => {
    const session = liveSession;
    if (!session || !session.controllableSeats().includes(seat)) return;
    if (
      requiredHumanSeat(session.getState(), session.getPending(), session.controllableSeats()) !==
      seat
    )
      return;
    const privateState = session.getPrivate(seat);
    if (!privateState) return;
    manuallyConcealed = false;
    set({
      revealedSeat: seat,
      privateState,
      legal: session.getLegalCommands(seat),
    });
    setPrivacyPaused(false);
  },
  conceal: () => {
    manuallyConcealed = true;
    set({ revealedSeat: null, privateState: null, legal: null });
    setPrivacyPaused(true);
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
  useSessionStore.setState({ ...emptyView, gameId });
  const unsubscribe = session.subscribe((update) => {
    const current = useSessionStore.getState();
    const humans = session.controllableSeats();
    const requiredSeat = requiredHumanSeat(update.state, update.pending, humans);
    if (requiredSeat !== lastRequiredSeat) manuallyConcealed = false;
    lastRequiredSeat = requiredSeat;
    const keepPrivate = current.revealedSeat !== null && current.revealedSeat === requiredSeat;
    const visibleSeat =
      keepPrivate || (humans.length === 1 && !manuallyConcealed) ? requiredSeat : null;
    useSessionStore.setState({
      gameId,
      state: update.state,
      events: session.getEvents(),
      pending: update.pending,
      timers: update.timers,
      status: update.status,
      revision: update.revision,
      waitingSeat: requiredSeat,
      revealedSeat: visibleSeat,
      privateState: visibleSeat === null ? null : session.getPrivate(visibleSeat),
      legal: visibleSeat === null ? null : session.getLegalCommands(visibleSeat),
    });
    setPrivacyPaused(requiredSeat !== null && visibleSeat === null);
  });
  session.setPaused?.(privacyPaused || externalPaused);
  return () => {
    unsubscribe();
    if (liveSession === session) liveSession = null;
    privacyPaused = false;
    externalPaused = false;
    manuallyConcealed = false;
    lastRequiredSeat = null;
    useSessionStore.setState({ ...emptyView });
  };
}

export function sessionForActions(): GameSession | null {
  return liveSession;
}
