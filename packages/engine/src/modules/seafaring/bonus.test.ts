import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import { boardIslands } from '../base/board/index.js';
import { ARCHIPELAGO_MAIN } from './testing.js';
import { regionMap, regionOfVertex, seafaringExt } from './index.js';
import { seafaringEngine } from './testing.js';
import {
  inMain,
  newGame,
  pathVertices,
  rejection,
  shortestSeaPath,
  submit,
  vertexId,
  verticesOfHexes,
  withBuildings,
  withHand,
  withShips,
} from './support.js';

const engine = seafaringEngine();
const V0 = vertexId({ q: 2, r: -1 }, 'NE');

/** A vertex of the hex that does not touch the other hex. */
function farLanding(state: GameState, hex: string, apart: string): string {
  const away = verticesOfHexes(state, [apart]);
  const vertex = [...verticesOfHexes(state, [hex])].find((candidate) => !away.has(candidate));
  if (!vertex) throw new Error('No vertex');
  return vertex;
}

function landing(state: GameState, hex: string): string {
  const vertex = [...verticesOfHexes(state, [hex])][0];
  if (!vertex) throw new Error('No vertex');
  return vertex;
}

/** Seat 0 has settled the main island (its home); the game is in the main phase. */
function playing(options: Parameters<typeof newGame>[1] = {}): GameState {
  const state = inMain(withBuildings(newGame(engine, options), [{ vertex: V0, seat: 0 }]));
  const home = regionOfVertex(state, V0);
  return {
    ...state,
    ext: {
      ...state.ext,
      seafaring: { ...seafaringExt(state), homeRegions: [[home ?? ''], [], []] },
    },
  };
}
/** Give seat 0 a settlement on the hex, with its bonus, and enough cards for a ship. */
function settled(state: GameState, hex: string): GameState {
  const vertex = landing(state, hex);
  return withHand(withBuildings(built(state, 0, vertex), [{ vertex, seat: 0 }]), 0, {
    lumber: 1,
    wool: 1,
  });
}
function shipCommand(state: GameState) {
  const command = engine.getLegalCommands(state, 0).commands.find((c) => c.type === 'BUILD_SHIP');
  if (!command) throw new Error('No ship to build');
  return command;
}
const built = (state: GameState, seat: 0 | 1 | 2, vertex: string, type = 'settlement') =>
  engine.hooks.afterBuild(state, seat, type, vertex);

describe('new-island bonus', () => {
  test('islands are the regions by default, named by their least hex id', () => {
    const state = playing();
    const islands = boardIslands(state);
    expect(islands).toHaveLength(4);
    expect(regionMap(state).get('h:4,-3')).toBe(regionMap(state).get('h:4,-2'));
    expect(regionMap(state).get('h:4,-3')).not.toBe(regionMap(state).get('h:0,0'));
    expect(regionMap(state).get('h:0,0')).toBe(islands.find((i) => i.hexes.includes('h:0,0'))?.id);
  });
  test('the first settlement on each foreign island earns the bonus, once, and never on a home island', () => {
    let state = playing();
    const foreign = landing(state, 'h:4,-3');
    state = built(state, 0, foreign);
    expect(seafaringExt(state).bonus).toEqual([
      { seat: 0, region: regionOfVertex(state, foreign), vertex: foreign },
    ]);
    // A second settlement on the same island earns nothing.
    state = built(state, 0, landing(state, 'h:4,-2'));
    expect(seafaringExt(state).bonus).toHaveLength(1);
    // Cities earn nothing, and the home island earns nothing.
    state = built(state, 0, landing(state, 'h:-4,3'), 'city');
    state = built(state, 0, landing(state, 'h:0,0'));
    expect(seafaringExt(state).bonus).toHaveLength(1);
    // Another seat earns its own bonus for the same island, and for the main island too.
    state = built(state, 1, foreign);
    state = built(state, 1, landing(state, 'h:0,0'));
    expect(seafaringExt(state).bonus.map((token) => token.seat)).toEqual([0, 1, 1]);
    // A second island counts separately.
    state = built(state, 0, landing(state, 'h:0,4'));
    expect(seafaringExt(state).bonus.filter((token) => token.seat === 0)).toHaveLength(2);
  });
  test('the bonus is public points, folded into the seat’s total once', () => {
    const state = settled(playing(), 'h:4,-3');
    expect(state.seats[0]?.publicVp).toBe(0);
    const next = submit(engine, state, 0, shipCommand(state));
    expect(next.seats[0]?.publicVp).toBe(1 + 1 + 2);
    expect(engine.computeVictoryPoints(next, 0).public).toBe(4);
    expect(engine.checkInvariants(next)).toEqual([]);
  });
  test('reaching the target through the bonus wins the game', () => {
    const state = settled(playing({ base: { vpTarget: 3 } }), 'h:4,-3');
    const done = submit(engine, state, 0, shipCommand(state));
    expect(done.seats[0]?.publicVp).toBe(4);
    expect(done.result).toMatchObject({ winner: 0, reason: 'public-vp' });
  });
  test('without the option there is no bonus', () => {
    let state = playing({ seafaring: { islandBonus: null } });
    state = built(state, 0, landing(state, 'h:4,-3'));
    expect(seafaringExt(state).bonus).toEqual([]);
  });
  test('explicit regions replace islands, and hexes outside them earn nothing', () => {
    const strip = ['h:0,0', 'h:1,0'];
    const west = ['h:-1,0', 'h:-2,0'];
    let state = playing({ seafaring: { bonusRegions: [strip, west, ['h:4,-3']] } });
    // The home region is that of the setup settlement V0, which lies on no explicit region.
    expect(regionOfVertex(state, V0)).toBeNull();
    expect(regionOfVertex(state, landing(state, 'h:0,0'))).toBe('h:0,0');
    // A vertex touching two regions counts for the least region id.
    state = built(state, 1, landing(state, 'h:-1,0'));
    expect(seafaringExt(state).bonus.at(-1)?.region).toBe('h:-1,0');
    // A hex in no region (the far island's second hex) earns nothing.
    state = built(state, 2, farLanding(state, 'h:4,-2', 'h:4,-3'));
    expect(seafaringExt(state).bonus.filter((token) => token.seat === 2)).toEqual([]);
    expect(regionMap(state).has('h:4,-2')).toBe(false);
    state = built(state, 2, landing(state, 'h:4,-3'));
    expect(seafaringExt(state).bonus.filter((token) => token.seat === 2)).toHaveLength(1);
  });
  test('invariants catch a bonus with no settlement, a duplicate, or one on a home island', () => {
    let state = playing();
    state = built(state, 0, landing(state, 'h:4,-3'));
    expect(engine.checkInvariants(state)).toContain('island bonus has no settlement');
    const token = seafaringExt(state).bonus[0];
    const tampered = (change: object) => ({
      ...withBuildings(state, [{ vertex: token?.vertex ?? '', seat: 0 }]),
      ext: { ...state.ext, seafaring: { ...seafaringExt(state), ...change } },
    });
    expect(engine.checkInvariants(tampered({}))).toEqual([]);
    expect(engine.checkInvariants(tampered({ bonus: [token, token] }))).toContain(
      'duplicate island bonus',
    );
    expect(engine.checkInvariants(tampered({ homeRegions: [[token?.region], [], []] }))).toContain(
      'island bonus on a home region',
    );
    expect(ARCHIPELAGO_MAIN.length).toBe(19);
  });
  test('a settlement at the end of a shipping route earns the bonus through BUILD_SETTLEMENT', () => {
    const start = withHand(playing(), 0, { brick: 1, lumber: 1, wool: 1, grain: 1 });
    const goals = verticesOfHexes(start, ['h:0,4', 'h:-1,4']);
    const route = shortestSeaPath(start, V0, goals, ['h:3,0']);
    const end = pathVertices(start, V0, route).at(-1) ?? '';
    const state = withShips(start, 0, route);
    const command = { type: 'BUILD_SETTLEMENT', vertex: end };
    expect(rejection(engine, state, 0, command)).toBeNull();
    const next = submit(engine, state, 0, command);
    expect(seafaringExt(next).bonus).toEqual([
      { seat: 0, region: regionOfVertex(next, end), vertex: end },
    ]);
    // Two settlements and the bonus, plus the trade-route award if the ships reach five.
    expect(next.seats[0]?.publicVp).toBe(1 + 1 + 2 + (next.awards.longestRoad === 0 ? 2 : 0));
    expect(engine.checkInvariants(next)).toEqual([]);
  });
});
