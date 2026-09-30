import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { GamePresentation } from '../../queries/repositories/saved-games.js';
import type { ReplayMarker } from './replay-analysis.js';
import {
  lastTurn,
  nextSeven,
  nextTurnStart,
  previousTurnStart,
  turnPosition,
} from './replay-navigation.js';
import type { ReplaySession } from './replay-session.js';
import { REPLAY_SPEEDS } from './use-replay.js';
import type { ReplaySpeed, usePlayback } from './use-replay.js';

type Playback = ReturnType<typeof usePlayback>;

const WIDTH = 1000;
const HEIGHT = 30;

function MarkerShape({ marker, x }: { marker: ReplayMarker; x: number }) {
  if (marker.kind === 'build') return <rect x={x - 3.5} y={17} width={7} height={7} rx={1.5} />;
  if (marker.kind === 'award') return <path d={`M${x} 3 L${x + 5} 9 L${x} 15 L${x - 5} 9 Z`} />;
  if (marker.kind === 'robber') return <circle cx={x} cy={20.5} r={3.5} />;
  return <path d={`M${x - 5} 15 L${x + 5} 15 L${x} 5 Z`} />;
}

/** Markers above the scrubber; the range input carries the accessible position. */
function Timeline({
  session,
  presentation,
}: {
  session: ReplaySession;
  presentation: GamePresentation;
}) {
  const { t } = useTranslation('game');
  const length = Math.max(1, session.length);
  const colour = (marker: ReplayMarker) =>
    marker.seat === null
      ? ''
      : `color-${presentation.players.find((player) => player.seat === marker.seat)?.color ?? 'blue'}`;
  const labels: Record<ReplayMarker['kind'], string> = {
    build: t('game:replay.markerBuild'),
    award: t('game:replay.markerAward'),
    robber: t('game:replay.markerRobber'),
    swing: t('game:replay.markerSwing'),
  };
  return (
    <svg
      className="replay-markers"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line className="replay-markers-track" x1={0} x2={WIDTH} y1={27} y2={27} />
      <line
        className="replay-markers-now"
        x1={(session.position / length) * WIDTH}
        x2={(session.position / length) * WIDTH}
        y1={0}
        y2={HEIGHT}
      />
      {session.timeline.markers.map((marker, index) => (
        <g
          key={index}
          className={`replay-marker is-${marker.kind} ${colour(marker)}`}
          onClick={() => session.seek(marker.position)}
        >
          <title>{labels[marker.kind]}</title>
          <MarkerShape marker={marker} x={(marker.position / length) * WIDTH} />
        </g>
      ))}
    </svg>
  );
}

export function ReplayControls({
  session,
  playback,
  presentation,
}: {
  session: ReplaySession;
  playback: Playback;
  presentation: GamePresentation;
}) {
  const { t } = useTranslation('game');
  const scrubberId = useId();
  const [turn, setTurn] = useState('');
  const { timeline } = session;
  const currentTurn = timeline.turnAt[session.position] ?? 0;
  const seven = nextSeven(timeline, session.position);
  const jump = (event: FormEvent) => {
    event.preventDefault();
    const target = turnPosition(timeline, Number(turn));
    if (target !== null) session.seek(target);
  };
  return (
    <section className="replay-controls" aria-label={t('game:replay.controls')}>
      <div className="replay-scrubber">
        <Timeline session={session} presentation={presentation} />
        <label className="replay-sr-only" htmlFor={scrubberId}>
          {t('game:replay.scrubber')}
        </label>
        <input
          id={scrubberId}
          type="range"
          min={0}
          max={session.length}
          step={1}
          value={session.position}
          aria-valuetext={t('game:replay.positionText', {
            position: session.position,
            total: session.length,
            turn: currentTurn,
          })}
          onChange={(event) => session.seek(Number(event.currentTarget.value))}
        />
        <p className="replay-position" aria-live="off">
          {t('game:replay.turnOf', { turn: currentTurn, total: lastTurn(timeline) })}
          <span className="muted">
            {' · '}
            {t('game:replay.moveOf', { position: session.position, total: session.length })}
          </span>
        </p>
      </div>
      <div className="replay-buttons">
        <button
          type="button"
          className="button button-quiet"
          onClick={() => session.seek(previousTurnStart(timeline, session.position))}
          aria-label={t('game:replay.previousTurn')}
          title={t('game:replay.previousTurn')}
        >
          ⏮
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={session.position === 0}
          onClick={() => session.step(-1)}
          aria-label={t('game:replay.stepBack')}
          title={t('game:replay.stepBack')}
        >
          ◀
        </button>
        <button
          type="button"
          className="button button-primary replay-play"
          onClick={playback.toggle}
          aria-pressed={playback.playing}
        >
          {playback.playing ? t('game:replay.pause') : t('game:replay.play')}
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={session.position === session.length}
          onClick={() => session.step(1)}
          aria-label={t('game:replay.stepForward')}
          title={t('game:replay.stepForward')}
        >
          ▶
        </button>
        <button
          type="button"
          className="button button-quiet"
          onClick={() => session.seek(nextTurnStart(timeline, session.position) ?? session.length)}
          aria-label={t('game:replay.nextTurn')}
          title={t('game:replay.nextTurn')}
        >
          ⏭
        </button>
        <label className="replay-speed">
          <span>{t('game:replay.speed')}</span>
          <select
            value={playback.speed}
            onChange={(event) => {
              const speed = REPLAY_SPEEDS.find(
                (item) => String(item) === event.currentTarget.value,
              );
              if (speed !== undefined) playback.setSpeed(speed satisfies ReplaySpeed);
            }}
          >
            {REPLAY_SPEEDS.map((speed) => (
              <option key={speed} value={speed}>
                {t('game:replay.speedValue', { speed })}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button button-quiet"
          disabled={seven === null}
          onClick={() => seven !== null && session.seek(seven)}
        >
          {t('game:replay.nextSeven')}
        </button>
        <form className="replay-turn-jump" onSubmit={jump}>
          <label>
            <span>{t('game:replay.turn')}</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={lastTurn(timeline)}
              value={turn}
              placeholder={String(currentTurn)}
              onChange={(event) => setTurn(event.currentTarget.value)}
            />
          </label>
          <button type="submit" className="button button-quiet" disabled={turn === ''}>
            {t('game:replay.goToTurn')}
          </button>
        </form>
      </div>
      <ul className="replay-legend" aria-label={t('game:replay.legend')}>
        <li>
          <svg viewBox="0 0 12 12" aria-hidden="true" className="replay-marker is-build">
            <rect x={2.5} y={2.5} width={7} height={7} rx={1.5} />
          </svg>
          {t('game:replay.markerBuild')}
        </li>
        <li>
          <svg viewBox="0 0 12 12" aria-hidden="true" className="replay-marker is-award">
            <path d="M6 0 L11 6 L6 12 L1 6 Z" />
          </svg>
          {t('game:replay.markerAward')}
        </li>
        <li>
          <svg viewBox="0 0 12 12" aria-hidden="true" className="replay-marker is-robber">
            <circle cx={6} cy={6} r={3.5} />
          </svg>
          {t('game:replay.markerRobber')}
        </li>
        <li>
          <svg viewBox="0 0 12 12" aria-hidden="true" className="replay-marker is-swing">
            <path d="M1 11 L11 11 L6 1 Z" />
          </svg>
          {t('game:replay.markerSwing')}
        </li>
      </ul>
      <p className="replay-shortcuts muted">{t('game:replay.shortcuts')}</p>
    </section>
  );
}
