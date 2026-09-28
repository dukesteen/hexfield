import { useTranslation } from 'react-i18next';
import type { GameState, Seat } from '@cp2p/engine';
import { getTrackIconUrl } from '@cp2p/renderer';
import { ABILITY_LEVEL, MAX_LEVEL, TRACKS, knightsState, levelOn } from './state';
import type { Track } from './state';
import './knights.css';

/**
 * The three tracks in one compact row above a phone's hand: level pips for each, and a mark on the
 * ones that can be bought now. Tapping it opens the full board.
 */
export function ImprovementsStrip({
  state,
  seat,
  improvable,
  onOpen,
}: {
  state: Readonly<GameState>;
  seat: Seat;
  improvable: readonly Track[];
  onOpen: () => void;
}) {
  const { t } = useTranslation('knights');
  const ext = knightsState(state);
  if (!ext) return null;
  return (
    <button
      type="button"
      className="improvements-strip"
      data-testid="improvements-strip"
      aria-label={t('knights:improve.open')}
      onClick={onOpen}
    >
      {TRACKS.map((track) => {
        const level = levelOn(ext, seat, track);
        const trackName = t(`knights:track.${track}`);
        return (
          <span
            key={track}
            className="strip-track"
            data-track={track}
            data-buyable={improvable.includes(track)}
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
            <b aria-hidden="true">{level}</b>
          </span>
        );
      })}
    </button>
  );
}
