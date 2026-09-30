import { Link } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Seat } from '@cp2p/engine';
import { BoardView } from '../board/BoardView.js';
import { toRenderModel } from '../board/toRenderModel.js';
import { DiceRollReadout, latestDiceRoll } from '../game/DiceRollReadout.js';
import { formatGameEvent } from '../game/event-format.js';
import { useBoardAppearance } from '../game/use-appearance.js';
import { nextSeven, nextTurnStart, previousTurnStart } from './replay-navigation.js';
import type { LoadedReplay } from './replay-load.js';
import type { ReplayPerspective } from './replay-session.js';
import { ReplayControls } from './ReplayControls.js';
import { ReplayExport } from './ReplayExport.js';
import { ReplayPlayers } from './ReplayPlayers.js';
import { ReplayStats } from './ReplayStats.js';
import { REPLAY_SPEEDS, usePlayback, useReplayRevision } from './use-replay.js';
import './replay-viewer.css';

const RECENT_EVENTS = 12;

function perspectiveValue(perspective: ReplayPerspective): string {
  return perspective.kind === 'seat' ? `seat-${perspective.seat}` : perspective.kind;
}

function isSeat(value: number): value is Seat {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

function parsePerspective(value: string): ReplayPerspective {
  if (value === 'omniscient') return { kind: 'omniscient' };
  const seat = Number(value.replace('seat-', ''));
  return value.startsWith('seat-') && isSeat(seat) ? { kind: 'seat', seat } : { kind: 'public' };
}

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(target.tagName))
  );
}

/** Steps through a verified game with the game's own board and player panels. */
export function ReplayViewer({
  loaded,
  title,
  back,
  notice,
}: {
  loaded: LoadedReplay;
  title: string;
  /** Where "back" goes; the home screen when absent. */
  back?: ReactNode;
  notice?: ReactNode;
}) {
  const { t } = useTranslation(['game', 'lobby', 'log']);
  const { session, presentation } = loaded;
  const revision = useReplayRevision(session);
  const playback = usePlayback(session);
  const [statsOpen, setStatsOpen] = useState(false);
  const perspectiveId = useId();
  const { appearance, reducedMotion } = useBoardAppearance(presentation);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- The revision changes with every seek.
  const state = useMemo(() => session.getState(), [session, revision]);
  const model = useMemo(() => toRenderModel(state, 'spectator'), [state]);
  const events = session.getEvents();
  const name = (seat: number) =>
    presentation.players.find((player) => player.seat === seat)?.name ??
    t('game:playerFallback', { number: seat + 1 });
  const latest = session
    .eventsAt(session.position)
    .map((event) => formatGameEvent(event, t, name))
    .filter(Boolean);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing(event.target)) return;
      const { timeline } = session;
      const speedIndex = REPLAY_SPEEDS.indexOf(playback.speed);
      let handled = true;
      if (event.key === ' ' || event.key === 'k') playback.toggle();
      else if (event.key === 'ArrowLeft')
        session.seek(
          event.shiftKey ? previousTurnStart(timeline, session.position) : session.position - 1,
        );
      else if (event.key === 'ArrowRight')
        session.seek(
          event.shiftKey
            ? (nextTurnStart(timeline, session.position) ?? session.length)
            : session.position + 1,
        );
      else if (event.key === '7') {
        const seven = nextSeven(timeline, session.position);
        if (seven !== null) session.seek(seven);
      } else if (event.key === 'Home') session.seek(0);
      else if (event.key === 'End') session.seek(session.length);
      else if (event.key === '[')
        playback.setSpeed(REPLAY_SPEEDS[Math.max(0, speedIndex - 1)] ?? playback.speed);
      else if (event.key === ']')
        playback.setSpeed(
          REPLAY_SPEEDS[Math.min(REPLAY_SPEEDS.length - 1, speedIndex + 1)] ?? playback.speed,
        );
      else handled = false;
      if (handled) event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playback, session]);

  const perspective = session.perspective;
  const currentTurn = session.timeline.turnAt[session.position] ?? 0;
  return (
    <main className="app-page replay-page">
      <header className="replay-header">
        {back ?? (
          <Link to="/" className="text-link">
            {t('lobby:backHome')}
          </Link>
        )}
        <h1>{title}</h1>
        <label className="replay-perspective" htmlFor={perspectiveId}>
          <span>{t('game:replay.perspective')}</span>
          <select
            id={perspectiveId}
            value={perspectiveValue(perspective)}
            onChange={(event) => {
              session.setPerspective(parsePerspective(event.currentTarget.value));
            }}
          >
            <option value="public">{t('game:replay.perspectivePublic')}</option>
            <option value="omniscient" disabled={!session.fullInformation}>
              {t('game:replay.perspectiveAll')}
            </option>
            {presentation.players.map((player) => (
              <option
                key={player.seat}
                value={`seat-${player.seat}`}
                disabled={!session.fullInformation}
              >
                {t('game:replay.perspectiveSeat', { name: player.name })}
              </option>
            ))}
          </select>
        </label>
      </header>
      {!session.fullInformation && (
        <p className="replay-note muted">{t('game:replay.publicOnly')}</p>
      )}
      {notice}
      <div className="replay-layout">
        <div className="replay-main">
          <section className="replay-board" aria-label={t('game:replay.board')}>
            <BoardView
              model={model}
              appearance={appearance}
              reducedMotion={reducedMotion}
              moduleIds={state.config.modules.map((module) => module.id)}
            />
            <div className="replay-board-overlay">
              <DiceRollReadout dice={latestDiceRoll(events)} />
            </div>
          </section>
          <p className="replay-latest" aria-live="polite">
            {latest.length ? latest.join(' · ') : t('game:replay.noMove')}
          </p>
          <ReplayControls session={session} playback={playback} presentation={presentation} />
        </div>
        <aside className="replay-side">
          <ReplayPlayers
            state={state}
            presentation={presentation}
            hand={(seat) => session.getPrivate(seat)}
          />
          <details className="event-log replay-log">
            <summary>{t('game:eventLog')}</summary>
            <ol>
              {events
                .slice(-RECENT_EVENTS)
                .toReversed()
                .map((event, index) => {
                  const text = formatGameEvent(event, t, name);
                  return text ? <li key={events.length - index}>{text}</li> : null;
                })}
            </ol>
          </details>
          <ReplayExport exported={() => session.exportSave()} />
        </aside>
      </div>
      <details
        className="replay-stats-toggle"
        open={statsOpen}
        onToggle={(event) => setStatsOpen(event.currentTarget.open)}
      >
        <summary>{t('game:replay.showStats')}</summary>
        {statsOpen && (
          <ReplayStats
            stats={session.stats}
            presentation={presentation}
            currentTurn={currentTurn}
          />
        )}
      </details>
    </main>
  );
}
