import type { GameState } from '../../core/state/index.js';
import { COMMODITIES, EVENT_DIE, KNIGHTS_ID, MAX_LEVEL, TRACKS, WALLS_PER_SEAT } from './config.js';
import { knightsExt } from './types.js';

/** Public checks for improvements, metropolises, walls and the robber lock. */
export function knightsInvariants(state: GameState): string[] {
  const errors: string[] = [];
  const ext = knightsExt(state);
  const seats = state.config.seats;
  if (ext.improvements.length !== seats.length) errors.push('improvements are not per seat');
  for (const levels of ext.improvements)
    for (const track of TRACKS) {
      const level = levels[track];
      if (!Number.isSafeInteger(level) || level < 0 || level > MAX_LEVEL)
        errors.push(`invalid ${track} level`);
    }
  const choosing = state.turn.phase.some(
    (frame) => frame.module === KNIGHTS_ID && frame.id === 'metropolis',
  );
  const cities = new Set(
    state.board.buildings.filter((piece) => piece.kind === 'city').map((piece) => piece.vertex),
  );
  const used = new Set<string>();
  for (const track of TRACKS) {
    const holder = ext.metropolises[track];
    if (holder === null) {
      // A level-4 seat always claims the metropolis, but it may still be choosing its city.
      const someoneAtFour = ext.improvements.some((levels) => levels[track] >= 4);
      if (someoneAtFour && !choosing) errors.push(`${track} has a level-4 seat and no metropolis`);
      continue;
    }
    const owner = state.board.buildings.find((piece) => piece.vertex === holder.vertex);
    if (!seats.includes(holder.seat) || owner?.seat !== holder.seat || !cities.has(holder.vertex))
      errors.push(`${track} metropolis is not on a city of its holder`);
    if ((ext.improvements[holder.seat]?.[track] ?? 0) < 4)
      errors.push(`${track} metropolis holder is below level 4`);
    if (used.has(holder.vertex)) errors.push('two metropolises on one city');
    used.add(holder.vertex);
    // The first seat to level 5 holds the metropolis for good, so a level-5 seat means a level-5 holder.
    if (
      !choosing &&
      ext.improvements.some((levels) => levels[track] === MAX_LEVEL) &&
      (ext.improvements[holder.seat]?.[track] ?? 0) < MAX_LEVEL
    )
      errors.push(`${track} metropolis is with a level-4 seat although a seat is at level 5`);
  }
  const walls = new Set<string>();
  for (const wall of ext.walls) {
    if (walls.has(wall.vertex)) errors.push('two walls on one city');
    walls.add(wall.vertex);
    if (state.board.buildings.find((piece) => piece.vertex === wall.vertex)?.seat !== wall.seat)
      errors.push('a wall is not on a city of its owner');
  }
  for (const seat of seats)
    if (ext.walls.filter((wall) => wall.seat === seat).length > WALLS_PER_SEAT)
      errors.push(`seat ${seat} has too many walls`);
  if (ext.eventDie !== null && !EVENT_DIE.faces.includes(ext.eventDie))
    errors.push('unknown event die face');
  if (ext.noProduction.length > 0) errors.push('an Aqueduct note outlived its roll');
  if (!Number.isSafeInteger(ext.barbarians.step) || ext.barbarians.step < 0)
    errors.push('invalid barbarian step');
  for (const kind of COMMODITIES)
    if (!Object.hasOwn(state.bank, kind)) errors.push(`bank has no ${kind}`);
  return errors;
}
