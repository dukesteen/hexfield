import { describe, expect, test } from 'vitest';
import { hexId } from '../../core/geometry/index.js';
import { isPublicDraw, publicDrawInput } from '../../core/pipeline/index.js';
import type { Pending } from '../../core/pipeline/index.js';
import type { BoardState, GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { boardIslands } from '../base/board/index.js';
import { FOG_REVEALED, FOG_TERRAIN_DECK, FOG_TOKEN_DECK, seafaringExt } from './index.js';
import type { FogOption } from './index.js';
import { explicitBoard, seafaringConfig, seafaringEngine } from './testing.js';
import type { HexSpec } from './testing.js';
import {
  edgeId,
  inMain,
  rejection,
  submit,
  vertexId,
  withBuildings,
  withHand,
  withShips,
} from './support.js';

const engine = seafaringEngine();
const X = { q: 0, r: 0 };
const F1 = 'h:1,0';
const F2 = 'h:0,1';
/** Corner NE of the forest: shared with the fog hex F1 and the sea hex to the north-east. */
const CORNER_NE = vertexId(X, 'NE');
const CORNER_N = vertexId(X, 'N');
/** The forest's east edge: forest and fog. A road may go there, a ship may not. */
const EDGE_E = edgeId(X, 'E');
/** The forest's north-east edge: forest and sea, one end at the fog hex F1. */
const EDGE_NE = edgeId(X, 'NE');
/** Open water north of the forest, sea on both sides. */
const EDGE_SEA = edgeId({ q: 0, r: -1 }, 'E');

/**
 * A forest (h:0,0) and hills (h:2,0) with two fog hexes: F1 east of the forest, between the two
 * lands, and F2 to the forest's south-east. Everything else is sea.
 */
function fogBoard(): BoardState {
  const land: HexSpec[] = [
    [0, 0, 'forest', 5],
    [2, 0, 'hills', 6],
    [1, 0, 'fog'],
    [0, 1, 'fog'],
  ];
  const taken = new Set(land.map(([q, r]) => hexId({ q, r })));
  const sea: HexSpec[] = [];
  for (let q = -2; q <= 3; q++)
    for (let r = -2; r <= 3; r++) if (!taken.has(hexId({ q, r }))) sea.push([q, r, 'sea']);
  return explicitBoard([...land, ...sea], 'h:0,0');
}

const DEFAULT_FOG: FogOption = { terrains: { forest: 1, sea: 1 }, tokens: { '9': 1 } };

function fogGame(fog: FogOption = DEFAULT_FOG): GameState {
  const state = engine.createGame(
    seafaringConfig({
      board: fogBoard(),
      seafaring: { pirateHex: 'h:3,3', setupAreas: null, islandBonus: null, fog },
    }),
    new Uint8Array(32),
  );
  return withHand(inMain(state), 0, { brick: 1, lumber: 1, wool: 1 });
}

/** A seat-0 settlement at the fog corner, ready to build. */
function ready(fog?: FogOption): GameState {
  return withBuildings(fogGame(fog), [{ vertex: CORNER_NE, seat: 0 }]);
}

function pendingDraw(state: GameState): Extract<Pending, { kind: 'random' }> {
  const pending = engine.getPending(state);
  const draws = pending.filter(isPublicDraw);
  const [only] = draws;
  // Nothing else is pending but the active seat's hidden victory claim, as in any interrupt.
  const others = pending.filter((item) => !isPublicDraw(item));
  if (
    draws.length !== 1 ||
    !only ||
    others.some((item) => item.kind !== 'player' || item.allowed.join() !== 'CLAIM_VICTORY')
  )
    throw new Error(`Expected one public draw, got ${JSON.stringify(pending)}`);
  return only;
}

/** Answer the pending public draw with the given card. */
function draw(state: GameState, card: string): GameState {
  const result = engine.apply(state, publicDrawInput(pendingDraw(state), card));
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(engine.checkInvariants(result.value.state)).toEqual([]);
  return result.value.state;
}

const terrainOf = (state: GameState, hex: string) =>
  state.board.hexes.find((item) => item.id === hex);

describe('fog reveals', () => {
  test('genesis declares two public decks from the scenario counts', () => {
    const state = fogGame();
    expect(state.decks[FOG_TERRAIN_DECK]).toEqual({ remaining: 2, drawn: [] });
    expect(state.decks[FOG_TOKEN_DECK]).toEqual({ remaining: 1, drawn: [] });
    expect(seafaringExt(state).fog).toBeNull();
    expect(engine.getPending(state)).toContainEqual(
      expect.objectContaining({ kind: 'player', seat: 0 }),
    );
    // Games without fog neither declare the decks nor carry the field.
    const plain = engine.createGame(seafaringConfig(), new Uint8Array(32));
    expect(Object.keys(plain.decks)).toEqual(['dev']);
    expect('fog' in seafaringExt(plain)).toBe(false);
  });

  test('a ship beside a fog hex reveals it: terrain first, then its token, then the reward', () => {
    let state = submit(engine, ready(), 0, { type: 'BUILD_SHIP', edge: EDGE_NE });
    // The draw sits in its own frame above the interrupted phase.
    expect(state.turn.phase.map((frame) => frame.id)).toEqual(['main', 'fogReveal']);
    expect(seafaringExt(state).fog).toEqual({ seat: 0, hexes: [F1], terrain: null });
    // Only the draw is pending, and no seat can act until it is answered.
    expect(pendingDraw(state).request).toEqual({
      type: 'draw',
      deck: FOG_TERRAIN_DECK,
      public: true,
      seat: 0,
      slotId: `${FOG_TERRAIN_DECK}:0`,
      remaining: 2,
      hex: F1,
    });
    expect(pendingDraw(state).systemType).toBe(FOG_REVEALED);
    // Only the hidden victory claim stays available, as in every interrupt.
    expect(engine.getLegalCommands(state, 0)).toEqual({
      commands: [],
      templates: [{ type: 'CLAIM_VICTORY', slotIds: 'owned VP slots' }],
    });
    expect(rejection(engine, state, 0, { type: 'END_TURN' })).toBe('not-pending');
    expect(rejection(engine, state, 0, { type: 'BUILD_SHIP', edge: EDGE_SEA })).toBe('not-pending');
    state = draw(state, 'forest');
    // The hex stays fog until the token is drawn as well.
    expect(terrainOf(state, F1)).toMatchObject({ terrain: 'fog', token: null });
    expect(seafaringExt(state).fog).toEqual({ seat: 0, hexes: [F1], terrain: 'forest' });
    expect(pendingDraw(state).request).toMatchObject({
      deck: FOG_TOKEN_DECK,
      slotId: `${FOG_TOKEN_DECK}:0`,
      remaining: 1,
      hex: F1,
    });
    const before = state.seats[0]?.resources.total ?? 0;
    const bankBefore = state.bank.lumber ?? 0;
    state = draw(state, '9');
    expect(terrainOf(state, F1)).toMatchObject({ terrain: 'forest', token: 9 });
    expect(seafaringExt(state).fog).toBeNull();
    expect(state.seats[0]?.resources.total).toBe(before + 1);
    expect(state.seats[0]?.resources.min.lumber).toBe(1);
    expect(state.bank.lumber).toBe(bankBefore - 1);
    expect(state.decks[FOG_TERRAIN_DECK]).toEqual({
      remaining: 1,
      drawn: [{ slotId: `${FOG_TERRAIN_DECK}:0`, seat: 0 }],
    });
    // The frame closes and the interrupted phase resumes unchanged.
    expect(state.turn.phase.map((frame) => frame.id)).toEqual(['main']);
    expect(engine.getPending(state)).toContainEqual(
      expect.objectContaining({ kind: 'player', seat: 0 }),
    );
  });

  test('a road reveals every fog hex at either end of its edge, in ascending hex id order', () => {
    let state = submit(engine, ready(), 0, { type: 'BUILD_ROAD', edge: EDGE_E });
    expect(seafaringExt(state).fog).toEqual({ seat: 0, hexes: [F2, F1], terrain: null });
    expect(pendingDraw(state).request).toMatchObject({ hex: F2 });
    state = draw(state, 'sea');
    // A sea tile takes no token: the first hex is done, the next draw is for the second hex.
    expect(terrainOf(state, F2)).toMatchObject({ terrain: 'sea', token: null });
    expect(pendingDraw(state).request).toMatchObject({ deck: FOG_TERRAIN_DECK, hex: F1 });
    expect(seafaringExt(state).fog).toEqual({ seat: 0, hexes: [F1], terrain: null });
    state = draw(state, 'forest');
    state = draw(state, '9');
    expect(terrainOf(state, F1)).toMatchObject({ terrain: 'forest', token: 9 });
    expect(state.decks[FOG_TERRAIN_DECK]?.remaining).toBe(0);
    expect(state.decks[FOG_TOKEN_DECK]?.remaining).toBe(0);
    expect(state.turn.phase.map((frame) => frame.id)).toEqual(['main']);
  });

  test('a placement that touches no fog hex, and a settlement or city, reveal nothing', () => {
    const north = withBuildings(fogGame(), [{ vertex: CORNER_N, seat: 0 }]);
    const quiet = submit(engine, north, 0, { type: 'BUILD_SHIP', edge: EDGE_SEA });
    expect(seafaringExt(quiet).fog).toBeNull();
    expect(engine.getPending(quiet)[0]?.kind).toBe('player');
    // Settlements and cities are not reveal triggers, even at a fog corner.
    for (const type of ['settlement', 'city'])
      expect(engine.hooks.afterBuild(fogGame(), 0, type, CORNER_NE)).toEqual(fogGame());
  });

  test('moving a ship next to a fog hex reveals it', () => {
    // A settlement at the forest's north corner, and a ship on open water from it.
    const base = withShips(withBuildings(fogGame(), [{ vertex: CORNER_N, seat: 0 }]), 0, [
      EDGE_SEA,
    ]);
    let state = submit(engine, base, 0, { type: 'MOVE_SHIP', from: EDGE_SEA, to: EDGE_NE });
    expect(state.board.ships).toEqual([{ edge: EDGE_NE, seat: 0 }]);
    expect(seafaringExt(state).fog).toEqual({ seat: 0, hexes: [F1], terrain: null });
    state = draw(state, 'forest');
    state = draw(state, '9');
    expect(terrainOf(state, F1)).toMatchObject({ terrain: 'forest', token: 9 });
    // The move itself was spent, and the reveal paid the mover.
    expect(seafaringExt(state).shipMovedTurn).toBe(state.turn.number);
    expect(state.seats[0]?.resources.min.lumber).toBe(2);
  });

  test('a setup road reveals, and setup then continues with the next placement', () => {
    let state = engine.createGame(
      seafaringConfig({
        seats: 2,
        board: fogBoard(),
        seafaring: { pirateHex: 'h:3,3', setupAreas: null, islandBonus: null, fog: DEFAULT_FOG },
      }),
      new Uint8Array(32),
    );
    const started = engine.apply(state, { kind: 'system', type: 'START_SEAT', seat: 0 });
    if (!started.ok) throw new Error(started.error.message);
    state = started.value.state;
    state = submit(engine, state, 0, { type: 'PLACE_SETTLEMENT', vertex: CORNER_NE });
    expect(seafaringExt(state).fog).toBeNull();
    state = submit(engine, state, 0, { type: 'PLACE_ROAD', edge: EDGE_E });
    expect(seafaringExt(state).fog?.hexes).toEqual([F2, F1]);
    // Seat 1 is already the active seat behind the draw, and cannot act until it is answered.
    expect(state.turn.activeSeat).toBe(1);
    expect(pendingDraw(state).request).toMatchObject({ seat: 0, hex: F2 });
    state = draw(state, 'sea');
    state = draw(state, 'forest');
    state = draw(state, '9');
    expect(state.turn.phase.at(-1)?.id).toBe('setup');
    expect(engine.getPending(state)).toContainEqual(
      expect.objectContaining({ kind: 'player', seat: 1 }),
    );
    // The revealed forest paid seat 0 one lumber during setup.
    expect(state.seats[0]?.resources.min.lumber).toBe(1);
  });

  test('a free road or ship from Road Building reveals, then the card resumes', () => {
    let state = ready();
    state = {
      ...state,
      turn: {
        ...state.turn,
        phase: [
          ...state.turn.phase.slice(0, -1),
          { id: 'roadBuilding', module: 'base', data: { remaining: 2 } },
        ],
      },
    };
    state = submit(engine, state, 0, { type: 'PLACE_FREE_SHIP', edge: EDGE_NE });
    expect(seafaringExt(state).fog?.hexes).toEqual([F1]);
    state = draw(draw(state, 'forest'), '9');
    expect(state.turn.phase.at(-1)).toMatchObject({ id: 'roadBuilding', data: { remaining: 1 } });
    expect(engine.getPending(state)[0]?.kind).toBe('player');
  });

  test('a desert tile pays nothing and takes no token', () => {
    let state = submit(engine, ready({ terrains: { desert: 1, sea: 1 }, tokens: {} }), 0, {
      type: 'BUILD_SHIP',
      edge: EDGE_NE,
    });
    const total = state.seats[0]?.resources.total ?? 0;
    state = draw(state, 'desert');
    expect(terrainOf(state, F1)).toMatchObject({ terrain: 'desert', token: null });
    expect(state.seats[0]?.resources.total).toBe(total);
    expect(seafaringExt(state).fog).toBeNull();
    // Desert is land, so it joins the forest and the hills into one island.
    expect(boardIslands(state)).toHaveLength(1);
  });

  test('a gold tile pays one card of the revealer’s choice through the gold choice', () => {
    let state = submit(engine, ready({ terrains: { gold: 1, sea: 1 }, tokens: { '4': 1 } }), 0, {
      type: 'BUILD_ROAD',
      edge: EDGE_E,
    });
    state = draw(state, 'sea');
    state = draw(draw(state, 'gold'), '4');
    expect(terrainOf(state, F1)).toMatchObject({ terrain: 'gold', token: 4 });
    expect(state.turn.phase.map((frame) => frame.id)).toEqual(['main', 'goldChoice']);
    expect(state.turn.phase.at(-1)?.data).toEqual({ queue: [{ seat: 0, claim: 1 }] });
    expect(engine.getPending(state)).toContainEqual(
      expect.objectContaining({ kind: 'player', seat: 0 }),
    );
    expect(rejection(engine, state, 0, { type: 'CHOOSE_GOLD', resources: { ore: 2 } })).toBe(
      'invalid-gold-choice',
    );
    state = submit(engine, state, 0, { type: 'CHOOSE_GOLD', resources: { ore: 1 } });
    expect(state.seats[0]?.resources.min.ore).toBe(1);
    expect(state.turn.phase.map((frame) => frame.id)).toEqual(['main']);
  });

  test('the next queued draw waits for a pending gold choice', () => {
    // Both hexes are revealed by the road; the first (F2) is gold, the second forest.
    let state = submit(
      engine,
      ready({ terrains: { gold: 1, forest: 1 }, tokens: { '4': 1, '9': 1 } }),
      0,
      { type: 'BUILD_ROAD', edge: EDGE_E },
    );
    state = draw(draw(state, 'gold'), '4');
    expect(terrainOf(state, F2)).toMatchObject({ terrain: 'gold' });
    // The gold choice sits above the fog frame, which still holds the second hex.
    expect(state.turn.phase.map((frame) => frame.id)).toEqual(['main', 'fogReveal', 'goldChoice']);
    state = submit(engine, state, 0, { type: 'CHOOSE_GOLD', resources: { grain: 1 } });
    expect(pendingDraw(state).request).toMatchObject({ deck: FOG_TERRAIN_DECK, hex: F1 });
    state = draw(draw(state, 'forest'), '9');
    expect(terrainOf(state, F1)).toMatchObject({ terrain: 'forest', token: 9 });
    expect(state.seats[0]?.resources.min.grain).toBe(1);
    expect(state.seats[0]?.resources.min.lumber).toBe(1);
  });

  test('an empty bank pays nothing, for a resource tile and for gold', () => {
    // Seat 1 holds whatever the bank would have paid. A build refills the bank, so the gold case
    // uses a free ship move.
    let state = submit(
      engine,
      withHand(ready({ terrains: { hills: 1, sea: 1 }, tokens: { '9': 1 } }), 1, { brick: 18 }),
      0,
      { type: 'BUILD_SHIP', edge: EDGE_NE },
    );
    expect(state.bank.brick).toBe(0);
    const total = state.seats[0]?.resources.total ?? 0;
    state = draw(draw(state, 'hills'), '9');
    expect(terrainOf(state, F1)).toMatchObject({ terrain: 'hills', token: 9 });
    expect(state.seats[0]?.resources.total).toBe(total);
    const drained = withHand(
      withHand(fogGame({ terrains: { gold: 1, sea: 1 }, tokens: { '4': 1 } }), 0, {}),
      1,
      {
        brick: 19,
        lumber: 19,
        wool: 19,
        grain: 19,
        ore: 19,
      },
    );
    let gold = submit(
      engine,
      withShips(withBuildings(drained, [{ vertex: CORNER_N, seat: 0 }]), 0, [EDGE_SEA]),
      0,
      { type: 'MOVE_SHIP', from: EDGE_SEA, to: EDGE_NE },
    );
    gold = draw(draw(gold, 'gold'), '4');
    expect(gold.turn.phase.map((frame) => frame.id)).toEqual(['main']);
    expect(terrainOf(gold, F1)).toMatchObject({ terrain: 'gold', token: 4 });
    expect(gold.seats[0]?.resources.total).toBe(0);
  });

  test('a reveal recomputes the islands', () => {
    let state = submit(engine, ready(), 0, { type: 'BUILD_SHIP', edge: EDGE_NE });
    expect(boardIslands(state).map((island) => island.hexes)).toEqual([['h:0,0'], ['h:2,0']]);
    state = draw(draw(state, 'forest'), '9');
    expect(boardIslands(state).map((island) => island.hexes)).toEqual([
      ['h:0,0', 'h:1,0', 'h:2,0'],
    ]);
    // Revealed sea leaves them apart.
    const sea = draw(
      submit(engine, ready({ terrains: { forest: 1, sea: 1 }, tokens: { '9': 1 } }), 0, {
        type: 'BUILD_SHIP',
        edge: EDGE_NE,
      }),
      'sea',
    );
    expect(boardIslands(sea)).toHaveLength(2);
  });

  test('the answer must match the pending draw', () => {
    const state = submit(engine, ready(), 0, { type: 'BUILD_SHIP', edge: EDGE_NE });
    const good = publicDrawInput(pendingDraw(state), 'forest');
    const reject = (input: Record<string, unknown>) => {
      const result = engine.validate(state, { ...good, ...input });
      return result.ok ? null : result.error.code;
    };
    expect(reject({})).toBeNull();
    expect(reject({ card: 'gold' })).toBe('fog-card');
    expect(reject({ card: 'mountains' })).toBe('fog-card');
    expect(reject({ hex: F2 })).toBe('fog-mismatch');
    expect(reject({ seat: 1 })).toBe('fog-mismatch');
    expect(reject({ deck: FOG_TOKEN_DECK, card: '9' })).toBe('fog-mismatch');
    expect(reject({ slotId: 'fog-terrain:1' })).toBe('fog-mismatch');
    expect(reject({ remaining: 1 })).toBe('fog-mismatch');
    // With nothing to reveal the input answers no pending request.
    expect(engine.validate(ready(), good).ok).toBe(false);
  });

  test('the revealer’s private hand receives the card', () => {
    let state = submit(engine, ready(), 0, { type: 'BUILD_SHIP', edge: EDGE_NE });
    let privates = new Map(
      state.config.seats.map((seat) => [seat, engine.createPrivateState(seat)] as const),
    );
    const total = (seat: Seat) =>
      Object.values(privates.get(seat)?.hand ?? {}).reduce((sum, count) => sum + count, 0);
    for (const card of ['forest', '9']) {
      const input = publicDrawInput(pendingDraw(state), card);
      const next = engine.apply(state, input);
      const updated = engine.applyAllPrivates(privates, state, input);
      if (!next.ok || !updated.ok) throw new Error('apply failed');
      state = next.value.state;
      privates = updated.value;
    }
    expect(privates.get(0)?.hand.lumber).toBe(1);
    expect(total(1)).toBe(0);
  });
});
