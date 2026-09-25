import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { RESOURCES, type Resource, type Seat } from '@cp2p/engine';
import type { BoardRenderer } from '@cp2p/renderer';
import { getResourceCardUrl, getResourceIconUrl } from '@cp2p/renderer';
import { sessionForActions, useSessionStore } from '../../store/session-store';
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

interface TradeFlightView {
  id: string;
  resource: Resource;
  count: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

interface StealFlightView {
  id: string;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

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

function visibleCenter(element: HTMLElement): { x: number; y: number } | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  if (point.x < 0 || point.y < 0 || point.x > window.innerWidth || point.y > window.innerHeight)
    return null;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const parentRect = parent.getBoundingClientRect();
    const clipsX = ['auto', 'clip', 'hidden', 'scroll'].includes(style.overflowX);
    const clipsY = ['auto', 'clip', 'hidden', 'scroll'].includes(style.overflowY);
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

/** Visual effects are observed after accepted updates and never feed back into rules. */
export function useVisualEffects(renderer: BoardRenderer | null, reducedMotion: boolean) {
  const [flights, setFlights] = useState<FlightView[]>([]);
  const [tradeFlights, setTradeFlights] = useState<TradeFlightView[]>([]);
  const [stealFlights, setStealFlights] = useState<StealFlightView[]>([]);
  const pendingStealFrames = useRef<Set<number>>(new Set());
  const cancelPendingSteals = useCallback(() => {
    for (const frame of pendingStealFrames.current) window.cancelAnimationFrame(frame);
    pendingStealFrames.current.clear();
  }, []);
  const session = sessionForActions();
  const { receipts, add: addProductionGains } = useProductionReceipts(session);
  useEffect(() => {
    setFlights([]);
    setTradeFlights([]);
    setStealFlights([]);
    return cancelPendingSteals;
  }, [cancelPendingSteals, session]);
  useEffect(() => {
    if (reducedMotion) {
      cancelPendingSteals();
      setFlights([]);
      setTradeFlights([]);
      setStealFlights([]);
    }
  }, [cancelPendingSteals, reducedMotion]);
  useEffect(() => {
    if (!session) return undefined;
    let before = session.getState();
    return session.subscribe((update) => {
      const cues = deriveVisualEffects(before, update.state, update.events, update.revision);
      before = update.state;
      if (cues.productionGains.length) addProductionGains(cues.productionGains);
      if (renderer && cues.board.length) renderer.playEffects(cues.board);
      if (reducedMotion) return;
      const next = renderer
        ? cues.flights.flatMap((flight) => {
            const panel = document.querySelector<HTMLElement>(`[data-seat-panel="${flight.seat}"]`);
            if (!panel) return [];
            const rect = panel.getBoundingClientRect();
            const from = renderer.getPixelPosition({ kind: 'hex', id: flight.fromHex });
            const to = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            return [
              {
                id: flight.id,
                resource: flight.resource,
                count: flight.count,
                x: from.x,
                y: from.y,
                dx: to.x - from.x,
                dy: to.y - from.y,
              },
            ];
          })
        : [];
      if (next.length) setFlights((current) => [...current, ...next]);
      const nextTrade = cues.tradeFlights.flatMap((flight) => {
        const fromPanel = document.querySelector<HTMLElement>(`[data-seat-panel="${flight.from}"]`);
        const toPanel = document.querySelector<HTMLElement>(`[data-seat-panel="${flight.to}"]`);
        if (!fromPanel || !toPanel) return [];
        const from = visibleCenter(fromPanel);
        const to = visibleCenter(toPanel);
        if (!from || !to) return [];
        return [
          {
            id: flight.id,
            resource: flight.resource,
            count: flight.count,
            x: from.x,
            y: from.y,
            dx: to.x - from.x,
            dy: to.y - from.y,
          },
        ];
      });
      if (nextTrade.length) {
        setTradeFlights((current) => [...current, ...nextTrade].slice(-16));
      }
      if (cues.stealFlights.length) {
        const frame = window.requestAnimationFrame(() => {
          pendingStealFrames.current.delete(frame);
          const revealedSeat = useSessionStore.getState().revealedSeat;
          const hand =
            revealedSeat === null
              ? null
              : document.querySelector<HTMLElement>('.hand-dock .resource-hand');
          const centerForSeat = (seat: Seat) => {
            if (seat === revealedSeat && hand) {
              const center = visibleCenter(hand);
              if (center) return center;
            }
            const panel = document.querySelector<HTMLElement>(`[data-seat-panel="${seat}"]`);
            return panel ? visibleCenter(panel) : null;
          };
          const nextSteal = cues.stealFlights.flatMap((flight) => {
            const from = centerForSeat(flight.from);
            const to = centerForSeat(flight.to);
            if (!from || !to) return [];
            return [
              {
                id: flight.id,
                x: from.x,
                y: from.y,
                dx: to.x - from.x,
                dy: to.y - from.y,
              },
            ];
          });
          if (nextSteal.length) setStealFlights((current) => [...current, ...nextSteal].slice(-16));
        });
        pendingStealFrames.current.add(frame);
      }
    });
  }, [addProductionGains, renderer, reducedMotion, session]);

  const skip = useCallback(() => {
    renderer?.skipAnimations();
    cancelPendingSteals();
    setFlights([]);
    setTradeFlights([]);
    setStealFlights([]);
  }, [cancelPendingSteals, renderer]);
  const overlay = (
    <>
      <div className="resource-flight-overlay" aria-hidden="true">
        {flights.map((flight) => {
          const style: CSSProperties & { '--flight-dx': string; '--flight-dy': string } = {
            left: flight.x,
            top: flight.y,
            '--flight-dx': `${flight.dx}px`,
            '--flight-dy': `${flight.dy}px`,
          };
          return (
            <span
              className="resource-flight"
              key={flight.id}
              style={style}
              onAnimationEnd={() =>
                setFlights((current) => current.filter((item) => item.id !== flight.id))
              }
            >
              <img src={getResourceIconUrl(flight.resource)} alt="" />
              <b>+{flight.count}</b>
            </span>
          );
        })}
      </div>
      <div className="trade-card-flight-overlay" aria-hidden="true">
        {tradeFlights.map((flight) => {
          const style: CSSProperties & { '--flight-dx': string; '--flight-dy': string } = {
            left: flight.x,
            top: flight.y,
            '--flight-dx': `${flight.dx}px`,
            '--flight-dy': `${flight.dy}px`,
          };
          return (
            <span
              className="trade-card-flight"
              key={flight.id}
              style={style}
              onAnimationEnd={() =>
                setTradeFlights((current) => current.filter((item) => item.id !== flight.id))
              }
            >
              <img src={getResourceCardUrl(flight.resource)} alt="" />
              {flight.count > 1 && <b>×{flight.count}</b>}
            </span>
          );
        })}
      </div>
      <div className="steal-card-flight-overlay" aria-hidden="true">
        {stealFlights.map((flight) => {
          const style: CSSProperties & { '--flight-dx': string; '--flight-dy': string } = {
            left: flight.x,
            top: flight.y,
            '--flight-dx': `${flight.dx}px`,
            '--flight-dy': `${flight.dy}px`,
          };
          return (
            <span
              className="steal-card-flight"
              key={flight.id}
              style={style}
              onAnimationEnd={() =>
                setStealFlights((current) => current.filter((item) => item.id !== flight.id))
              }
            >
              <svg viewBox="0 0 38 53" fill="none" focusable="false">
                <rect x="1" y="1" width="36" height="51" rx="5" className="steal-card-shell" />
                <rect x="5" y="5" width="28" height="43" rx="3" className="steal-card-inset" />
                <path d="m19 14 10 12.5L19 39 9 26.5 19 14Z" className="steal-card-mark" />
                <path d="M13 26.5h12M19 20v13" className="steal-card-lines" />
              </svg>
            </span>
          );
        })}
      </div>
    </>
  );
  return { skip, overlay, receipts };
}
