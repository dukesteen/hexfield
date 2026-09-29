import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { Seat } from '@cp2p/engine';
import type { VertexId } from '@cp2p/engine/geometry';
import { getBarbarianShipUrl } from '@cp2p/renderer';
import { useSessionStore } from '../../store/session-store';
import type { ModuleHudProps } from '../modules/registry';
import { attackKey, attackNotice } from './attack-notice';
import { knightsState } from './state';

function isVertexId(value: string): value is VertexId {
  return /^v:-?\d+,-?\d+,(N|S)$/.test(value);
}

interface Frame {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The visible part of the board canvas, or null when there is none. */
function boardFrame(): Frame | null {
  const canvas = document.querySelector('.board-view-canvas');
  if (!canvas) return null;
  const box = canvas.getBoundingClientRect();
  const left = Math.max(0, box.left);
  const top = Math.max(0, box.top);
  const width = Math.min(window.innerWidth, box.right) - left;
  const height = Math.min(window.innerHeight, box.bottom) - top;
  return width > 0 && height > 0 ? { left, top, width, height } : null;
}

/** True when a board point is outside the visible board canvas. */
function offBoard(point: { x: number; y: number }, frame: Frame | null): boolean {
  if (!frame) return false;
  return (
    point.x < frame.left ||
    point.x > frame.left + frame.width ||
    point.y < frame.top ||
    point.y > frame.top + frame.height
  );
}

/**
 * The announcement of a barbarian attack, for every player: the two sides, each seat's knights,
 * and who held or which city fell, with a line for the viewer's own part. It appears as the ship
 * lands (at once with reduced motion), never blocks play, and stays until it is dismissed, a new
 * attack replaces it, or a full round has passed. An attack already on record when the game opens
 * is not announced again.
 */
export function BarbarianAttackNotice({ state, presentation, renderer }: ModuleHudProps) {
  const { t } = useTranslation(['knights', 'game']);
  const viewer = useSessionStore((store) => store.revealedSeat);
  const ext = knightsState(state);
  const attack = ext?.lastAttack ?? null;
  const key = attack ? attackKey(attack) : null;
  const [opened] = useState(key);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // The robber is freed by the first attack: remember whether it was locked before this one.
  const robberWasLocked = useRef(ext?.robberLocked ?? false);
  const [freedBy, setFreedBy] = useState<string | null>(null);
  useEffect(() => {
    if (!ext) return;
    if (key && key !== opened && robberWasLocked.current && !ext.robberLocked) setFreedBy(key);
    robberWasLocked.current = ext.robberLocked;
  }, [ext, key, opened]);
  const name = (seat: Seat) =>
    presentation.players.find((player) => player.seat === seat)?.name ?? `#${seat + 1}`;
  const notice =
    attack && key !== opened && key !== dismissed
      ? attackNotice(state, viewer, name, t, freedBy === key)
      : null;
  const round = state.config.seats.length;
  const current = notice && attack && state.turn.number < attack.turn + round ? notice : null;
  const [points, setPoints] = useState<readonly { vertex: string; x: number; y: number }[]>([]);
  const [hidden, setHidden] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const shown = current !== null;
  const lostKey = (current?.lost ?? []).map((piece) => piece.vertex).join(' ');
  useEffect(() => {
    if (!renderer || !shown) {
      setPoints([]);
      setHidden(false);
      setFrame(null);
      return undefined;
    }
    const check = () => {
      const board = boardFrame();
      const found = lostKey
        .split(' ')
        .filter(isVertexId)
        .map((vertex) => ({
          vertex,
          ...renderer.getPixelPosition({ kind: 'vertex', id: vertex }),
        }));
      setFrame(board);
      setHidden(found.some((point) => offBoard(point, board)));
      setPoints(found.filter((point) => !offBoard(point, board)));
    };
    check();
    // The board can also move without a view change (a layout change refits it): look again now
    // and then while the notice is up.
    const timer = window.setInterval(check, 500);
    window.addEventListener('resize', check);
    const unsubscribe = renderer.subscribeViewChange(check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('resize', check);
      unsubscribe();
    };
  }, [renderer, shown, lostKey]);
  if (!current) return null;
  const major = current.lines.filter((line) => line.minor !== true);
  const minor = current.lines.filter((line) => line.minor === true);
  // Over the board, on the half away from the lost cities, so their fall can be seen.
  const low = frame !== null && points.some((point) => point.y < frame.top + frame.height * 0.55);
  const placed = frame
    ? {
        left: frame.left + frame.width / 2,
        ...(low
          ? { bottom: window.innerHeight - (frame.top + frame.height) + 12 }
          : { top: frame.top + 12 }),
        width: Math.min(460, frame.width - 24),
      }
    : undefined;
  const section = (
    <section
      className="barbarian-attack-notice"
      data-placed={frame ? (low ? 'bottom' : 'top') : undefined}
      style={placed}
      data-outcome={current.outcome}
      data-testid="barbarian-attack-notice"
      role="status"
      aria-live="polite"
    >
      <header>
        <img src={getBarbarianShipUrl()} alt="" aria-hidden="true" />
        <h2>{t('knights:attack.title')}</h2>
        <p className="barbarian-attack-tally">
          <span>
            <b>{current.strength}</b>
            <small>{t('knights:attack.strength')}</small>
          </span>
          <span aria-hidden="true">{t('knights:attack.versus')}</span>
          <span>
            <b>{current.defense}</b>
            <small>{t('knights:attack.defense')}</small>
          </span>
        </p>
      </header>
      <p className="barbarian-attack-headline">{current.headline}</p>
      <ul className="barbarian-attack-lines">
        {major.map((line) => (
          <li key={line.text} data-you={line.you === true || undefined}>
            {line.text}
          </li>
        ))}
      </ul>
      <footer>
        <details className="barbarian-attack-details">
          <summary>{t('knights:attack.more')}</summary>
          <ul>
            {minor.map((line) => (
              <li key={line.text}>{line.text}</li>
            ))}
          </ul>
          <table>
            <caption>{t('knights:attack.contributions')}</caption>
            <tbody>
              {current.contributions.map((entry) => (
                <tr key={entry.seat}>
                  <th scope="row">{entry.name}</th>
                  <td>{t('knights:barbarians.activeLevels', { count: entry.level })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        {hidden && renderer && (
          <button
            type="button"
            className="button button-quiet"
            onClick={() => renderer.fitToBoard()}
          >
            {t('knights:attack.show')}
          </button>
        )}
        <button
          type="button"
          className="button button-primary"
          onClick={() => setDismissed(current.key)}
        >
          {t('knights:attack.dismiss')}
        </button>
      </footer>
    </section>
  );
  return (
    <>
      {frame ? createPortal(section, document.body) : section}
      {points.length > 0 &&
        createPortal(
          <div className="barbarian-attack-markers" aria-hidden="true">
            {points.map((point) => (
              <span
                key={point.vertex}
                className="barbarian-attack-marker"
                data-testid="barbarian-attack-marker"
                style={{ left: point.x, top: point.y }}
              >
                <b>{t('knights:attack.marker')}</b>
              </span>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
