import type { GameState, Pending, Seat } from '@cp2p/engine';

const OPTIONAL_ACTIONS = new Set([
  'CLAIM_VICTORY',
  'PROPOSE_TRADE',
  'CANCEL_TRADE',
  'RESPOND_TRADE',
]);

function playerPending(item: Pending): item is Extract<Pending, { kind: 'player' }> {
  return item.kind === 'player';
}

/** Resolve the seat that must act without treating optional trade replies as a turn handoff. */
export function actingSeat(state: GameState, pending: readonly Pending[]): Seat {
  const discard = pending.find((item) => playerPending(item) && item.allowed.includes('DISCARD'));
  if (discard?.kind === 'player') return discard.seat;
  const required = pending.find(
    (item) => playerPending(item) && item.allowed.some((type) => !OPTIONAL_ACTIONS.has(type)),
  );
  return required?.kind === 'player' ? required.seat : state.turn.activeSeat;
}

/** A human cover is needed only for a required action assigned to that human. */
export function requiredHumanSeat(
  state: GameState,
  pending: readonly Pending[],
  humans: readonly Seat[],
): Seat | null {
  const discard = pending.find(
    (item) => playerPending(item) && humans.includes(item.seat) && item.allowed.includes('DISCARD'),
  );
  if (discard?.kind === 'player') return discard.seat;
  const seat = actingSeat(state, pending);
  const required = pending.some(
    (item) =>
      playerPending(item) &&
      item.seat === seat &&
      item.allowed.some((type) => !OPTIONAL_ACTIONS.has(type)),
  );
  return required && humans.includes(seat) ? seat : null;
}
