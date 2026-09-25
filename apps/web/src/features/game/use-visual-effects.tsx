import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { RESOURCES, type Resource, type Seat } from '@cp2p/engine';
import type { BoardRenderer } from '@cp2p/renderer';
import { getResourceCardUrl, getResourceIconUrl } from '@cp2p/renderer';
import { sessionForActions } from '../../store/session-store';
import { deriveVisualEffects, type ProductionGain } from './visual-effects';
import './trade-card-flight.css';

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
  const session = sessionForActions();
  const { receipts, add: addProductionGains } = useProductionReceipts(session);
  useEffect(() => {
    if (reducedMotion) {
      setFlights([]);
      setTradeFlights([]);
    }
  }, [reducedMotion]);
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
    });
  }, [addProductionGains, renderer, reducedMotion, session]);

  const skip = useCallback(() => {
    renderer?.skipAnimations();
    setFlights([]);
    setTradeFlights([]);
  }, [renderer]);
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
    </>
  );
  return { skip, overlay, receipts };
}
