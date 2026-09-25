import type { GameState, Pending, Seat } from '@cp2p/engine';

type PlayerPending = Extract<Pending, { kind: 'player' }>;

export { phaseIdentity, timerKey } from '@cp2p/protocol';

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
