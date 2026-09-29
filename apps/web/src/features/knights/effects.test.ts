import { describe, expect, test } from 'vitest';
import { createBaseEngine, knightsExt } from '@cp2p/engine';
import type { AttackReport, GameEvent, GameState, KnightPiece, Seat } from '@cp2p/engine';
import { DICE_SETTLE_MS } from '@cp2p/renderer';
import { deriveKnightsEffects } from './effects';
import { genesis } from './test-support';

function change(
  state: GameState,
  patch: {
    step?: number;
    knights?: KnightPiece[];
    lastAttack?: AttackReport | null;
  },
): GameState {
  const ext = knightsExt(state);
  return {
    ...state,
    ext: {
      ...state.ext,
      knights: {
        ...ext,
        ...(patch.step === undefined ? {} : { barbarians: { step: patch.step } }),
        ...(patch.knights === undefined ? {} : { knights: patch.knights }),
        ...(patch.lastAttack === undefined ? {} : { lastAttack: patch.lastAttack }),
      },
    },
  };
}

const knight = (vertex: string, level: number, active: boolean, seat: Seat = 0): KnightPiece => ({
  seat,
  vertex,
  level,
  active,
  ready: active,
  promotedTurn: null,
});

const report = (outcome: AttackReport['outcome'], pillaged: string[] = []): AttackReport => ({
  turn: 9,
  strength: 3,
  defense: 1,
  contributions: [1, 0, 0],
  outcome,
  defender: null,
  tied: [],
  pillaged: pillaged.map((vertex) => ({ seat: 1, vertex, sideways: false })),
});

describe('the barbarian ship', () => {
  test('a step forward sails the ship from the old step to the new one', () => {
    const effects = deriveKnightsEffects(genesis, change(genesis, { step: 1 }), [], 12);
    expect(effects).toEqual([
      {
        id: '12:barbarian-sail',
        kind: 'barbarian-sail',
        fixture: 'barbarian-track',
        fromStep: 0,
        toStep: 1,
      },
    ]);
  });

  test('the ship waits for the dice when the update carries a roll', () => {
    const rolled: GameEvent = { type: 'diceRolled', dice: [3, 4] };
    const [effect] = deriveKnightsEffects(genesis, change(genesis, { step: 1 }), [rolled], 3);
    expect(effect).toMatchObject({ kind: 'barbarian-sail', delayMs: DICE_SETTLE_MS });
  });

  test('the landing is derived from the step falling back, with who held and what fell', () => {
    const before = change(genesis, {
      step: 6,
      knights: [
        knight('v:0,0,N', 2, true),
        knight('v:1,0,N', 1, false),
        knight('not-a-vertex', 3, true),
      ],
    });
    const held = change(before, { step: 0, lastAttack: report('defended') });
    const [defended] = deriveKnightsEffects(before, held, [], 20);
    expect(defended).toMatchObject({
      id: '20:barbarian-attack',
      kind: 'barbarian-attack',
      fromStep: 6,
      outcome: 'defended',
      // Only active knights on real vertices are shown holding the line.
      defenders: ['v:0,0,N'],
      pillaged: [],
    });
    const lost = change(before, {
      step: 0,
      lastAttack: report('pillaged', ['v:2,0,S', 'bad']),
    });
    const [pillaged] = deriveKnightsEffects(before, lost, [], 21);
    expect(pillaged).toMatchObject({ outcome: 'pillaged', pillaged: ['v:2,0,S'] });
  });

  test('a step back with no attack report shows nothing, and neither does a still ship', () => {
    const before = change(genesis, { step: 4 });
    expect(deriveKnightsEffects(before, change(before, { step: 0 }), [], 1)).toEqual([]);
    expect(deriveKnightsEffects(before, before, [], 2)).toEqual([]);
  });

  test('a board without the track has no ship to sail', () => {
    const bare: GameState = { ...genesis, board: { ...genesis.board, fixtures: [] } };
    expect(deriveKnightsEffects(bare, change(bare, { step: 2 }), [], 1)).toEqual([]);
  });
});

describe('pieces arriving and moving', () => {
  const after = change(genesis, {
    knights: [knight('v:0,0,N', 3, true, 1), knight('v:1,0,N', 2, true, 0)],
  });

  test('a recruited or promoted knight pops in at its vertex with its level', () => {
    const built: GameEvent = { type: 'knightBuilt', seat: 1, vertex: 'v:0,0,N' };
    const promoted: GameEvent = { type: 'knightPromoted', seat: 1, vertex: 'v:0,0,N', level: 3 };
    expect(deriveKnightsEffects(genesis, after, [built, promoted], 5)).toEqual([
      {
        id: '5:knights:0',
        kind: 'piece-pop',
        piece: 'knight',
        seat: 1,
        at: { kind: 'vertex', id: 'v:0,0,N' },
        level: 1,
      },
      {
        id: '5:knights:1',
        kind: 'piece-pop',
        piece: 'knight',
        seat: 1,
        at: { kind: 'vertex', id: 'v:0,0,N' },
        level: 3,
      },
    ]);
  });

  test('a city wall pops in under the city', () => {
    const wall: GameEvent = { type: 'cityWallBuilt', seat: 0, vertex: 'v:1,0,S' };
    expect(deriveKnightsEffects(genesis, after, [wall], 6)).toMatchObject([
      { kind: 'piece-pop', piece: 'wall', seat: 0, at: { kind: 'vertex', id: 'v:1,0,S' } },
    ]);
  });

  test('a moved, displaced or relocated knight glides, at the strength it has now', () => {
    const moved: GameEvent = {
      type: 'knightMoved',
      seat: 0,
      from: 'v:0,1,N',
      to: 'v:1,0,N',
    };
    const relocated: GameEvent = { ...moved, type: 'knightRelocated' };
    const effects = deriveKnightsEffects(genesis, after, [moved, relocated], 7);
    expect(effects).toHaveLength(2);
    expect(effects[0]).toEqual({
      id: '7:knights:0',
      kind: 'knight-move',
      seat: 0,
      level: 2,
      fromVertex: 'v:0,1,N',
      toVertex: 'v:1,0,N',
    });
  });

  test('a pillaged city burns', () => {
    const burned: GameEvent = { type: 'cityPillaged', seat: 2, vertex: 'v:2,1,N' };
    expect(deriveKnightsEffects(genesis, after, [burned], 8)).toEqual([
      { id: '8:knights:0', kind: 'burst', at: 'v:2,1,N', tone: 'fire' },
    ]);
  });

  test('events with a bad seat or vertex, and events of other modules, make no motion', () => {
    const events: GameEvent[] = [
      { type: 'knightBuilt', seat: 9, vertex: 'v:0,0,N' },
      { type: 'knightBuilt', seat: 0, vertex: 'nowhere' },
      { type: 'cityWallBuilt', seat: 0 },
      { type: 'roadBuilt', seat: 0, edge: 'e:0,0,W' },
    ];
    expect(deriveKnightsEffects(genesis, after, events, 9)).toEqual([]);
  });

  test('a game without knights derives nothing', () => {
    const base = createBaseEngine().createGame(
      { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1], options: {} },
      new Uint8Array(32),
    );
    const built: GameEvent = { type: 'knightBuilt', seat: 0, vertex: 'v:0,0,N' };
    expect(deriveKnightsEffects(base, base, [built], 1)).toEqual([]);
  });
});
