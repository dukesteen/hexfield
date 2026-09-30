import { useState } from 'react';
import type { PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { GamePresentation } from '../../queries/repositories/saved-games.js';
import { DICE_PROBABILITY } from './replay-analysis.js';
import type { ReplayStats as Stats } from './replay-analysis.js';

/** Secondary encoding beside colour: every seat has its own dash pattern. */
const DASHES = ['', '7 4', '2 3', '10 3 2 3', '1 5', '12 5'] as const;

interface SeatLine {
  readonly seat: number;
  readonly name: string;
  readonly color: string;
  readonly dash: string;
}

function seatLines(
  stats: Stats,
  presentation: GamePresentation,
  fallback: (seat: number) => string,
) {
  return stats.seats.map((seat, index): SeatLine => {
    const identity = presentation.players.find((player) => player.seat === seat);
    return {
      seat,
      name: identity?.name ?? fallback(seat),
      color: identity?.color ?? 'blue',
      dash: DASHES[index] ?? '',
    };
  });
}

function niceMax(value: number): number {
  if (value <= 5) return 5;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 2.5, 5, 10]) if (factor * step >= value) return factor * step;
  return 10 * step;
}

/** Keep end labels at least `gap` apart without leaving the plot. */
function spreadLabels(values: readonly number[], gap: number, low: number, high: number): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .toSorted((a, b) => a.value - b.value);
  const placed: number[] = [];
  for (const item of order) placed.push(Math.max(item.value, (placed.at(-1) ?? -Infinity) + gap));
  const overflow = (placed.at(-1) ?? 0) - high;
  const shifted = placed.map((value) => Math.max(low, value - Math.max(0, overflow)));
  const result = Array<number>(values.length).fill(0);
  order.forEach((item, rank) => {
    result[item.index] = shifted[rank] ?? item.value;
  });
  return result;
}

const W = 640;
const H = 260;
const M = { top: 12, right: 104, bottom: 30, left: 40 };

function GainsChart({
  stats,
  lines,
  currentTurn,
}: {
  stats: Stats;
  lines: readonly SeatLine[];
  currentTurn: number;
}) {
  const { t } = useTranslation('game');
  const [hover, setHover] = useState<number | null>(null);
  const points = stats.gains;
  const firstTurn = points[0]?.turn ?? 0;
  const lastTurn = Math.max(firstTurn + 1, points.at(-1)?.turn ?? 1);
  const top = niceMax(Math.max(1, ...points.flatMap((point) => point.totals)));
  const x = (turn: number) =>
    M.left + ((turn - firstTurn) / (lastTurn - firstTurn)) * (W - M.left - M.right);
  const y = (value: number) => H - M.bottom - (value / top) * (H - M.top - M.bottom);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((part) => Math.round(top * part));
  const last = points.at(-1);
  const labelY = spreadLabels(
    lines.map((_, index) => y(last?.totals[index] ?? 0)),
    14,
    M.top + 6,
    H - M.bottom,
  );
  const hovered = hover === null ? null : points[hover];
  const move = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const turn =
      firstTurn + ((event.clientX - box.left) / Math.max(1, box.width)) * (lastTurn - firstTurn);
    let best = 0;
    points.forEach((point, index) => {
      if (Math.abs(point.turn - turn) < Math.abs((points[best]?.turn ?? 0) - turn)) best = index;
    });
    setHover(best);
  };
  return (
    <figure className="replay-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t('game:replay.gainsSummary', {
          players: lines
            .map((line, index) => `${line.name} ${last?.totals[index] ?? 0}`)
            .join(', '),
        })}
      >
        {ticks.map((tick) => (
          <g key={tick} className="replay-chart-grid">
            <line x1={M.left} x2={W - M.right} y1={y(tick)} y2={y(tick)} />
            <text x={M.left - 6} y={y(tick) + 4} textAnchor="end">
              {tick}
            </text>
          </g>
        ))}
        <text className="replay-chart-axis" x={M.left} y={H - 8}>
          {t('game:replay.turnShort', { turn: firstTurn })}
        </text>
        <text className="replay-chart-axis" x={W - M.right} y={H - 8} textAnchor="end">
          {t('game:replay.turnShort', { turn: lastTurn })}
        </text>
        <line
          className="replay-chart-now"
          x1={x(currentTurn)}
          x2={x(currentTurn)}
          y1={M.top}
          y2={H - M.bottom}
        />
        {lines.map((line, index) => {
          const path = points
            .map((point) => `${x(point.turn).toFixed(1)},${y(point.totals[index] ?? 0).toFixed(1)}`)
            .join(' ');
          return (
            <g key={line.seat} className={`replay-series color-${line.color}`}>
              <polyline className="replay-series-halo" points={path} />
              <polyline className="replay-series-line" points={path} strokeDasharray={line.dash} />
              <text x={W - M.right + 8} y={(labelY[index] ?? 0) + 4}>
                {line.name}
              </text>
            </g>
          );
        })}
        {hovered && (
          <line
            className="replay-chart-cursor"
            x1={x(hovered.turn)}
            x2={x(hovered.turn)}
            y1={M.top}
            y2={H - M.bottom}
          />
        )}
        <rect
          className="replay-chart-hit"
          x={M.left}
          y={M.top}
          width={W - M.left - M.right}
          height={H - M.top - M.bottom}
          onPointerMove={move}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hovered && (
        <div className="replay-tooltip" role="status">
          <strong>{t('game:replay.turnShort', { turn: hovered.turn })}</strong>
          {lines.map((line, index) => (
            <span key={line.seat}>
              <i className={`replay-swatch color-${line.color}`} aria-hidden="true" />
              {line.name}: {hovered.totals[index] ?? 0}
            </span>
          ))}
        </div>
      )}
      <ul className="replay-chart-legend">
        {lines.map((line) => (
          <li key={line.seat} className={`color-${line.color}`}>
            <svg viewBox="0 0 28 8" aria-hidden="true" className="replay-series">
              <line className="replay-series-halo" x1={1} x2={27} y1={4} y2={4} />
              <line
                className="replay-series-line"
                x1={1}
                x2={27}
                y1={4}
                y2={4}
                strokeDasharray={line.dash}
              />
            </svg>
            {line.name}
          </li>
        ))}
      </ul>
      <details className="replay-table">
        <summary>{t('game:replay.showTable')}</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">{t('game:replay.turn')}</th>
              {lines.map((line) => (
                <th scope="col" key={line.seat}>
                  {line.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.position}>
                <th scope="row">{point.turn}</th>
                {point.totals.map((total, index) => (
                  <td key={index}>{total}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function DiceChart({ dice }: { dice: readonly number[] }) {
  const { t } = useTranslation('game');
  const rolls = dice.reduce((sum, count) => sum + count, 0);
  const expected = DICE_PROBABILITY.map((p) => p * rolls);
  const top = niceMax(Math.max(1, ...dice, ...expected));
  const width = 440;
  const height = 200;
  const bottom = 24;
  const slot = (width - 16) / 11;
  const y = (value: number) => height - bottom - (value / top) * (height - bottom - 16);
  return (
    <figure className="replay-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('game:replay.diceSummary', { count: rolls })}
      >
        <line className="replay-chart-baseline" x1={8} x2={width - 8} y1={y(0)} y2={y(0)} />
        {dice.map((count, index) => {
          const roll = index + 2;
          const left = 8 + index * slot;
          const barHeight = y(0) - y(count);
          return (
            <g key={roll}>
              <title>
                {t('game:replay.diceBar', {
                  roll,
                  count,
                  expected: (expected[index] ?? 0).toFixed(1),
                })}
              </title>
              {count > 0 && (
                <path
                  className={`replay-dice-bar ${roll === 7 ? 'is-seven' : ''}`}
                  d={`M${left + 4},${y(0)} v${-Math.max(0, barHeight - 4)} q0,-4 4,-4 h${slot - 16} q4,0 4,4 v${Math.max(0, barHeight - 4)} z`}
                />
              )}
              <line
                className="replay-dice-expected"
                x1={left + 1}
                x2={left + slot - 1}
                y1={y(expected[index] ?? 0)}
                y2={y(expected[index] ?? 0)}
              />
              <text
                className="replay-chart-value"
                x={left + slot / 2}
                y={y(count) - 6}
                textAnchor="middle"
              >
                {count}
              </text>
              <text
                className="replay-chart-axis"
                x={left + slot / 2}
                y={height - 6}
                textAnchor="middle"
              >
                {roll}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="replay-chart-key muted">
        <span className="replay-key-bar" aria-hidden="true" /> {t('game:replay.diceActual')}
        <span className="replay-key-expected" aria-hidden="true" /> {t('game:replay.diceExpected')}
      </p>
      <details className="replay-table">
        <summary>{t('game:replay.showTable')}</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">{t('game:replay.diceRoll')}</th>
              <th scope="col">{t('game:replay.diceActual')}</th>
              <th scope="col">{t('game:replay.diceExpected')}</th>
            </tr>
          </thead>
          <tbody>
            {dice.map((count, index) => (
              <tr key={index}>
                <th scope="row">{index + 2}</th>
                <td>{count}</td>
                <td>{(expected[index] ?? 0).toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function RobberChart({ stats, lines }: { stats: Stats; lines: readonly SeatLine[] }) {
  const { t } = useTranslation('game');
  const top = Math.max(1, ...stats.robberBlocked);
  return (
    <ul className="replay-bars">
      {lines.map((line, index) => {
        const value = stats.robberBlocked[index] ?? 0;
        return (
          <li key={line.seat} className={`color-${line.color}`}>
            <span className="replay-bars-name">{line.name}</span>
            <span className="replay-bars-track" aria-hidden="true">
              <span style={{ width: `${(value / top) * 100}%` }} />
            </span>
            <strong
              aria-label={t('game:replay.robberBlockedFor', { name: line.name, count: value })}
            >
              {value}
            </strong>
          </li>
        );
      })}
    </ul>
  );
}

function TradeTable({ stats, lines }: { stats: Stats; lines: readonly SeatLine[] }) {
  const { t } = useTranslation('game');
  return (
    <div className="replay-table-scroll">
      <table className="replay-trades">
        <thead>
          <tr>
            <th scope="col">{t('game:replay.player')}</th>
            <th scope="col">{t('game:replay.playerTrades')}</th>
            <th scope="col">{t('game:replay.maritimeTrades')}</th>
            <th scope="col">{t('game:replay.cardsGiven')}</th>
            <th scope="col">{t('game:replay.cardsReceived')}</th>
            <th scope="col">{t('game:replay.steals')}</th>
            <th scope="col">{t('game:replay.stolenFrom')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => {
            const trade = stats.trades[index];
            return (
              <tr key={line.seat}>
                <th scope="row">
                  <i className={`replay-swatch color-${line.color}`} aria-hidden="true" />
                  {line.name}
                </th>
                <td>{trade?.playerTrades ?? 0}</td>
                <td>{trade?.maritimeTrades ?? 0}</td>
                <td>{trade?.given ?? 0}</td>
                <td>{trade?.received ?? 0}</td>
                <td>{trade?.steals ?? 0}</td>
                <td>{trade?.stolenFrom ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Whole-game statistics from public facts only, identical in every perspective. */
export function ReplayStats({
  stats,
  presentation,
  currentTurn,
}: {
  stats: Stats;
  presentation: GamePresentation;
  currentTurn: number;
}) {
  const { t } = useTranslation('game');
  const lines = seatLines(stats, presentation, (seat) =>
    t('game:playerFallback', { number: seat + 1 }),
  );
  return (
    <section className="replay-stats" aria-label={t('game:replay.stats')}>
      <div className="replay-stats-grid">
        <section className="replay-stat is-wide">
          <h3>{t('game:replay.gainsTitle')}</h3>
          <p className="muted">{t('game:replay.gainsNote')}</p>
          <GainsChart stats={stats} lines={lines} currentTurn={currentTurn} />
        </section>
        <section className="replay-stat">
          <h3>{t('game:replay.diceTitle')}</h3>
          <DiceChart dice={stats.dice} />
        </section>
        <section className="replay-stat">
          <h3>{t('game:replay.robberTitle')}</h3>
          <p className="muted">{t('game:replay.robberNote')}</p>
          <RobberChart stats={stats} lines={lines} />
        </section>
        <section className="replay-stat is-wide">
          <h3>{t('game:replay.tradesTitle')}</h3>
          <TradeTable stats={stats} lines={lines} />
        </section>
      </div>
    </section>
  );
}
