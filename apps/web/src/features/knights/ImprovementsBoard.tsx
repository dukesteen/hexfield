import { useTranslation } from 'react-i18next';
import type { GameState, Seat } from '@cp2p/engine';
import {
  getCommodityIconUrl,
  getImprovementBannerUrl,
  getImprovementStampUrl,
  getMetropolisIconUrl,
  getTrackIconUrl,
} from '@cp2p/renderer';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { improvementCostOf } from './improvement-cost';
import { ABILITY_LEVEL, MAX_LEVEL, TRACKS, TRACK_COMMODITY, knightsState, levelOn } from './state';
import type { Track } from './state';
import './knights.css';

/** The level from which a track's metropolis can be claimed. */
const METROPOLIS_LEVEL = 4;

/**
 * Where a level cell sits on the printed banner (322 by 82 units). The printed cell is 40 by 54 at
 * x = 84 + 46 per level, y = 13; the box adds the 2 unit margin the stamps are drawn with.
 */
const CELL = { x0: 82, step: 46, top: 11, width: 44, height: 58, banner: 322, bannerHeight: 82 };

function pct(value: number, of: number): string {
  return `${(value / of) * 100}%`;
}

function cellBox(level: number) {
  return {
    left: pct(CELL.x0 + (level - 1) * CELL.step, CELL.banner),
    top: pct(CELL.top, CELL.bannerHeight),
    width: pct(CELL.width, CELL.banner),
    height: pct(CELL.height, CELL.bannerHeight),
  };
}

/** What a level cell shows: a stamp once reached, the buy button for the next, muted beyond. */
export type CellState = 'reached' | 'next' | 'locked';

/** The state of each level cell of a track, on a board that offers the next level or not. */
export function cellStates(level: number, offersNext: boolean): CellState[] {
  return Array.from({ length: MAX_LEVEL }, (_, index) => {
    const cell = index + 1;
    if (cell <= level) return 'reached';
    if (cell === level + 1 && offersNext) return 'next';
    return 'locked';
  });
}

interface BoardProps {
  state: Readonly<GameState>;
  seat: Seat;
  presentation: GamePresentation;
  /** The tracks the viewing seat can buy a level on right now. Omit for a read-only board. */
  buyable?: readonly Track[];
  onBuy?: (track: Track) => void;
  /** Buying is blocked while a move is being sent. */
  disabled?: boolean;
  /**
   * What to write under each track: everything (the ability and the next cost), just the next
   * cost, or nothing. The abilities are also on the level 3 cell's tooltip.
   */
  captions?: 'full' | 'cost' | 'none';
}

/**
 * A seat's city improvements: the three tracks as the printed banners, each level reached covered
 * by its stamp, and, on the viewer's own board, the next level as a button with its cost.
 */
export function ImprovementsBoard({
  state,
  seat,
  presentation,
  buyable,
  onBuy,
  disabled = false,
  captions = 'full',
}: BoardProps) {
  const { t } = useTranslation('knights');
  const ext = knightsState(state);
  if (!ext) return null;
  const color = presentation.players.find((player) => player.seat === seat)?.color ?? 'blue';
  return (
    <div
      className={`improvements-board color-${color}`}
      data-seat={seat}
      data-readonly={buyable === undefined}
    >
      {TRACKS.map((track) => {
        const level = levelOn(ext, seat, track);
        const holds = ext.metropolises[track]?.seat === seat;
        const next = level < MAX_LEVEL ? level + 1 : null;
        const canBuy = next !== null && buyable?.includes(track) === true;
        const cost = next !== null ? improvementCostOf(state, seat, track) : null;
        const kind = commodityOf(track);
        const commodity = t(`knights:commodity.${TRACK_COMMODITY[track]}`);
        const trackName = t(`knights:track.${track}`);
        const summary =
          level >= MAX_LEVEL
            ? t('knights:improve.complete', { track: trackName })
            : t('knights:improve.level', { track: trackName, level, max: MAX_LEVEL });
        return (
          <section
            className="improve-track"
            key={track}
            data-track={track}
            data-level={level}
            aria-label={`${summary}${holds ? `. ${t('knights:improve.holdsMetropolis')}` : ''}`}
          >
            <div className="improve-banner">
              <img
                className="improve-banner-art"
                src={getImprovementBannerUrl(track)}
                alt=""
                aria-hidden="true"
                draggable={false}
              />
              {cellStates(level, buyable !== undefined).map((cellState, index) => {
                const cell = index + 1;
                const marks = {
                  'data-level': cell,
                  'data-ability': cell === ABILITY_LEVEL,
                  'data-metropolis': cell >= METROPOLIS_LEVEL,
                  style: cellBox(cell),
                };
                if (cellState === 'reached')
                  return (
                    <span
                      key={cell}
                      {...marks}
                      className="improve-cell is-reached"
                      aria-hidden="true"
                      {...(cell === ABILITY_LEVEL ? { title: t(`knights:ability.${track}`) } : {})}
                    >
                      <img src={getImprovementStampUrl(track, cell)} alt="" draggable={false} />
                    </span>
                  );
                if (cellState === 'next')
                  return (
                    <button
                      key={cell}
                      {...marks}
                      type="button"
                      className="improve-cell is-next"
                      data-testid={`improve-${track}`}
                      data-affordable={canBuy}
                      disabled={disabled || !canBuy}
                      title={
                        cost !== null
                          ? t('knights:improve.buyCost', {
                              track: trackName,
                              level: cell,
                              cost: `${cost} ${commodity}`,
                            })
                          : undefined
                      }
                      aria-label={
                        canBuy
                          ? t('knights:improve.buy', {
                              track: trackName,
                              level: cell,
                              cost: `${cost ?? cell} ${commodity}`,
                            })
                          : t('knights:improve.cannotBuy', { track: trackName, level: cell })
                      }
                      onClick={() => {
                        if (canBuy) onBuy?.(track);
                      }}
                    >
                      {canBuy && (
                        <span className="improve-plus" aria-hidden="true">
                          +
                        </span>
                      )}
                      {cost !== null && (
                        <span className="improve-cost" aria-hidden="true">
                          {cost}
                          <img src={getCommodityIconUrl(kind)} alt="" />
                        </span>
                      )}
                    </button>
                  );
                return (
                  <span
                    key={cell}
                    {...marks}
                    className="improve-cell is-locked"
                    aria-hidden="true"
                  />
                );
              })}
              {holds && (
                <img
                  className="improve-metropolis"
                  src={getMetropolisIconUrl(track, color)}
                  alt=""
                  aria-hidden="true"
                />
              )}
            </div>
            {captions === 'full' && (
              <p className="improve-caption" data-unlocked={level >= ABILITY_LEVEL}>
                <img src={getCommodityIconUrl(kind)} alt="" aria-hidden="true" />
                <span>
                  <strong>{trackName}</strong> {t(`knights:ability.${track}`)}
                </span>
              </p>
            )}
            {captions !== 'none' && (
              <p className="improve-next">
                <span>
                  {next !== null && cost !== null
                    ? t('knights:improve.nextCost', { level: next, cost, commodity })
                    : t('knights:improve.complete', { track: trackName })}
                </span>
                {holds && <span className="improve-badge">{t('knights:improve.metropolis')}</span>}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function commodityOf(track: Track): 'paper' | 'cloth' | 'coin' {
  const kind = TRACK_COMMODITY[track];
  return kind === 'paper' || kind === 'cloth' ? kind : 'coin';
}

/** A seat's three tracks as three short bars: for player panels, where space is tight. */
export function MiniTracks({ state, seat }: { state: Readonly<GameState>; seat: Seat }) {
  const { t } = useTranslation('knights');
  const ext = knightsState(state);
  if (!ext) return null;
  return (
    <ul className="mini-tracks" aria-label={t('knights:improve.title')}>
      {TRACKS.map((track) => {
        const level = levelOn(ext, seat, track);
        const trackName = t(`knights:track.${track}`);
        return (
          <li
            key={track}
            data-track={track}
            title={t('knights:improve.level', { track: trackName, level, max: MAX_LEVEL })}
            aria-label={t('knights:improve.level', { track: trackName, level, max: MAX_LEVEL })}
          >
            <img src={getTrackIconUrl(track)} alt="" aria-hidden="true" />
            <span className="mini-pips" aria-hidden="true">
              {Array.from({ length: MAX_LEVEL }, (_, index) => (
                <i
                  key={index}
                  data-filled={index < level}
                  data-ability={index + 1 === ABILITY_LEVEL}
                />
              ))}
            </span>
            {ext.metropolises[track]?.seat === seat && (
              <b className="mini-metropolis" aria-hidden="true">
                M
              </b>
            )}
          </li>
        );
      })}
    </ul>
  );
}
