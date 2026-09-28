import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import { boardGraph, edgeHasSeaSide } from '../base/board/index.js';
import { seafaringExt } from './index.js';
import { seafaringEngine } from './testing.js';
import { newGame, withShips } from './support.js';

const engine = seafaringEngine();

function edgesWhere(state: GameState, keep: (edge: string) => boolean): string[] {
  return boardGraph(state).edgeIds.filter(keep);
}

describe('seafaring invariants', () => {
  const state = newGame(engine);

  test('a fresh game holds them all', () => {
    expect(engine.checkInvariants(state)).toEqual([]);
  });

  test('a ship on an edge that touches no sea is reported', () => {
    const [inland] = edgesWhere(state, (edge) => !edgeHasSeaSide(state, edge));
    if (!inland) throw new Error('No inland edge');
    expect(engine.checkInvariants(withShips(state, 0, [inland]))).toContain(
      'ship must touch the sea',
    );
    const [coastalOrSea] = edgesWhere(state, (edge) => edgeHasSeaSide(state, edge));
    if (!coastalOrSea) throw new Error('No sea-side edge');
    expect(engine.checkInvariants(withShips(state, 0, [coastalOrSea]))).toEqual([]);
  });

  test('sixteen ships for one seat are reported, fifteen are not', () => {
    const sea = edgesWhere(state, (edge) => edgeHasSeaSide(state, edge));
    expect(sea.length).toBeGreaterThanOrEqual(16);
    expect(engine.checkInvariants(withShips(state, 0, sea.slice(0, 15)))).toEqual([]);
    expect(engine.checkInvariants(withShips(state, 0, sea.slice(0, 16)))).toContain(
      'seat 0 placed too many ships',
    );
  });

  test('a pirate on land is reported', () => {
    const land = state.board.hexes.find((hex) => hex.terrain !== 'sea');
    if (!land) throw new Error('No land hex');
    const pirated = {
      ...state,
      ext: { ...state.ext, seafaring: { ...seafaringExt(state), pirateHex: land.id } },
    };
    expect(engine.checkInvariants(pirated)).toContain('pirate must occupy a sea hex');
  });

  test('a robber at sea is reported', () => {
    const sea = state.board.hexes.find((hex) => hex.terrain === 'sea');
    if (!sea) throw new Error('No sea hex');
    const robbed = { ...state, board: { ...state.board, robberHex: sea.id } };
    expect(engine.checkInvariants(robbed)).toContain('robber must occupy a land hex');
  });
});
