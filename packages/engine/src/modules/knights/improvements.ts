import type { CommandHandler, PhaseHandler } from '../../core/modules/index.js';
import type { GameState, PhaseFrame, PrivateState } from '../../core/state/index.js';
import { failure, success } from '../../core/types/index.js';
import type { CardCounts, Result, Seat } from '../../core/types/index.js';
import { claimCommands } from '../base/legal.js';
import {
  affordable,
  exchangeBank,
  playerPending,
  popPhase,
  privateExchange,
  pushPhase,
  topFrame,
  withClaim,
} from '../base/shared.js';
import { ABILITY_LEVEL, KNIGHTS_ID, MAX_LEVEL, TRACKS, TRACK_COMMODITY } from './config.js';
import type { Track } from './config.js';
import { knightsExt, levelOf, updateKnights } from './types.js';
import type { MetropolisFrameData } from './types.js';

export const METROPOLIS_FRAME = 'metropolis';

export function isTrack(value: unknown): value is Track {
  return TRACKS.some((track) => track === value);
}

/** Trading House (trade), Fortress (politics) and Aqueduct (science) come with level 3. */
export function hasAbility(state: GameState, seat: Seat, track: Track): boolean {
  return levelOf(state, seat, track) >= ABILITY_LEVEL;
}

/** The seat's cities, by vertex id. A metropolis sits on top of its city. */
export function citiesOf(state: GameState, seat: Seat): string[] {
  return state.board.buildings
    .filter((piece) => piece.seat === seat && piece.kind === 'city')
    .map((piece) => piece.vertex)
    .toSorted();
}

/** The seat's cities that carry no metropolis, by vertex id. */
export function availableCities(state: GameState, seat: Seat): string[] {
  const taken = new Set(
    Object.values(knightsExt(state).metropolises).flatMap((holder) =>
      holder ? [holder.vertex] : [],
    ),
  );
  return citiesOf(state, seat).filter((vertex) => !taken.has(vertex));
}

/** Level `k` costs `k` commodities of the track's kind. */
export function improvementCost(state: GameState, seat: Seat, track: Track): CardCounts {
  return { [TRACK_COMMODITY[track]]: levelOf(state, seat, track) + 1 };
}

/**
 * Who takes the track's metropolis when `seat` reaches `level`: nobody (`null`), or the seat
 * takes it, `from` being the level-4 holder it is taken from, or null when it is unclaimed.
 */
export function metropolisAward(
  state: GameState,
  seat: Seat,
  track: Track,
  level: number,
): { from: Seat | null } | null {
  const holder = knightsExt(state).metropolises[track];
  if (level < 4 || level > MAX_LEVEL) return null;
  if (holder === null) return { from: null };
  if (holder.seat === seat) return null;
  return level === MAX_LEVEL && levelOf(state, holder.seat, track) < MAX_LEVEL
    ? { from: holder.seat }
    : null;
}

/** Everything but the price: a level to buy, a city on the board, and a city for a metropolis. */
export function improvementProblem(state: GameState, seat: Seat, track: Track): Result<void> {
  const level = levelOf(state, seat, track) + 1;
  if (level > MAX_LEVEL) return failure('max-level', 'This track is already at level 5');
  if (citiesOf(state, seat).length === 0)
    return failure('no-city', 'A city is needed to improve a track');
  if (level >= 4) {
    // The holder buying its own level 5 already has its metropolis placed.
    const ownMetropolis = knightsExt(state).metropolises[track]?.seat === seat;
    if (!(level === MAX_LEVEL && ownMetropolis) && availableCities(state, seat).length === 0)
      return failure('no-available-city', 'Level 4 and 5 need a city without a metropolis');
  }
  return success(undefined);
}

/** The public check for a purchase, including the price. */
export function improvementLegal(state: GameState, seat: Seat, track: Track): Result<void> {
  const problem = improvementProblem(state, seat, track);
  return problem.ok ? affordable(state, seat, improvementCost(state, seat, track)) : problem;
}

/** Whether the owner's own hand pays for the next level, without ever looking at the bank. */
export function privateCanImprove(
  state: GameState,
  seat: Seat,
  track: Track,
  priv: PrivateState,
): boolean {
  return Object.entries(improvementCost(state, seat, track)).every(
    ([kind, count]) => (priv.hand[kind] ?? 0) >= count,
  );
}

function metropolisFrame(data: MetropolisFrameData): PhaseFrame {
  return { id: METROPOLIS_FRAME, module: KNIGHTS_ID, data };
}

function metropolisData(state: GameState): MetropolisFrameData {
  const frame = topFrame(state);
  const value: unknown = frame?.data;
  if (frame?.module !== KNIGHTS_ID || frame.id !== METROPOLIS_FRAME || typeof value !== 'object')
    throw new Error('Expected a metropolis choice');
  // Only BUILD_IMPROVEMENT builds this phase data.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as MetropolisFrameData;
}

/** Put the track's metropolis on a city of the seat. An old holder loses it. */
function placeMetropolis(
  state: GameState,
  seat: Seat,
  track: Track,
  vertex: string,
): { state: GameState; from: Seat | null } {
  const from = knightsExt(state).metropolises[track]?.seat ?? null;
  return {
    state: updateKnights(state, (old) => ({
      ...old,
      metropolises: { ...old.metropolises, [track]: { seat, vertex } },
    })),
    from,
  };
}

function trackOf(value: unknown): Track | null {
  return isTrack(value) ? value : null;
}

/** Buy the next level of a track with the track's commodity. */
export const buildImprovement: CommandHandler = {
  keys: { allowed: ['track'] },
  validate: (state, input) => {
    const track = trackOf(input.command.track);
    if (track === null)
      return failure('invalid-track', 'Choose the trade, politics or science track');
    return improvementLegal(state, input.seat, track);
  },
  apply: (state, input) => {
    const track = trackOf(input.command.track);
    if (track === null) throw new Error('Validated track missing');
    const level = levelOf(state, input.seat, track) + 1;
    const spent = exchangeBank(state, input.seat, improvementCost(state, input.seat, track), false);
    let next = updateKnights(spent.state, (old) => ({
      ...old,
      improvements: old.improvements.map((levels, seat) =>
        seat === input.seat ? { ...levels, [track]: level } : levels,
      ),
    }));
    const events: { type: string; [key: string]: unknown }[] = [
      { type: 'improvementBuilt', seat: input.seat, track, level },
    ];
    // The award is decided on the position before the purchase: it only reads other seats' levels
    // and the holder, which the purchase does not change.
    if (metropolisAward(state, input.seat, track, level)) {
      const spots = availableCities(next, input.seat);
      const only = spots[0];
      if (spots.length === 1 && only !== undefined) {
        const placed = placeMetropolis(next, input.seat, track, only);
        next = placed.state;
        events.push({
          type: 'metropolisPlaced',
          seat: input.seat,
          track,
          vertex: only,
          from: placed.from,
        });
      } else {
        next = pushPhase(next, metropolisFrame({ seat: input.seat, track }));
      }
    }
    return { state: next, events, effects: spent.effects };
  },
  applyPrivate: (priv, before, input) => {
    if (priv.seat !== input.seat) return success(priv);
    const track = trackOf(input.command.track);
    return track === null
      ? failure('invalid-track', 'Track missing')
      : privateExchange(priv, improvementCost(before, input.seat, track), false);
  },
};

/** The city a metropolis goes on, when the seat has several without one. */
export const placeMetropolisCommand: CommandHandler = {
  keys: { allowed: ['track', 'vertex'] },
  validate: (state, input) => {
    const frame = topFrame(state);
    if (frame?.module !== KNIGHTS_ID || frame.id !== METROPOLIS_FRAME)
      return failure('no-metropolis-choice', 'No metropolis is waiting for a city');
    const data = metropolisData(state);
    if (data.seat !== input.seat)
      return failure('not-placing-metropolis', 'It is not this seat’s metropolis');
    if (input.command.track !== data.track)
      return failure('wrong-track', 'The metropolis belongs to another track');
    const vertex = input.command.vertex;
    return typeof vertex === 'string' && availableCities(state, input.seat).includes(vertex)
      ? success(undefined)
      : failure('illegal-metropolis', 'The metropolis needs one of your cities without one');
  },
  apply: (state, input) => {
    const data = metropolisData(state);
    const vertex = input.command.vertex;
    if (typeof vertex !== 'string') throw new Error('Validated metropolis vertex missing');
    const placed = placeMetropolis(popPhase(state), data.seat, data.track, vertex);
    return {
      state: placed.state,
      events: [
        {
          type: 'metropolisPlaced',
          seat: data.seat,
          track: data.track,
          vertex,
          from: placed.from,
        },
      ],
      effects: [],
    };
  },
};

export const metropolisPhase: PhaseHandler = {
  pending: (state) => {
    const { seat } = metropolisData(state);
    return withClaim(state, [playerPending(state, seat, ['PLACE_METROPOLIS'], METROPOLIS_FRAME)]);
  },
  legalCommands: (state, _frame, seat, priv, ctx) => {
    const claim = claimCommands(state, seat, priv, ctx);
    const data = metropolisData(state);
    if (data.seat !== seat) return claim;
    return {
      commands: [
        ...availableCities(state, seat).map((vertex) => ({
          type: 'PLACE_METROPOLIS',
          track: data.track,
          vertex,
        })),
        ...claim.commands,
      ],
      templates: claim.templates,
    };
  },
};

/** The lowest available city id: the choice a timeout makes for a metropolis. */
export function automaticMetropolis(state: GameState, seat: Seat) {
  const data = metropolisData(state);
  const vertex = availableCities(state, seat)[0];
  return data.seat === seat && vertex !== undefined
    ? { type: 'PLACE_METROPOLIS', track: data.track, vertex }
    : null;
}
