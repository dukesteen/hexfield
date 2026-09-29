import type { GameState, Pending, Seat } from '@cp2p/engine';

type PlayerPending = Extract<Pending, { kind: 'player' }>;
type TurnView = { turn: Pick<GameState['turn'], 'activeSeat'> };

const OPTIONAL = new Set(['CLAIM_VICTORY', 'PROPOSE_TRADE', 'CANCEL_TRADE', 'RESPOND_TRADE']);

/**
 * How long an active hosted bot gives replies it cannot make itself (a person's, or a bot hosted
 * elsewhere) before it settles its trade offer anyway: it trades with whoever accepted, or
 * withdraws the offer.
 */
export const BOT_TRADE_PATIENCE_MS = 15_000;

function playerPendings(pending: readonly Pending[]): PlayerPending[] {
  return pending.filter(
    (item): item is PlayerPending =>
      item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
  );
}

function responders(state: TurnView, players: readonly PlayerPending[]): PlayerPending[] {
  return players.filter(
    (item) => item.seat !== state.turn.activeSeat && item.allowed.includes('RESPOND_TRADE'),
  );
}

/** Select one mandatory or active-player action for an eligible hosted bot. */
export function chooseBotPending(
  state: TurnView,
  pending: readonly Pending[],
  botSeats: ReadonlySet<Seat>,
): PlayerPending | null {
  const players = playerPendings(pending);

  const discard = players.find((item) => item.allowed.includes('DISCARD'));
  if (discard) return botSeats.has(discard.seat) ? discard : null;

  // Hosted bots answer an open offer at once, whatever other seats still owe.
  const owedReplies = responders(state, players);
  const reply = owedReplies.find((item) => botSeats.has(item.seat));
  if (reply) return reply;
  // Only replies from elsewhere remain: an active hosted bot waits for them (the scheduler gives
  // them BOT_TRADE_PATIENCE_MS) and then settles its offer; any other seat simply waits.
  if (owedReplies.length) {
    const offerer = players.find((item) => item.seat === state.turn.activeSeat);
    return offerer && botSeats.has(offerer.seat) ? offerer : null;
  }

  // A choice another seat owes off its turn (a Wedding gift, a Saboteur discard, a Harbor reply,
  // a surplus progress card, a displaced knight) belongs to whoever hosts that seat.
  const owed = players.find(
    (item) =>
      item.seat !== state.turn.activeSeat &&
      botSeats.has(item.seat) &&
      item.allowed.some((type) => !OPTIONAL.has(type)),
  );
  if (owed) return owed;

  // Between turns (a special build phase) the only actionable request can belong to
  // a seat other than the active one. A lone trade-only request is optional, so it waits.
  const sole = players.length === 1 ? players[0] : undefined;
  const active =
    players.find((item) => item.seat === state.turn.activeSeat) ??
    (sole?.allowed.some((type) => !OPTIONAL.has(type)) ? sole : undefined);
  return active && botSeats.has(active.seat) ? active : null;
}

/**
 * True when the action `chooseBotPending` picks is an active hosted bot's while seats it does not
 * host still owe replies to its offer. Schedulers then wait BOT_TRADE_PATIENCE_MS, not the usual
 * bot delay, so a person has time to answer before the bot settles the offer.
 */
export function botAwaitsTradeReplies(
  state: TurnView,
  pending: readonly Pending[],
  botSeats: ReadonlySet<Seat>,
): boolean {
  const chosen = chooseBotPending(state, pending, botSeats);
  return (
    chosen !== null &&
    chosen.seat === state.turn.activeSeat &&
    responders(state, playerPendings(pending)).length > 0
  );
}
