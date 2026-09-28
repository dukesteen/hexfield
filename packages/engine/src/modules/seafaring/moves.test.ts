import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import { boardGraph } from '../base/board/index.js';
import { legalShipEdges, legalShipMoves, movableShips, seafaringExt } from './index.js';
import { seafaringEngine } from './testing.js';
import {
  edgesAt,
  edgesOfHex,
  inMain,
  newGame,
  otherEnd,
  pathVertices,
  rejection,
  seaPath,
  submit,
  vertexId,
  withBuildings,
  withShips,
} from './support.js';

const engine = seafaringEngine();
const V0 = vertexId({ q: 2, r: -1 }, 'NE');
/** A sea hex whose ring of six edges touches V0, away from the pirate. */
const RING = 'h:3,-2';

/** Ships from V0 first across open water (a sea-sea edge), then on, away from the pirate. */
function chain(length: number): { state: GameState; ships: string[] } {
  const base = inMain(withBuildings(newGame(engine), [{ vertex: V0, seat: 0 }]));
  const graph = boardGraph(base);
  const first = edgesAt(base, V0).find((edge) => {
    const owners = graph.edgeHexes[graph.edgeIndex[edge] ?? -1] ?? [];
    return owners.every((id) => base.board.hexes.find((hex) => hex.id === id)?.terrain === 'sea');
  });
  if (!first) throw new Error('No open-water edge at V0');
  const rest =
    length > 1
      ? seaPath(base, otherEnd(base, first, V0), length - 1, {
          keepClear: ['h:3,0'],
          avoid: new Set([first]),
        })
      : [];
  const ships = [first, ...rest];
  return { state: withShips(base, 0, ships), ships };
}

describe('moving ships', () => {
  test('only the ship at the open end of an open route may move', () => {
    const { state, ships } = chain(3);
    expect(movableShips(state, 0)).toEqual([ships[2]]);
    expect(movableShips(state, 1)).toEqual([]);
    const commands = engine
      .getLegalCommands(state, 0)
      .commands.filter((c) => c.type === 'MOVE_SHIP');
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => command.from === ships[2])).toBe(true);
  });
  test('a ship built this turn cannot move', () => {
    const { state, ships } = chain(2);
    const fresh = {
      ...state,
      ext: { ...state.ext, seafaring: { ...seafaringExt(state), builtThisTurn: [ships[1]] } },
    };
    expect(movableShips(fresh, 0)).toEqual([]);
    expect(rejection(engine, fresh, 0, { type: 'MOVE_SHIP', from: ships[1], to: ships[0] })).toBe(
      'ship-cannot-move',
    );
  });
  test('a move is free, once per turn, and the ship must go where a new ship could', () => {
    const { state, ships } = chain(2);
    const tail = ships[1] ?? '';
    const targets = legalShipMoves(state, 0).map((move) => move.to);
    expect(targets.length).toBeGreaterThan(0);
    // Edges at the moved ship's own far end could only connect through the ship itself.
    const far = otherEnd(state, tail, otherEnd(state, ships[0] ?? '', V0));
    expect(targets.some((edge) => edgesAt(state, far).includes(edge) && edge !== tail)).toBe(false);
    const to = targets[0] ?? '';
    expect(engine.getLegalCommands(state, 0).commands).toContainEqual({
      type: 'MOVE_SHIP',
      from: tail,
      to,
    });
    const moved = submit(engine, state, 0, { type: 'MOVE_SHIP', from: tail, to });
    expect(moved.board.ships).toContainEqual({ edge: to, seat: 0 });
    expect(moved.board.ships).not.toContainEqual({ edge: tail, seat: 0 });
    expect(moved.board.ships).toHaveLength(2);
    expect(moved.seats[0]?.piecesLeft.ship).toBe(13);
    expect(seafaringExt(moved).shipMovedTurn).toBe(5);
    expect(engine.checkInvariants(moved)).toEqual([]);
    // No second move, in the command list or by validation.
    expect(engine.getLegalCommands(moved, 0).commands.some((c) => c.type === 'MOVE_SHIP')).toBe(
      false,
    );
    const again = legalShipMoves(moved, 0)[0];
    expect(
      rejection(engine, moved, 0, { type: 'MOVE_SHIP', from: again?.from, to: again?.to }),
    ).toBe('ship-already-moved');
    // The next turn allows another move (the moved ship was built or moved "this turn" only).
    const later = {
      ...moved,
      turn: { ...moved.turn, number: 8 },
      ext: { ...moved.ext, seafaring: { ...seafaringExt(moved), builtThisTurn: [] } },
    };
    expect(legalShipMoves(later, 0).length).toBeGreaterThan(0);
  });
  test('the destination is judged with the moved ship removed, so it may reconnect to its own route', () => {
    const { state, ships } = chain(2);
    const rest = {
      ...state.board,
      ...(state.board.ships ? { ships: state.board.ships.filter((s) => s.edge !== ships[1]) } : {}),
    };
    const alternative = legalShipEdges({ ...state, board: rest }, 0).filter(
      (edge) =>
        edge !== ships[1] && edgesAt(state, otherEnd(state, ships[0] ?? '', V0)).includes(edge),
    );
    expect(alternative.length).toBeGreaterThan(0);
    for (const to of alternative)
      expect(rejection(engine, state, 0, { type: 'MOVE_SHIP', from: ships[1], to })).toBeNull();
  });
  test('bad moves are rejected', () => {
    const { state, ships } = chain(2);
    const to = legalShipMoves(state, 0)[0]?.to;
    expect(rejection(engine, state, 0, { type: 'MOVE_SHIP', from: ships[1], to: ships[1] })).toBe(
      'illegal-ship',
    );
    expect(rejection(engine, state, 0, { type: 'MOVE_SHIP', from: ships[0], to })).toBe(
      'ship-cannot-move',
    );
    expect(rejection(engine, state, 0, { type: 'MOVE_SHIP', from: ships[1] })).toBe('invalid-edge');
    expect(rejection(engine, state, 0, { type: 'MOVE_SHIP', from: 'e:9,9,W', to })).toBe(
      'ship-cannot-move',
    );
    expect(rejection(engine, state, 1, { type: 'MOVE_SHIP', from: ships[1], to })).toBe(
      'not-pending',
    );
    expect(rejection(engine, state, 0, { type: 'MOVE_SHIP', from: ships[1], to: 'e:9,9,W' })).toBe(
      'illegal-ship',
    );
  });
  test('a closed route, joining two own settlements, cannot move, even if it is cut', () => {
    const { state, ships } = chain(2);
    const end = pathVertices(state, V0, ships).at(-1) ?? '';
    const closed = withBuildings(state, [{ vertex: end, seat: 0 }]);
    expect(movableShips(closed, 0)).toEqual([]);
    const middle = pathVertices(state, V0, ships)[1] ?? '';
    const cut = withBuildings(closed, [{ vertex: middle, seat: 1 }]);
    expect(movableShips(cut, 0)).toEqual([]);
    // An opponent's building at an open end changes nothing either.
    const capped = withBuildings(state, [{ vertex: end, seat: 1 }]);
    expect(movableShips(capped, 0)).toEqual([ships[1]]);
  });
  test('an own settlement in the middle splits a chain into two routes', () => {
    const { state, ships } = chain(4);
    const middle = pathVertices(state, V0, ships)[2] ?? '';
    const split = withBuildings(state, [{ vertex: middle, seat: 0 }]);
    // Each half touches one building, so each is open: the ship at the far end can move.
    expect(movableShips(split, 0)).toEqual([ships[3]]);
  });
  test('a circle of ships with no building lets every ship on it move', () => {
    const base = inMain(newGame(engine));
    const ring = edgesOfHex(base, RING);
    const state = withShips(base, 0, ring);
    expect(movableShips(state, 0)).toEqual([...ring].toSorted());
  });
  test('a circle through one own building lets only the two ships beside it move', () => {
    const base = inMain(withBuildings(newGame(engine), [{ vertex: V0, seat: 0 }]));
    const ring = edgesOfHex(base, RING);
    const state = withShips(base, 0, ring);
    expect(movableShips(state, 0)).toEqual(
      edgesAt(base, V0)
        .filter((edge) => ring.includes(edge))
        .toSorted(),
    );
    expect(movableShips(state, 0)).toHaveLength(2);
  });
  test('a circle through two buildings is a closed route', () => {
    const base = inMain(withBuildings(newGame(engine), [{ vertex: V0, seat: 0 }]));
    const ring = edgesOfHex(base, RING);
    const opposite = vertexId({ q: 3, r: -2 }, 'N');
    const state = withBuildings(withShips(base, 0, ring), [{ vertex: opposite, seat: 0 }]);
    expect(movableShips(state, 0)).toEqual([]);
  });
  test('a ship on the pirate’s hex cannot move, and no ship may move onto its edges', () => {
    const { state, ships } = chain(3);
    const last = ships[2] ?? '';
    const graph = boardGraph(state);
    const hex = (graph.edgeHexes[graph.edgeIndex[last] ?? -1] ?? []).find(
      (id) => state.board.hexes.find((h) => h.id === id)?.terrain === 'sea',
    );
    expect(hex).toBeDefined();
    const pinned = {
      ...state,
      ext: { ...state.ext, seafaring: { ...seafaringExt(state), pirateHex: hex ?? null } },
    };
    expect(movableShips(state, 0)).toEqual([last]);
    expect(movableShips(pinned, 0)).toEqual([]);
    expect(
      rejection(engine, pinned, 0, {
        type: 'MOVE_SHIP',
        from: last,
        to: legalShipMoves(state, 0)[0]?.to,
      }),
    ).toBe('ship-cannot-move');
    // A target's own sea hex, holding the pirate, takes that target off the list.
    const target = legalShipMoves(state, 0)[0]?.to ?? '';
    const shore = (graph.edgeHexes[graph.edgeIndex[target] ?? -1] ?? []).find(
      (id) => state.board.hexes.find((h) => h.id === id)?.terrain === 'sea',
    );
    const guarded = {
      ...state,
      ext: { ...state.ext, seafaring: { ...seafaringExt(state), pirateHex: shore ?? null } },
    };
    const blocked = edgesOfHex(guarded, shore ?? '');
    expect(blocked).toContain(target);
    expect(legalShipMoves(guarded, 0).every((move) => !blocked.includes(move.to))).toBe(true);
    expect(
      rejection(engine, guarded, 0, { type: 'MOVE_SHIP', from: last, to: target }),
    ).not.toBeNull();
  });
});
