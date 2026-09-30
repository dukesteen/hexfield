import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { RESOURCES, isBaseResource, type GameState, type Resource, type Seat } from '@cp2p/engine';
import type { GameSession } from '@cp2p/protocol';
import type { BoardRenderer } from '@cp2p/renderer';
import {
  DICE_SETTLE_MS,
  getCommodityCardUrl,
  getGameArtUrl,
  getResourceCardUrl,
} from '@cp2p/renderer';
import { sessionForActions, useSessionStore } from '../../store/session-store';
import type { CardEnd, CardFlight, HandView } from './card-flights';
import { useCardHolds, type CountHold } from './card-holds';
import { useStealReveal, type ScreenPoint } from './steal-reveal';
import { deriveVisualEffects, type ProductionGain } from './visual-effects';
import './trade-card-flight.css';
import './steal-card-flight.css';

interface FlightView {
  id: string;
  resource: Resource;
  count: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

interface CardFlightView {
  id: string;
  /** The face to draw, or null for a card back. */
  face: string | null;
  count: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** A stolen card that turns over from its back to its face on the way. */
  reveal?: boolean;
}

/**
 * Flight timings, matching the CSS animations: every card (production, trade, steal) flies for
 * 1.15 s with an ease-out and counts as landed when it reaches its slot, at 80% of the flight.
 */
export const CARD_FLIGHT_MS = 1150;
export const CARD_LANDS_MS = 920;
/** The gap between production cards taking off, and the most the whole batch may spread over. */
export const PRODUCTION_STAGGER_MS = 130;
export const PRODUCTION_SPREAD_MS = 450;
const SCROLL_SETTLE_MS = 350;
/** How long past its flight a hold may live if its flight never reports back. */
const HOLD_SLACK_MS = 2000;
/** The longest a stolen card waits on the steal sheet before its count shows anyway. */
const REVEAL_HOLD_MS = 120_000;

interface TimedProductionGain extends ProductionGain {
  readonly expiresAt: number;
}

export interface ProductionReceipt {
  readonly seat: Seat;
  readonly resources: Partial<Record<Resource, number>>;
  readonly expiresAt: number;
}

const PRODUCTION_RECEIPT_MS = 8_000;
const NO_PRODUCTION_GAINS: readonly TimedProductionGain[] = [];

/** Retain independent public production batches and expose their active seat totals. */
export function useProductionReceipts(session: object | null): {
  receipts: readonly ProductionReceipt[];
  add: (gains: readonly ProductionGain[]) => void;
} {
  const [stored, setStored] = useState<{
    session: object | null;
    gains: readonly TimedProductionGain[];
  }>({ session, gains: [] });
  const gains = stored.session === session ? stored.gains : NO_PRODUCTION_GAINS;

  useEffect(() => {
    setStored((current) =>
      current.session === session ? current : { session, gains: NO_PRODUCTION_GAINS },
    );
  }, [session]);

  const add = useCallback(
    (incoming: readonly ProductionGain[]) => {
      if (incoming.length === 0) return;
      const expiresAt = Date.now() + PRODUCTION_RECEIPT_MS;
      setStored((current) => ({
        session,
        gains: [
          ...(current.session === session ? current.gains : []),
          ...incoming.map((gain) => ({ ...gain, expiresAt })),
        ],
      }));
    },
    [session],
  );

  useEffect(() => {
    if (gains.length === 0) return undefined;
    const expiresAt = Math.min(...gains.map((gain) => gain.expiresAt));
    const timer = window.setTimeout(
      () => {
        const now = Date.now();
        setStored((current) =>
          current.session === session
            ? { session, gains: current.gains.filter((gain) => gain.expiresAt > now) }
            : current,
        );
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [gains, session]);

  const totals = new Map<
    Seat,
    { resources: Partial<Record<Resource, number>>; expiresAt: number }
  >();
  for (const gain of gains) {
    const total = totals.get(gain.seat) ?? { resources: {}, expiresAt: 0 };
    for (const resource of RESOURCES) {
      const count = gain.resources[resource];
      if (count !== undefined) total.resources[resource] = (total.resources[resource] ?? 0) + count;
    }
    total.expiresAt = Math.max(total.expiresAt, gain.expiresAt);
    totals.set(gain.seat, total);
  }
  const receipts = [...totals]
    .toSorted(([seatA], [seatB]) => seatA - seatB)
    .map(([seat, total]) => ({ seat, ...total }));
  return { receipts, add };
}

/** Overflow values that clip a scrolled child. */
const CLIPPING = new Set(['auto', 'clip', 'hidden', 'scroll']);

function visibleCenter(element: HTMLElement): { x: number; y: number } | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  if (point.x < 0 || point.y < 0 || point.x > window.innerWidth || point.y > window.innerHeight)
    return null;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const parentRect = parent.getBoundingClientRect();
    const clipsX = CLIPPING.has(style.overflowX);
    const clipsY = CLIPPING.has(style.overflowY);
    if (
      (clipsX &&
        (point.x < parentRect.left + parent.clientLeft ||
          point.x > parentRect.left + parent.clientLeft + parent.clientWidth)) ||
      (clipsY &&
        (point.y < parentRect.top + parent.clientTop ||
          point.y > parentRect.top + parent.clientTop + parent.clientHeight))
    )
      return null;
  }
  return point;
}

type Point = { x: number; y: number };

/**
 * When the nth of `total` production cards takes off: as the dice settle (with the token pulse),
 * staggered so the last one leaves within the spread however many cards a roll pays.
 */
export function productionLaunchAt(index: number, total: number, rolled: boolean): number {
  const stagger =
    total > 1 ? Math.min(PRODUCTION_STAGGER_MS, PRODUCTION_SPREAD_MS / (total - 1)) : 0;
  return (rolled ? DICE_SETTLE_MS : 0) + Math.round(index * stagger);
}

function flightStyle(flight: { x: number; y: number; dx: number; dy: number }) {
  return {
    left: flight.x,
    top: flight.y,
    '--flight-dx': `${flight.dx}px`,
    '--flight-dy': `${flight.dy}px`,
  } satisfies CSSProperties & { '--flight-dx': string; '--flight-dy': string };
}

function cardFaceUrl(kind: string): string {
  if (isBaseResource(kind)) return getResourceCardUrl(kind);
  return getCommodityCardUrl(kind === 'paper' || kind === 'cloth' ? kind : 'coin');
}

/** The revealed seat's slot for a card kind in the hand dock. */
function handSlot(seat: Seat, kind: string): HTMLElement | null {
  if (useSessionStore.getState().revealedSeat !== seat) return null;
  return document.querySelector<HTMLElement>(`.hand-dock [data-resource="${kind}"] img`);
}

/** A fair steal result flying into the viewer's own hand, whose face the viewer may see. */
export function isStealInto(
  flight: CardFlight,
  seat: Seat,
): flight is CardFlight & { from: Seat; face: string } {
  return (
    flight.id.includes(':steal:') &&
    flight.to === seat &&
    flight.from !== 'bank' &&
    flight.face !== null
  );
}

function seatPanel(seat: Seat): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-seat-panel="${seat}"]`);
}

function centerOf(selector: string): Point | null {
  const element = document.querySelector<HTMLElement>(selector);
  return element ? visibleCenter(element) : null;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The nearest visible point to an element scrolled out of its container (a panel further down a
 * player rail), so a card still flies toward it.
 */
function edgeOfView(element: HTMLElement): Point | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  let left = 0;
  let top = 0;
  let right = window.innerWidth;
  let bottom = window.innerHeight;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (![style.overflowX, style.overflowY].some((value) => CLIPPING.has(value))) continue;
    const box = parent.getBoundingClientRect();
    left = Math.max(left, box.left + parent.clientLeft);
    top = Math.max(top, box.top + parent.clientTop);
    right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth);
    bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight);
  }
  if (right <= left || bottom <= top) return null;
  return {
    x: clamp(rect.left + rect.width / 2, left, right),
    y: clamp(rect.top + rect.height / 2, top, bottom),
  };
}

/** A slot that exists but is scrolled out of its hand; it can be brought into view first. */
function clippedSlot(slot: HTMLElement | null): HTMLElement | null {
  return slot && slot.getBoundingClientRect().width > 0 && !visibleCenter(slot) ? slot : null;
}

/**
 * Where a card leaves or lands: the kind's slot in the revealed hand, else the hand, else the
 * seat's panel; for the bank, that kind's bank card, else the bank, else the board.
 */
function cardEndPoint(end: CardEnd, face: string | null): Point | null {
  if (end === 'bank')
    return (
      (face ? centerOf(`.bank-panel [data-resource="${face}"]`) : null) ??
      centerOf('.bank-panel') ??
      centerOf('.board-view-canvas')
    );
  const slot = face ? handSlot(end, face) : null;
  const shown = useSessionStore.getState().revealedSeat === end;
  const panel = seatPanel(end);
  return (
    (slot && visibleCenter(slot)) ??
    (shown ? centerOf('.hand-dock .hand-cards') : null) ??
    (panel && (visibleCenter(panel) ?? edgeOfView(panel)))
  );
}

/** The true hands this client may read, by seat. */
function knownHands(session: GameSession, state: GameState): Map<Seat, Record<string, number>> {
  const hands = new Map<Seat, Record<string, number>>();
  for (const seat of state.config.seats) {
    const hand = session.getPrivate(seat)?.hand;
    if (hand) hands.set(seat, { ...hand });
  }
  return hands;
}

function sameHands(
  a: ReadonlyMap<Seat, Readonly<Record<string, number>>>,
  b: ReadonlyMap<Seat, Readonly<Record<string, number>>>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [seat, hand] of a) {
    const other = b.get(seat);
    if (!other) return false;
    const kinds = new Set([...Object.keys(hand), ...Object.keys(other)]);
    for (const kind of kinds) if ((hand[kind] ?? 0) !== (other[kind] ?? 0)) return false;
  }
  return true;
}

/** Holds for a card flight: its cards land in the receiver and leave the giver. */
function cardFlightHolds(flight: CardFlight, expiresAt: number): CountHold[] {
  const holds: CountHold[] = [];
  if (flight.to !== 'bank')
    holds.push({
      id: `${flight.id}:in`,
      seat: flight.to,
      kind: flight.face,
      delta: flight.count,
      expiresAt,
    });
  if (flight.from !== 'bank')
    holds.push({
      id: `${flight.id}:out`,
      seat: flight.from,
      kind: flight.face,
      delta: -flight.count,
      expiresAt,
    });
  return holds;
}

/**
 * Visual effects are observed after accepted updates and never feed back into rules. While a
 * card is in the air the hand and panel counts it touches hold their old value (see card-holds):
 * a receiver's count ticks up when the card lands, a giver's drops as it takes off.
 */
export function useVisualEffects(
  renderer: Pick<BoardRenderer, 'playEffects' | 'skipAnimations' | 'getPixelPosition'> | null,
  reducedMotion: boolean,
  /** The thief picks a face-down card on the steal sheet before its own steals show. */
  pickStealCard = false,
) {
  const [flights, setFlights] = useState<FlightView[]>([]);
  const [cardFlights, setCardFlights] = useState<CardFlightView[]>([]);
  const pendingFrames = useRef<Set<number>>(new Set());
  const pendingTimers = useRef<Set<number>>(new Set());
  // Queued launches read the current renderer: a board that remounts must not drop cards in flight.
  const rendererRef = useRef(renderer);
  useEffect(() => {
    rendererRef.current = renderer;
  }, [renderer]);
  const pickRef = useRef(pickStealCard);
  useEffect(() => {
    pickRef.current = pickStealCard;
  }, [pickStealCard]);
  /** Stop everything in the air; `keepPinned` keeps stolen cards still waiting on the sheet. */
  const cancelPendingFlights = useCallback((keepPinned = false) => {
    for (const frame of pendingFrames.current) window.cancelAnimationFrame(frame);
    pendingFrames.current.clear();
    for (const timer of pendingTimers.current) window.clearTimeout(timer);
    pendingTimers.current.clear();
    useCardHolds.getState().clear(keepPinned);
  }, []);
  const session = sessionForActions();
  const { receipts, add: addProductionGains } = useProductionReceipts(session);
  useEffect(() => {
    setFlights([]);
    setCardFlights([]);
    return () => {
      useStealReveal.getState().reset();
      cancelPendingFlights();
    };
  }, [cancelPendingFlights, session]);
  useEffect(() => {
    if (reducedMotion) {
      cancelPendingFlights();
      setFlights([]);
      setCardFlights([]);
    }
  }, [cancelPendingFlights, reducedMotion]);
  useEffect(() => {
    if (!session) return undefined;
    const schedule = (run: () => void, delay: number) => {
      const timer = window.setTimeout(() => {
        pendingTimers.current.delete(timer);
        run();
      }, delay);
      pendingTimers.current.add(timer);
    };
    const nextFrame = (run: () => void) => {
      const frame = window.requestAnimationFrame(() => {
        pendingFrames.current.delete(frame);
        run();
      });
      pendingFrames.current.add(frame);
    };
    const release = (...ids: string[]) => useCardHolds.getState().release(ids);
    const hold = (holds: readonly CountHold[]) => {
      if (holds.length === 0) return;
      useCardHolds.getState().add(holds);
      const now = Date.now();
      for (const expiresAt of new Set(holds.map((item) => item.expiresAt)))
        schedule(() => useCardHolds.getState().prune(Date.now()), expiresAt - now);
    };
    /** Fly a card; `start` overrides where it takes off (a card turned over on the steal sheet). */
    const launchCard = (flight: CardFlight, retried: boolean, start?: ScreenPoint) => {
      const revealed = useSessionStore.getState().revealedSeat;
      // A private face shows only while its own seat's hand is on screen.
      const face =
        flight.private && revealed !== flight.from && revealed !== flight.to ? null : flight.face;
      if (!retried && face) {
        const clipped =
          clippedSlot(flight.from === 'bank' || start ? null : handSlot(flight.from, face)) ??
          clippedSlot(flight.to === 'bank' ? null : handSlot(flight.to, face));
        if (clipped) {
          clipped.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
          schedule(() => launchCard(flight, true, start), SCROLL_SETTLE_MS);
          return;
        }
      }
      const from = start ?? cardEndPoint(flight.from, face);
      const to = cardEndPoint(flight.to, face);
      if (!from || !to) {
        release(`${flight.id}:in`, `${flight.id}:out`);
        return;
      }
      release(`${flight.id}:out`);
      setCardFlights((current) => [
        ...current.filter((item) => item.id !== flight.id),
        {
          id: flight.id,
          face,
          count: flight.count,
          x: from.x,
          y: from.y,
          dx: to.x - from.x,
          dy: to.y - from.y,
          // Without the sheet a stolen card turns over in the air; off the sheet it already has.
          ...(!start && face && revealed !== null && isStealInto(flight, revealed)
            ? { reveal: true }
            : {}),
        },
      ]);
      schedule(() => release(`${flight.id}:in`), CARD_LANDS_MS);
    };
    /** The steal sheet turned a stolen card over: fly it on from there, or just count it. */
    const launchReveal = (flight: CardFlight, start: ScreenPoint | null) => {
      const id = `${flight.id}:in`;
      release(id);
      if (!start || reducedMotion || flight.to === 'bank') return;
      // From here it is an ordinary flight, cancelled and pruned like any other.
      hold([
        {
          id,
          seat: flight.to,
          kind: flight.face,
          delta: flight.count,
          expiresAt: Date.now() + SCROLL_SETTLE_MS + CARD_FLIGHT_MS + HOLD_SLACK_MS,
        },
      ]);
      launchCard(flight, false, start);
    };
    let before = session.getState();
    let hands = knownHands(session, before);
    let revision = -Infinity;
    // The viewer's Bishop robs with no victim choice: its steals open the sheet by themselves.
    let bishopSteals = false;
    const unsubscribe = session.subscribe((update) => {
      const nextHands = knownHands(session, update.state);
      const jump =
        update.revision < revision ||
        (update.events.length === 0 && (update.state !== before || !sameHands(hands, nextHands)));
      const viewerSeat = useSessionStore.getState().revealedSeat;
      const beforeHand = viewerSeat === null ? undefined : hands.get(viewerSeat);
      const afterHand = viewerSeat === null ? undefined : nextHands.get(viewerSeat);
      const viewer: HandView | null =
        viewerSeat !== null && beforeHand && afterHand
          ? { seat: viewerSeat, before: beforeHand, after: afterHand }
          : null;
      const previous = before;
      before = update.state;
      hands = nextHands;
      revision = update.revision;
      const bishop =
        bishopSteals ||
        update.events.some(
          (event) =>
            event.type === 'progressCardPlayed' &&
            event.card === 'bishop' &&
            viewerSeat !== null &&
            event.seat === viewerSeat,
        );
      bishopSteals = bishop && update.state.turn.phase.at(-1)?.id === 'stealResult';
      if (jump) {
        // Undo, restore or a resync: show the new state as it is, with nothing in the air.
        cancelPendingFlights();
        setFlights([]);
        setCardFlights([]);
        return;
      }
      const cues = deriveVisualEffects(
        previous,
        update.state,
        update.events,
        update.revision,
        viewer,
      );
      // The viewer's own steals wait for the steal sheet to turn them over, when it shows them.
      const sheeted = new Set<string>();
      if (viewer)
        for (const flight of cues.cardFlights) {
          if (!isStealInto(flight, viewer.seat)) continue;
          const reveals = useStealReveal.getState();
          const handSize =
            previous.seats.find((item) => item.seat === flight.from)?.resources.total ?? 1;
          const shown = reveals.offer(
            {
              thief: viewer.seat,
              victim: flight.from,
              handSize,
              face: flight.face,
              launch: (start) => launchReveal(flight, start),
            },
            // A steal the thief chose goes to its open sheet; only a Bishop's opens one itself.
            pickRef.current && bishop,
          );
          if (shown) sheeted.add(flight.id);
          else reveals.announce(flight.id, flight.from, flight.face);
        }
      const launched = cues.cardFlights.filter((flight) => !sheeted.has(flight.id));
      const rolled = update.events.some((event) => event.type === 'diceRolled');
      if (rolled || cues.flights.length + launched.length > 0) {
        // New cards never queue behind the last ones: whatever is still in the air lands at once.
        cancelPendingFlights(true);
        setFlights([]);
        setCardFlights([]);
      }
      if (cues.productionGains.length) addProductionGains(cues.productionGains);
      if (renderer && cues.board.length) renderer.playEffects(cues.board);
      if (reducedMotion) return;
      const now = Date.now();
      const launchAt = (index: number) => productionLaunchAt(index, cues.flights.length, rolled);
      if (renderer)
        hold(
          cues.flights.map((flight, index) => ({
            id: `${flight.id}:in`,
            seat: flight.seat,
            kind: flight.resource,
            delta: flight.count,
            expiresAt: now + launchAt(index) + SCROLL_SETTLE_MS + CARD_FLIGHT_MS + HOLD_SLACK_MS,
          })),
        );
      hold(
        launched.flatMap((flight) =>
          cardFlightHolds(flight, now + SCROLL_SETTLE_MS + CARD_FLIGHT_MS + HOLD_SLACK_MS),
        ),
      );
      // A stolen card on the sheet counts once it lands, however long the thief takes to pick.
      hold(
        cues.cardFlights.flatMap((flight) =>
          sheeted.has(flight.id) && flight.to !== 'bank'
            ? [
                {
                  id: `${flight.id}:in`,
                  seat: flight.to,
                  kind: flight.face,
                  delta: flight.count,
                  expiresAt: now + REVEAL_HOLD_MS,
                  pinned: true,
                },
              ]
            : [],
        ),
      );
      if (renderer) {
        cues.flights.forEach((flight, index) => {
          const launch = () => {
            // Like any card: the hand slot, else the hand, else the panel (or the rail's edge).
            const to = cardEndPoint(flight.seat, flight.resource);
            if (!to) {
              release(`${flight.id}:in`);
              return;
            }
            const board = rendererRef.current;
            if (!board) {
              release(`${flight.id}:in`);
              return;
            }
            const from = board.getPixelPosition({ kind: 'hex', id: flight.fromHex });
            setFlights((current) => [
              ...current,
              {
                id: flight.id,
                resource: flight.resource,
                count: flight.count,
                x: from.x,
                y: from.y,
                dx: to.x - from.x,
                dy: to.y - from.y,
              },
            ]);
            schedule(() => release(`${flight.id}:in`), CARD_LANDS_MS);
          };
          schedule(() => {
            const clipped = clippedSlot(handSlot(flight.seat, flight.resource));
            if (clipped) {
              clipped.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
              schedule(launch, SCROLL_SETTLE_MS);
            } else {
              launch();
            }
          }, launchAt(index));
        });
      }
      if (launched.length)
        nextFrame(() => {
          for (const flight of launched) launchCard(flight, false);
        });
    });
    // Resubscribing (a new renderer) keeps what is already in the air; a new session, reduced
    // motion, Skip and unmounting cancel it.
    return unsubscribe;
  }, [addProductionGains, cancelPendingFlights, renderer, reducedMotion, session]);

  const skip = useCallback(() => {
    renderer?.skipAnimations();
    cancelPendingFlights();
    setFlights([]);
    setCardFlights([]);
  }, [cancelPendingFlights, renderer]);
  const dropCard = (id: string) =>
    setCardFlights((current) => current.filter((item) => item.id !== id));
  const overlay = (
    <>
      <div className="resource-flight-overlay" aria-hidden="true">
        {flights.map((flight) => (
          <span
            className="resource-flight"
            key={flight.id}
            style={flightStyle(flight)}
            onAnimationEnd={() =>
              setFlights((current) => current.filter((item) => item.id !== flight.id))
            }
          >
            <img src={getResourceCardUrl(flight.resource)} alt="" />
            <b>+{flight.count}</b>
          </span>
        ))}
      </div>
      <div className="trade-card-flight-overlay" aria-hidden="true">
        {cardFlights.flatMap((flight) =>
          flight.face === null
            ? []
            : [
                <span
                  className={`trade-card-flight${flight.reveal ? ' steal-reveal-flight' : ''}`}
                  key={flight.id}
                  data-card={flight.face}
                  style={flightStyle(flight)}
                  onAnimationEnd={(event) => {
                    if (event.target === event.currentTarget) dropCard(flight.id);
                  }}
                >
                  {flight.reveal ? (
                    <span className="steal-reveal-flip">
                      <img className="steal-reveal-back" src={getGameArtUrl('cardBack')} alt="" />
                      <img className="steal-reveal-face" src={cardFaceUrl(flight.face)} alt="" />
                    </span>
                  ) : (
                    <img src={cardFaceUrl(flight.face)} alt="" />
                  )}
                  {flight.count > 1 && <b>×{flight.count}</b>}
                </span>,
              ],
        )}
      </div>
      <div className="steal-card-flight-overlay" aria-hidden="true">
        {cardFlights.flatMap((flight) =>
          flight.face !== null
            ? []
            : [
                <span
                  className="steal-card-flight"
                  key={flight.id}
                  style={flightStyle(flight)}
                  onAnimationEnd={() => dropCard(flight.id)}
                >
                  <svg viewBox="0 0 38 53" fill="none" focusable="false">
                    <rect x="1" y="1" width="36" height="51" rx="5" className="steal-card-shell" />
                    <rect x="5" y="5" width="28" height="43" rx="3" className="steal-card-inset" />
                    <path d="m19 14 10 12.5L19 39 9 26.5 19 14Z" className="steal-card-mark" />
                    <path d="M13 26.5h12M19 20v13" className="steal-card-lines" />
                  </svg>
                  {flight.count > 1 && <b>×{flight.count}</b>}
                </span>,
              ],
        )}
      </div>
    </>
  );
  return { skip, overlay, receipts };
}
