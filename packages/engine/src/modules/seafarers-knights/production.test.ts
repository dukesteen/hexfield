import { describe, expect, test } from 'vitest';
import { hexId, vertexId } from '../../core/geometry/index.js';
import { isPublicDraw, publicDrawInput } from '../../core/pipeline/index.js';
import type { BoardState, GameState } from '../../core/state/index.js';
import { RESOURCES } from '../../core/types/index.js';
import { explicitBoard } from '../seafaring/testing.js';
import type { HexSpec } from '../seafaring/testing.js';
import { seafaringExt } from '../seafaring/types.js';
import { seafarersKnightsEngine } from './testing.js';
import {
  COAST,
  HOME,
  S1,
  S2,
  engine,
  handOf,
  inDice,
  inMain,
  legal,
  newGame,
  roll,
  submit,
  top,
  withBuildings,
  withHand,
  withKnights,
  withLevels,
  withRoads,
  withShips,
} from './support.js';

/** A corner of the gold hex (token 6) shared with the fields island and the sea. */
const GOLD_CORNER = 'v:4,-2,N';
const SIX: [number, number] = [3, 3];

describe('gold fields', () => {
  test('a city on gold claims two resources of its choice, never a commodity', () => {
    const state = inDice(
      withBuildings(newGame(), [{ vertex: GOLD_CORNER, seat: 0, kind: 'city' }]),
    );
    const after = roll(engine, state, SIX, 'trade');
    expect(top(after)).toMatchObject({
      id: 'goldChoice',
      data: { queue: [{ seat: 0, claim: 2 }] },
    });
    const choices = legal(after, 0, 'CHOOSE_GOLD');
    expect(choices.length).toBeGreaterThan(0);
    const kinds = new Set<string>(RESOURCES);
    const offered = choices.flatMap((choice) =>
      typeof choice.resources === 'object' && choice.resources !== null
        ? Object.keys(choice.resources)
        : ['none'],
    );
    expect(offered.filter((kind) => !kinds.has(kind))).toEqual([]);
    const chosen = submit(after, 0, { type: 'CHOOSE_GOLD', resources: { grain: 1, ore: 1 } });
    expect(handOf(chosen, 0)).toMatchObject({ grain: 1, ore: 1, paper: 0, cloth: 0, coin: 0 });
    expect(engine.checkInvariants(chosen)).toEqual([]);
  });

  test('a seat with a gold claim received production, so the Aqueduct does not pay it', () => {
    const base = withLevels(withBuildings(newGame(), [{ vertex: GOLD_CORNER, seat: 0 }]), 0, {
      science: 3,
    });
    // A 6: only the gold hex pays seat 0 (a choice), so no Aqueduct card.
    const gold = roll(engine, inDice(base), SIX, 'trade');
    expect(top(gold)?.id).toBe('goldChoice');
    const chosen = submit(gold, 0, { type: 'CHOOSE_GOLD', resources: { brick: 1 } });
    expect(top(chosen)?.id).toBe('main');
    // A 5 pays seat 0 nothing, so the Aqueduct does.
    const none = roll(engine, inDice(base), [2, 3], 'trade');
    expect(top(none)).toMatchObject({ id: 'aqueduct', module: 'knights' });
  });
});

describe('setup', () => {
  test('round 2 places a city, ships may start either round, and no gold is paid', () => {
    const started = engine.apply(newGame({ seats: 3 }), {
      kind: 'system',
      type: 'START_SEAT',
      seat: 0,
    });
    if (!started.ok) throw new Error(started.error.message);
    let state = started.value.state;
    let ships = 0;
    for (let guard = 0; guard < 40 && top(state)?.id === 'setup'; guard++) {
      const pending = engine
        .getPending(state)
        .find(
          (item) => item.kind === 'player' && item.allowed.some((type) => type.startsWith('PLACE')),
        );
      if (!pending || pending.kind !== 'player') break;
      const seat = pending.seat;
      const commands = engine.getLegalCommands(state, seat).commands;
      const pick =
        commands.find((command) => command.type === 'PLACE_SETTLEMENT') ??
        commands.find((command) => command.type === 'PLACE_SETUP_SHIP') ??
        commands.find((command) => command.type === 'PLACE_ROAD');
      if (!pick) throw new Error('No setup command');
      if (pick.type === 'PLACE_SETUP_SHIP') ships++;
      state = submit(state, seat, pick);
    }
    expect(top(state)?.id).not.toBe('setup');
    const kinds = state.board.buildings.map((piece) => piece.kind);
    expect(kinds.filter((kind) => kind === 'city')).toHaveLength(3);
    expect(kinds.filter((kind) => kind === 'settlement')).toHaveLength(3);
    expect(ships).toBeGreaterThan(0);
    for (const seat of [0, 1, 2] as const)
      expect(handOf(state, seat)).toMatchObject({ paper: 0, cloth: 0, coin: 0 });
    expect(engine.checkInvariants(state)).toEqual([]);
  });
});

/** A forest and hills with a fog hex between them; everything else is sea. */
function fogBoard(): BoardState {
  const land: HexSpec[] = [
    [0, 0, 'forest', 5],
    [2, 0, 'hills', 6],
    [1, 0, 'fog'],
  ];
  const taken = new Set(land.map(([q, r]) => hexId({ q, r })));
  const sea: HexSpec[] = [];
  for (let q = -2; q <= 3; q++)
    for (let r = -2; r <= 3; r++) if (!taken.has(hexId({ q, r }))) sea.push([q, r, 'sea']);
  return explicitBoard([...land, ...sea], 'h:0,0');
}

function draw(state: GameState, card: string): GameState {
  const pending = engine.getPending(state).find(isPublicDraw);
  if (!pending) throw new Error('No public draw');
  const result = engine.apply(state, publicDrawInput(pending, card));
  if (!result.ok) throw new Error(result.error.message);
  return result.value.state;
}

function fogGame(): GameState {
  const state = newGame({
    board: fogBoard(),
    seafaring: {
      pirateHex: 'h:3,3',
      setupAreas: null,
      islandBonus: null,
      fog: { terrains: { forest: 1 }, tokens: { '9': 1 } },
    },
  });
  const corner = vertexId({ q: 0, r: 0 }, 'N');
  return inMain(withBuildings(state, [{ vertex: corner, seat: 0 }]));
}

describe('fog', () => {
  test('a reveal pays the revealed land’s resource, not a commodity', () => {
    const state = withHand(fogGame(), 0, { brick: 1, lumber: 1 });
    // The forest's north-east edge: forest and sea, its east end touches the fog hex.
    const ne = 'e:0,0,NE';
    const built = submit(state, 0, { type: 'BUILD_ROAD', edge: ne });
    expect(seafaringExt(built).fog).toMatchObject({ hexes: ['h:1,0'] });
    const revealed = draw(draw(built, 'forest'), '9');
    expect(handOf(revealed, 0)).toMatchObject({ lumber: 1, paper: 0 });
    expect(engine.checkInvariants(revealed)).toEqual([]);
  });

  test('a knight placed next to fog reveals nothing', () => {
    const fogCorner = vertexId({ q: 0, r: 0 }, 'NE');
    let state = withRoads(fogGame(), 0, ['e:0,0,NE']);
    state = withHand(state, 0, { wool: 1, ore: 1 });
    const built = submit(state, 0, { type: 'BUILD_KNIGHT', vertex: fogCorner });
    expect(seafaringExt(built).fog).toBeNull();
    expect(top(built)?.id).toBe('main');
  });
});

describe('special build phase with five-six', () => {
  const large = seafarersKnightsEngine(true);

  test('ships, knights and walls may be built; ships and knights never move there', () => {
    let state = withBuildings(newGame({ seats: 5, fiveSix: true }, large), [
      { vertex: HOME, seat: 1, kind: 'city' },
    ]);
    state = withShips(state, 1, [S1, S2]);
    state = withKnights(state, [{ seat: 1, vertex: COAST }]);
    state = withHand(state, 1, { lumber: 2, wool: 3, ore: 3, grain: 2, brick: 2 });
    state = submit(inMain(state), 0, { type: 'END_TURN' }, large);
    expect(top(state)).toMatchObject({ id: 'sbp', module: 'five-six', data: { seat: 1 } });
    const types = new Set(large.getLegalCommands(state, 1).commands.map((command) => command.type));
    for (const type of ['BUILD_SHIP', 'BUILD_KNIGHT', 'PROMOTE_KNIGHT', 'BUILD_CITY_WALL'])
      expect({ type, legal: types.has(type) }).toEqual({ type, legal: true });
    for (const type of ['MOVE_SHIP', 'MOVE_KNIGHT', 'CHASE_ROBBER', 'MARITIME_TRADE'])
      expect({ type, legal: types.has(type) }).toEqual({ type, legal: false });
  });
});
