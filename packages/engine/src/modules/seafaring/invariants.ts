import type { HandlerContext } from '../../core/modules/index.js';
import type { GameState } from '../../core/state/index.js';
import { boardGraph, edgeHasSeaSide } from '../base/board/index.js';
import { PIECES_START } from '../base/constants.js';
import { FOG_FRAME, FOG_TERRAIN_DECK } from './fog.js';
import { regionIds, regionOfVertex } from './islands.js';
import { seafaringExt, seafaringOptions } from './types.js';

/** Fog hexes match the undrawn terrain tiles, and a reveal in progress only names fog hexes. */
function fogInvariants(state: GameState): string[] {
  const reveal = seafaringExt(state).fog;
  if (reveal === undefined) return [];
  const errors: string[] = [];
  const hidden = new Set(
    state.board.hexes.filter((hex) => hex.terrain === 'fog').map((hex) => hex.id),
  );
  const terrainLeft = state.decks[FOG_TERRAIN_DECK]?.remaining ?? -1;
  // A drawn terrain waits in the reveal until its token is drawn, and its hex is still fog.
  if (hidden.size !== terrainLeft + (reveal?.terrain === null || !reveal ? 0 : 1))
    errors.push('fog hexes do not match the undrawn fog tiles');
  if (reveal && new Set(reveal.hexes).size !== reveal.hexes.length)
    errors.push('duplicate fog hex in a reveal');
  if (reveal?.hexes.some((hex) => !hidden.has(hex))) errors.push('a revealing hex is not fog');
  if (reveal && reveal.terrain !== null && reveal.hexes.length === 0)
    errors.push('a fog terrain without a hex');
  // Hexes wait in a frame, except in a finished game, where the placing input ended it.
  const open = state.turn.phase.some(
    (item) => item.module === 'seafaring' && item.id === FOG_FRAME,
  );
  if (
    !state.result &&
    open !== (reveal !== undefined && reveal !== null && reveal.hexes.length > 0)
  )
    errors.push('fog hexes and the fog frame disagree');
  return errors;
}

/** Public checks for ships, the pirate and the island bonus. */
export function seafaringInvariants(state: GameState, ctx: HandlerContext): string[] {
  const errors: string[] = [];
  const graph = boardGraph(state);
  const ext = seafaringExt(state);
  const limit = ctx.hooks.pieceLimits(state.config, PIECES_START).ship ?? 0;
  const ships = state.board.ships;
  if (!ships) return ['seafaring board has no ships list'];
  if (new Set(ships.map((ship) => ship.edge)).size !== ships.length)
    errors.push('duplicate ship edge');
  for (const ship of ships) {
    if (graph.edgeIndex[ship.edge] === undefined) errors.push('ship uses unknown edge');
    else if (!edgeHasSeaSide(state, ship.edge)) errors.push('ship must touch the sea');
    if (!state.config.seats.includes(ship.seat)) errors.push('ship has unknown owner');
  }
  for (const seat of state.seats) {
    const count = ships.filter((ship) => ship.seat === seat.seat).length;
    if (count > limit) errors.push(`seat ${seat.seat} placed too many ships`);
    if (count + (seat.piecesLeft.ship ?? -1) !== limit)
      errors.push(`seat ${seat.seat} ship supply mismatch`);
  }
  if (ext.builtThisTurn.some((edge) => !ships.some((ship) => ship.edge === edge)))
    errors.push('a ship built this turn is not on the board');
  if (ext.pirateHex !== null) {
    const hex = state.board.hexes.find((item) => item.id === ext.pirateHex);
    if (hex?.terrain !== 'sea') errors.push('pirate must occupy a sea hex');
  }
  errors.push(...fogInvariants(state));
  const bonus = seafaringOptions(state).islandBonus;
  if (bonus === null && ext.bonus.length > 0) errors.push('island bonus without a bonus option');
  const regions = regionIds(state);
  const seen = new Set<string>();
  for (const token of ext.bonus) {
    const key = `${token.seat}:${token.region}`;
    if (seen.has(key)) errors.push('duplicate island bonus');
    seen.add(key);
    if (!regions.has(token.region) || regionOfVertex(state, token.vertex) !== token.region)
      errors.push('island bonus region does not match its settlement');
    if (
      !state.board.buildings.some(
        (piece) => piece.vertex === token.vertex && piece.seat === token.seat,
      )
    )
      errors.push('island bonus has no settlement');
    if ((ext.homeRegions[token.seat] ?? []).includes(token.region))
      errors.push('island bonus on a home region');
  }
  return errors;
}
