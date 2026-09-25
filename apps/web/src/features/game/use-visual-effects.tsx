import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { Resource } from '@cp2p/engine';
import type { BoardRenderer } from '@cp2p/renderer';
import { getResourceIconUrl } from '@cp2p/renderer';
import { sessionForActions } from '../../store/session-store';
import { deriveVisualEffects } from './visual-effects';

interface FlightView {
  id: string;
  resource: Resource;
  count: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** Visual effects are observed after accepted updates and never feed back into rules. */
export function useVisualEffects(renderer: BoardRenderer | null, reducedMotion: boolean) {
  const [flights, setFlights] = useState<FlightView[]>([]);
  useEffect(() => {
    if (reducedMotion) setFlights([]);
  }, [reducedMotion]);
  useEffect(() => {
    const session = sessionForActions();
    if (!session || !renderer) return () => undefined;
    let before = session.getState();
    return session.subscribe((update) => {
      const cues = deriveVisualEffects(before, update.state, update.events, update.revision);
      before = update.state;
      if (cues.board.length) renderer.playEffects(cues.board);
      if (reducedMotion || cues.flights.length === 0) return;
      const next = cues.flights.flatMap((flight) => {
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
      });
      if (next.length) setFlights((current) => [...current, ...next]);
    });
  }, [renderer, reducedMotion]);

  const skip = useCallback(() => {
    renderer?.skipAnimations();
    setFlights([]);
  }, [renderer]);
  const overlay = (
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
  );
  return { skip, overlay };
}
