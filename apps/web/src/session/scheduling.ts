import type { GameState, Pending, Seat } from '@cp2p/engine';

type PlayerPending = Extract<Pending, { kind: 'player' }>;

/** The full stack distinguishes a resumed phase from a different turn or interruption. */
export function phaseIdentity(state: GameState): string {
  return state.turn.phase.map((frame) => `${frame.module}/${frame.id}`).join('>');
}

function unansweredOfferId(state: GameState, seat: Seat): number | null {
  const base = state.ext.base;
  const offers = typeof base === 'object' && base !== null ? Reflect.get(base, 'offers') : null;
  if (!Array.isArray(offers)) return null;
  let oldest: number | null = null;
  for (const offer of offers) {
    if (typeof offer !== 'object' || offer === null) continue;
    const id = Reflect.get(offer, 'id');
    const to = Reflect.get(offer, 'to');
    const accepted = Reflect.get(offer, 'acceptedBy');
    const declined = Reflect.get(offer, 'declinedBy');
    if (
      Reflect.get(offer, 'proposer') === state.turn.activeSeat &&
      typeof id === 'number' &&
      Number.isSafeInteger(id) &&
      Array.isArray(to) &&
      to.includes(seat) &&
      Array.isArray(accepted) &&
      !accepted.includes(seat) &&
      Array.isArray(declined) &&
      !declined.includes(seat) &&
      (oldest === null || id < oldest)
    )
      oldest = id;
  }
  return oldest;
}

/** Stable wall-clock budget identity; responder identity includes the offer being answered. */
export function timerKey(state: GameState, pending: PlayerPending): string | null {
  if (!pending.deadline) return null;
  const turn = state.turn.number;
  if (pending.seat === state.turn.activeSeat || pending.allowed.includes('DISCARD'))
    return `${turn}|${pending.seat}|${phaseIdentity(state)}`;
  if (!pending.allowed.includes('RESPOND_TRADE')) return null;
  const offerId = unansweredOfferId(state, pending.seat);
  return offerId === null ? null : `${turn}|${pending.seat}|respond|${offerId}`;
}

/** One bot action per tick; wait for mandatory human discards and trade responses. */
export function chooseBotPending(
  state: GameState,
  pending: readonly Pending[],
  botSeats: ReadonlySet<Seat>,
): PlayerPending | null {
  const players = pending.filter(
    (item): item is PlayerPending =>
      item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
  );
  const mandatory = players.find((item) => item.allowed.includes('DISCARD'));
  if (mandatory) return botSeats.has(mandatory.seat) ? mandatory : null;
  const response = players.find(
    (item) => item.seat !== state.turn.activeSeat && item.allowed.includes('RESPOND_TRADE'),
  );
  if (response) return botSeats.has(response.seat) ? response : null;
  const active = players.find((item) => item.seat === state.turn.activeSeat);
  return active && botSeats.has(active.seat) ? active : null;
}
