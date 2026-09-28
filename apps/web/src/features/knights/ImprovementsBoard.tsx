import { useTranslation } from 'react-i18next';
import type { GameState, Seat } from '@cp2p/engine';
import {
  getCommodityIconUrl,
  getImprovementBannerUrl,
  getMetropolisIconUrl,
  getTrackIconUrl,
} from '@cp2p/renderer';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { improvementCostOf } from './improvement-cost';
import { ABILITY_LEVEL, MAX_LEVEL, TRACKS, TRACK_COMMODITY, knightsState, levelOn } from './state';
import type { Track } from './state';
import './knights.css';

/** Where the five level cells sit on the printed banner (322 by 82 units). */
const CELL = { x0: 91, step: 46, width: 33, top: 12, height: 55, banner: 322, bannerHeight: 82 };

function pct(value: number, of: number): string {
  return `${(value / of) * 100}%`;
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
  /** Show the ability text under each track. */
  captions?: boolean;
}

/**
 * A seat's city improvements: the three tracks as the printed banners, the levels reached marked in
 * the seat's colour, and, on the viewer's own board, the next level as a button with its cost.
 */
export function ImprovementsBoard({
  state,
  seat,
  presentation,
  buyable,
  onBuy,
  disabled = false,
  captions = true,
}: BoardProps) {
  const { t } = useTranslation('knights');
  const ext = knightsState(state);
  if (!ext) return null;
  const color = presentation.players.find((player) => player.seat === seat)?.color ?? 'blue';
  return (
    <div className={`improvements-board color-${color}`} data-seat={seat}>
      {TRACKS.map((track) => {
        const level = levelOn(ext, seat, track);
        const holder = ext.metropolises[track];
        const next = level < MAX_LEVEL ? level + 1 : null;
        const canBuy = next !== null && buyable?.includes(track) === true;
        const cost = next !== null ? improvementCostOf(state, seat, track) : null;
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
            aria-label={`${summary}${holder?.seat === seat ? `. ${t('knights:improve.holdsMetropolis')}` : ''}`}
          >
            <div className="improve-banner">
              <img
                src={getImprovementBannerUrl(track)}
                alt=""
                aria-hidden="true"
                draggable={false}
              />
              {Array.from({ length: MAX_LEVEL }, (_, index) => {
                const cell = index + 1;
                const style = {
                  left: pct(CELL.x0 + index * CELL.step, CELL.banner),
                  top: pct(CELL.top, CELL.bannerHeight),
                  width: pct(CELL.width, CELL.banner),
                  height: pct(CELL.height, CELL.bannerHeight),
                };
                if (cell <= level)
                  return (
                    <span
                      key={cell}
                      className="improve-cell is-reached"
                      data-level={cell}
                      data-ability={cell === ABILITY_LEVEL}
                      style={style}
                      aria-hidden="true"
                    >
                      <b>{cell}</b>
                    </span>
                  );
                if (cell === next && buyable !== undefined)
                  return (
                    <button
                      key={cell}
                      type="button"
                      className="improve-cell is-next"
                      data-level={cell}
                      data-testid={`improve-${track}`}
                      style={style}
                      disabled={disabled || !canBuy}
                      title={
                        cost
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
                      <span aria-hidden="true">{canBuy ? '+' : ''}</span>
                    </button>
                  );
                return null;
              })}
              {holder?.seat === seat && (
                <img
                  className="improve-metropolis"
                  src={getMetropolisIconUrl(track, color)}
                  alt=""
                  aria-hidden="true"
                />
              )}
            </div>
            {captions && (
              <p className="improve-caption" data-unlocked={level >= ABILITY_LEVEL}>
                <img src={getCommodityIconUrl(commodityOf(track))} alt="" aria-hidden="true" />
                <span>
                  <strong>{trackName}</strong> {t(`knights:ability.${track}`)}
                </span>
              </p>
            )}
            {captions && next !== null && cost !== null && (
              <p className="improve-next">
                {t('knights:improve.nextCost', { level: next, cost, commodity })}
              </p>
            )}
            <img
              className="improve-track-icon"
              src={getTrackIconUrl(track)}
              alt=""
              aria-hidden="true"
            />
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
