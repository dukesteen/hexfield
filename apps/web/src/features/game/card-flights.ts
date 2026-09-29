import type { Seat } from '@cp2p/engine';

type Counts = Readonly<Record<string, number>>;

/** Where a card flight starts or ends: a seat (its hand or its panel), or the bank. */
export type CardEnd = Seat | 'bank';

/** Cards that changed hands in one public event. */
export interface CardTransfer {
  readonly id: string;
  readonly from: CardEnd;
  readonly to: CardEnd;
  /** The kinds moved when they are public, or null when only the count is. */
  readonly cards: Counts | null;
  readonly count: number;
}

/** The revealed seat's own hand around one update: the only private kinds a flight may show. */
export interface HandView {
  readonly seat: Seat;
  readonly before: Counts;
  readonly after: Counts;
}

export interface CardFlight {
  readonly id: string;
  readonly from: CardEnd;
  readonly to: CardEnd;
  /** The card face, or null for a card back whose kind this viewer may not see. */
  readonly face: string | null;
  readonly count: number;
  /** The face came from the viewer's private hand, so only that seat's screen may show it. */
  readonly private: boolean;
}

function kindsOf(view: HandView): string[] {
  return [...new Set([...Object.keys(view.before), ...Object.keys(view.after)])];
}

/** Take up to `count` cards from a pool, of `kind` or of any kind in order. */
function take(
  pool: Map<string, number>,
  count: number,
  kind?: string,
): { kind: string; count: number }[] {
  const taken: { kind: string; count: number }[] = [];
  let left = count;
  for (const [candidate, held] of pool) {
    if (left <= 0) break;
    if (kind !== undefined && candidate !== kind) continue;
    const moved = Math.min(held, left);
    if (moved <= 0) continue;
    pool.set(candidate, held - moved);
    left -= moved;
    taken.push({ kind: candidate, count: moved });
  }
  return taken;
}

/**
 * Card flights for one update as this viewer may see them. A transfer the viewer is not a party
 * to shows its public kinds or a card back. A transfer into or out of the viewer's hand shows the
 * kinds read from the change in that hand, which is what the client itself knows; any change no
 * event explains (bank trades, payments, rewards, discards) flies to or from the bank. `claimed`
 * are the viewer's gains another cue already flies (production from its tiles).
 */
export function assignCardFlights(
  transfers: readonly CardTransfer[],
  viewer: HandView | null,
  claimed: Counts,
  revision: number,
): CardFlight[] {
  const gains = new Map<string, number>();
  const losses = new Map<string, number>();
  if (viewer)
    for (const kind of kindsOf(viewer)) {
      const change = (viewer.after[kind] ?? 0) - (viewer.before[kind] ?? 0);
      if (change > 0) gains.set(kind, Math.max(0, change - (claimed[kind] ?? 0)));
      if (change < 0) losses.set(kind, -change);
    }
  const flights: CardFlight[] = [];
  for (const transfer of transfers) {
    const into = viewer !== null && transfer.to === viewer.seat;
    const outOf = viewer !== null && transfer.from === viewer.seat;
    const base = { from: transfer.from, to: transfer.to };
    if (!into && !outOf) {
      if (transfer.cards) {
        for (const [kind, count] of Object.entries(transfer.cards))
          if (count > 0)
            flights.push({
              ...base,
              id: `${transfer.id}:${kind}`,
              face: kind,
              count,
              private: false,
            });
      } else if (transfer.count > 0) {
        flights.push({
          ...base,
          id: transfer.id,
          face: null,
          count: transfer.count,
          private: false,
        });
      }
      continue;
    }
    const pool = into ? gains : losses;
    const moved = transfer.cards
      ? Object.entries(transfer.cards).flatMap(([kind, count]) =>
          count > 0 ? take(pool, count, kind) : [],
        )
      : take(pool, transfer.count);
    for (const { kind, count } of moved)
      flights.push({
        ...base,
        id: `${transfer.id}:${kind}`,
        face: kind,
        count,
        private: transfer.cards === null,
      });
  }
  if (viewer) {
    for (const [kind, count] of gains)
      if (count > 0)
        flights.push({
          id: `${revision}:bank:in:${kind}`,
          from: 'bank',
          to: viewer.seat,
          face: kind,
          count,
          private: true,
        });
    for (const [kind, count] of losses)
      if (count > 0)
        flights.push({
          id: `${revision}:bank:out:${kind}`,
          from: viewer.seat,
          to: 'bank',
          face: kind,
          count,
          private: true,
        });
  }
  return flights;
}
