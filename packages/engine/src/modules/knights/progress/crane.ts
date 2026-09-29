import { affordable } from '../../base/shared.js';
import { TRACKS, TRACK_COMMODITY } from '../config.js';
import type { Track } from '../config.js';
import { buyLevel, improvementProblem, isTrack } from '../improvements.js';
import { levelOf } from '../types.js';
import { paramsObject } from './card.js';
import type { CardModule } from './card.js';
import { failure, success } from '../../../core/types/index.js';
import type { CardCounts, Result, Seat } from '../../../core/types/index.js';
import type { GameState } from '../../../core/state/index.js';

function trackOf(params: unknown): Result<Track> {
  const object = paramsObject(params, ['track']);
  if (!object.ok) return object;
  const track = object.value.track;
  return isTrack(track) ? success(track) : failure('invalid-track', 'Choose an improvement track');
}

/** The next level with one commodity less: level 1 is free. */
export function craneCost(state: GameState, seat: Seat, track: Track): CardCounts {
  return { [TRACK_COMMODITY[track]]: levelOf(state, seat, track) };
}

/**
 * Crane, played as part of the purchase: the next improvement of a track costs one commodity less,
 * and level 1 is free. One Crane covers one improvement; two Cranes can buy two levels in a turn.
 */
export const crane: CardModule = {
  card: {
    id: 'crane',
    timing: 'main',
    problem: (state, seat, params) => {
      const track = trackOf(params);
      if (!track.ok) return track;
      const problem = improvementProblem(state, seat, track.value);
      return problem.ok ? affordable(state, seat, craneCost(state, seat, track.value)) : problem;
    },
    options: (state, seat, _ctx, priv) =>
      TRACKS.filter((track) => {
        const cost = craneCost(state, seat, track);
        return Object.entries(cost).every(([kind, count]) => (priv?.hand[kind] ?? count) >= count);
      }).map((track) => ({ track })),
    apply: (state, seat, params) => {
      const track = trackOf(params);
      if (!track.ok) throw new Error('Validated Crane track missing');
      return buyLevel(state, seat, track.value, craneCost(state, seat, track.value));
    },
  },
};
