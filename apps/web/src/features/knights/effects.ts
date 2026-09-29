import { BARBARIAN_FIXTURE } from '@cp2p/engine';
import type { GameEvent, GameState, Seat } from '@cp2p/engine';
import type { VertexId } from '@cp2p/engine/geometry';
// The motion constants alone, so this module (and node-side checks) never loads the renderer.
import { DICE_SETTLE_MS } from '@cp2p/renderer/effectMotion';
import type { BoardEffect } from '@cp2p/renderer';
import { knightsState } from './state';

function isVertexId(value: unknown): value is VertexId {
  return typeof value === 'string' && /^v:-?\d+,-?\d+,(N|S)$/.test(value);
}

function level(value: unknown): 1 | 2 | 3 {
  return value === 3 ? 3 : value === 2 ? 2 : 1;
}

function seatOf(state: GameState, value: unknown): Seat | undefined {
  return state.config.seats.find((seat) => seat === value);
}

/** How long an attack's ship takes to reach the island, before any city falls. */
export const BARBARIAN_LANDING_MS = 900;

/**
 * Motion cues for a knights update: the barbarian ship sailing or landing (read from the change
 * in the module's state, since an attack is not an event), knights arriving and moving, walls
 * going up, and cities burning. Cues are visual only and never feed back into the rules.
 */
export function deriveKnightsEffects(
  before: GameState,
  after: GameState,
  events: readonly GameEvent[],
  revision: number,
): BoardEffect[] {
  const was = knightsState(before);
  const now = knightsState(after);
  if (!was || !now) return [];
  const effects: BoardEffect[] = [];
  // The ship waits for the dice to settle when this update carries a roll.
  const delayMs = events.some((event) => event.type === 'diceRolled') ? DICE_SETTLE_MS : 0;
  const fixture = after.board.fixtures?.find((item) => item.id === BARBARIAN_FIXTURE);
  if (fixture) {
    if (now.barbarians.step > was.barbarians.step)
      effects.push({
        id: `${revision}:barbarian-sail`,
        kind: 'barbarian-sail',
        fixture: fixture.id,
        fromStep: was.barbarians.step,
        toStep: now.barbarians.step,
        ...(delayMs > 0 ? { delayMs } : {}),
      });
    else if (now.barbarians.step < was.barbarians.step && now.lastAttack) {
      // Cities lost at once (a seat with one city to lose) fall as the ship lands.
      for (const piece of now.lastAttack.pillaged) {
        const seat = seatOf(after, piece.seat);
        if (!isVertexId(piece.vertex) || seat === undefined) continue;
        effects.push({
          id: `${revision}:pillage:${piece.vertex}`,
          kind: 'pillage',
          at: piece.vertex,
          seat,
          wall: was.walls.some((wall) => wall.vertex === piece.vertex),
          delayMs: delayMs + BARBARIAN_LANDING_MS,
        });
      }
      effects.unshift({
        id: `${revision}:barbarian-attack`,
        kind: 'barbarian-attack',
        fixture: fixture.id,
        fromStep: was.barbarians.step,
        outcome: now.lastAttack.outcome,
        defenders: was.knights.flatMap((knight) =>
          knight.active && isVertexId(knight.vertex) ? [knight.vertex] : [],
        ),
        pillaged: now.lastAttack.pillaged.flatMap((piece) =>
          isVertexId(piece.vertex) ? [piece.vertex] : [],
        ),
        ...(delayMs > 0 ? { delayMs } : {}),
      });
    }
  }
  for (const [index, event] of events.entries()) {
    const id = `${revision}:knights:${index}`;
    const f: Record<string, unknown> = Object.fromEntries(Object.entries(event));
    const seat = seatOf(after, f.seat);
    const vertex = f.vertex;
    const strengthAt = (at: unknown) =>
      level(now.knights.find((knight) => knight.vertex === at)?.level);
    if (
      (event.type === 'knightBuilt' || event.type === 'knightPromoted') &&
      seat !== undefined &&
      isVertexId(vertex)
    )
      effects.push({
        id,
        kind: 'piece-pop',
        piece: 'knight',
        seat,
        at: { kind: 'vertex', id: vertex },
        level: event.type === 'knightPromoted' ? level(f.level) : level(f.level ?? 1),
      });
    else if (event.type === 'cityWallBuilt' && seat !== undefined && isVertexId(vertex))
      effects.push({
        id,
        kind: 'piece-pop',
        piece: 'wall',
        seat,
        at: { kind: 'vertex', id: vertex },
      });
    else if (
      (event.type === 'knightMoved' ||
        event.type === 'knightRelocated' ||
        event.type === 'knightDisplaced') &&
      seat !== undefined &&
      isVertexId(f.from) &&
      isVertexId(f.to)
    )
      effects.push({
        id,
        kind: 'knight-move',
        seat,
        level: strengthAt(f.to),
        fromVertex: f.from,
        toVertex: f.to,
      });
    else if (event.type === 'cityPillaged' && seat !== undefined && isVertexId(vertex))
      effects.push({
        id,
        kind: 'pillage',
        at: vertex,
        seat,
        wall: was.walls.some((wall) => wall.vertex === vertex),
      });
  }
  return effects;
}
