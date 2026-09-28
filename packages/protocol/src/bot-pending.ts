import type { GameState, Pending, Seat } from '@cp2p/engine';

type PlayerPending = Extract<Pending, { kind: 'player' }>;
type TurnView = { turn: Pick<GameState['turn'], 'activeSeat'> };

const OPTIONAL = new Set(['CLAIM_VICTORY', 'PROPOSE_TRADE', 'CANCEL_TRADE', 'RESPOND_TRADE']);

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
  // a seat other than the active one. A lone trade-only request is optional, so it waits.
  const sole = players.length === 1 ? players[0] : undefined;
  const active =
    players.find((item) => item.seat === state.turn.activeSeat) ??
    (sole?.allowed.some((type) => !OPTIONAL.has(type)) ? sole : undefined);
  return active && botSeats.has(active.seat) ? active : null;
}
