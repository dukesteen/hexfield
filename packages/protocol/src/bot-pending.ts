import type { GameState, Pending, Seat } from '@cp2p/engine';

type PlayerPending = Extract<Pending, { kind: 'player' }>;
type TurnView = { turn: Pick<GameState['turn'], 'activeSeat'> };

/** Select one mandatory or active-player action for an eligible hosted bot. */
export function chooseBotPending(
  state: TurnView,
  pending: readonly Pending[],
  botSeats: ReadonlySet<Seat>,
): PlayerPending | null {
  const players = pending.filter(
    (item): item is PlayerPending =>
      item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
  );

  const discard = players.find((item) => item.allowed.includes('DISCARD'));
  if (discard) return botSeats.has(discard.seat) ? discard : null;

  const response = players.find(
    (item) => item.seat !== state.turn.activeSeat && item.allowed.includes('RESPOND_TRADE'),
  );
  if (response) return botSeats.has(response.seat) ? response : null;

  // Between turns (a special build phase) the only actionable request can belong to
  // a seat other than the active one.
  const active =
    players.find((item) => item.seat === state.turn.activeSeat) ??
    (players.length === 1 ? players[0] : undefined);
  return active && botSeats.has(active.seat) ? active : null;
}
