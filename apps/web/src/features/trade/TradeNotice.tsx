import { useEffect, useRef, useState } from 'react';
import type { GameEvent, GameState, Seat } from '@cp2p/engine';
import { useTranslation } from 'react-i18next';

/** How long an outcome stays on screen. */
export const TRADE_NOTICE_MS = 6_000;

interface KnownOffer {
  id: number;
  proposer: Seat;
  to: Seat[];
  acceptedBy: Seat[];
  declinedBy: Seat[];
}

export type TradeOutcome =
  | { kind: 'completed'; player: Seat }
  | { kind: 'tradedElsewhere'; proposer: Seat; player: Seat }
  | { kind: 'withdrawn'; player: Seat }
  | { kind: 'turnedDown'; player: Seat }
  | { kind: 'expired' };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function seatList(value: unknown, seats: readonly Seat[]): Seat[] {
  return Array.isArray(value) ? seats.filter((seat) => value.includes(seat)) : [];
}

/** The public offers, reduced to who is party to them. */
export function knownOffers(state: GameState): KnownOffer[] {
  const base = state.ext.base;
  const offers = record(base) && Array.isArray(base.offers) ? base.offers : [];
  const seats = state.config.seats;
  return offers.flatMap((offer) => {
    if (!record(offer) || typeof offer.id !== 'number') return [];
    const proposer = seats.find((seat) => seat === offer.proposer);
    if (proposer === undefined) return [];
    return [
      {
        id: offer.id,
        proposer,
        to: seatList(offer.to, seats),
        acceptedBy: seatList(offer.acceptedBy, seats),
        declinedBy: seatList(offer.declinedBy, seats),
      },
    ];
  });
}

/**
 * What became of the offers `seat` was waiting on: its own, and ones made to it that it has not
 * declined. Offers the seat itself closed need no word; one that vanished with no confirmation or
 * cancellation ended with the turn.
 */
export function tradeOutcomes(
  before: readonly KnownOffer[],
  after: readonly KnownOffer[],
  events: readonly GameEvent[],
  seat: Seat,
): TradeOutcome[] {
  const outcomes: TradeOutcome[] = [];
  for (const offer of before) {
    if (after.some((item) => item.id === offer.id)) continue;
    const own = offer.proposer === seat;
    if (!own && (!offer.to.includes(seat) || offer.declinedBy.includes(seat))) continue;
    const closing = events.find(
      (event) =>
        (event.type === 'tradeConfirmed' || event.type === 'tradeCancelled') &&
        event.offerId === offer.id,
    );
    const actor =
      closing?.type === 'tradeConfirmed'
        ? closing.withSeat
        : closing && 'seat' in closing
          ? closing.seat
          : undefined;
    const other = [offer.proposer, ...offer.to].find((party) => party === actor);
    if (!closing) outcomes.push({ kind: 'expired' });
    else if (closing.type === 'tradeConfirmed') {
      if (own || other === seat) {
        const player = own ? other : offer.proposer;
        if (player !== undefined) outcomes.push({ kind: 'completed', player });
      } else if (other !== undefined)
        outcomes.push({ kind: 'tradedElsewhere', proposer: offer.proposer, player: other });
    } else if (other !== undefined && other !== seat)
      outcomes.push(
        own ? { kind: 'turnedDown', player: other } : { kind: 'withdrawn', player: other },
      );
  }
  return outcomes;
}

function outcomeText(
  outcome: TradeOutcome,
  t: ReturnType<typeof useTranslation>['t'],
  playerLabel: (seat: Seat) => string,
): string {
  if (outcome.kind === 'completed')
    return t('rules:trade.notice.completed', { player: playerLabel(outcome.player) });
  if (outcome.kind === 'tradedElsewhere')
    return t('rules:trade.notice.tradedElsewhere', {
      proposer: playerLabel(outcome.proposer),
      player: playerLabel(outcome.player),
    });
  if (outcome.kind === 'withdrawn')
    return t('rules:trade.notice.withdrawn', { player: playerLabel(outcome.player) });
  if (outcome.kind === 'turnedDown')
    return t('rules:trade.notice.turnedDown', { player: playerLabel(outcome.player) });
  return t('rules:trade.notice.expired');
}

/** A short-lived line saying how the viewer's open trade ended, so a closed offer never just vanishes. */
export function TradeNotice(props: {
  state: GameState;
  events: readonly GameEvent[];
  seat: Seat;
  playerLabel: (seat: Seat) => string;
}) {
  const { state, events, seat, playerLabel } = props;
  const { t } = useTranslation('rules');
  const seen = useRef<{ offers: KnownOffer[]; events: number; seat: Seat } | null>(null);
  const [notice, setNotice] = useState<{ outcome: TradeOutcome; at: number } | null>(null);
  useEffect(() => {
    const offers = knownOffers(state);
    const previous = seen.current;
    seen.current = { offers, events: events.length, seat };
    if (!previous || previous.seat !== seat || events.length < previous.events) return;
    const outcome = tradeOutcomes(previous.offers, offers, events.slice(previous.events), seat).at(
      -1,
    );
    if (outcome) setNotice({ outcome, at: events.length });
  }, [state, events, seat]);
  useEffect(() => {
    if (notice === null) return undefined;
    const timer = window.setTimeout(() => setNotice(null), TRADE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  if (notice === null) return null;
  return (
    <p className="trade-notice" role="status">
      <span>{outcomeText(notice.outcome, t, playerLabel)}</span>
      <button
        type="button"
        className="trade-notice-dismiss"
        aria-label={t('rules:trade.notice.dismiss')}
        onClick={() => setNotice(null)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="m5 5 6 6m0-6-6 6" />
        </svg>
      </button>
    </p>
  );
}
