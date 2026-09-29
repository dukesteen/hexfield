import { describe, expect, test } from 'vitest';
import { knightsConfig, knightsEngine, knightsExt, knightsModule } from '@cp2p/engine';
import type { CommandShape, GameState } from '@cp2p/engine';
import { victoryBreakdown } from '../game/stats';
import { firstPicks, isForcedKind, isTwoStepKind, secondPicks, targetOfKind } from './board-modes';
import { KNIGHT_COST_TABLE, costOfKind } from './costs';
import { improvableTracks } from './improve';
import { improvementCostOf } from './improvement-cost';
import { CARD_KINDS, KIND_INFO, KNIGHTS_PLACEMENT_KINDS, knightsPlacements } from './placements';
import { knightLevel, knightsVictoryPoints } from './state';

const engine = knightsEngine();
const genesis = engine.createGame(knightsConfig({ seats: 3 }), new Uint8Array(32).fill(4));

/** The state with the knights extension changed, for what a play would have left behind. */
function withKnights(change: Record<string, unknown>): GameState {
  const ext = { ...knightsExt(genesis), ...change };
  return { ...genesis, ext: { ...genesis.ext, knights: ext } };
}

describe('the cost table', () => {
  test('is the same as the prices the engine charges', () => {
    const costs = knightsModule().hooks?.costs?.(genesis.config, {}) ?? {};
    expect(KNIGHT_COST_TABLE.knight).toEqual(costs['knight']);
    expect(KNIGHT_COST_TABLE.promote).toEqual(costs['promote']);
    expect(KNIGHT_COST_TABLE.activate).toEqual(costs['activate']);
    expect(KNIGHT_COST_TABLE.cityWall).toEqual(costs['cityWall']);
  });

  test('names a price for each purchase and none for the rest', () => {
    expect(costOfKind('knight')).toEqual({ wool: 1, ore: 1 });
    expect(costOfKind('wall')).toEqual({ brick: 2 });
    expect(costOfKind('chase')).toBeNull();
  });

  test('the first level of a track costs one of its commodity', () => {
    expect(improvementCostOf(genesis, 0, 'science')).toBe(1);
    expect(improvementCostOf(genesis, 0, 'trade')).toBe(1);
  });
});

describe('placements', () => {
  test('a command maps to the board tap of its kind', () => {
    expect(knightsPlacements({ type: 'BUILD_KNIGHT', vertex: 'v:0,0,N' })).toEqual([
      { kind: 'knight', id: 'v:0,0,N' },
    ]);
    expect(knightsPlacements({ type: 'MOVE_KNIGHT', from: 'a', to: 'b' })).toEqual([
      { kind: 'moveKnight', id: 'b', from: 'a' },
    ]);
    expect(knightsPlacements({ type: 'END_TURN' })).toEqual([]);
  });

  test('a card that swaps two things can be picked in either order', () => {
    const command: CommandShape = {
      type: 'PLAY_PROGRESS_CARD',
      card: 'inventor',
      params: { hexes: ['h:0,0', 'h:1,0'] },
    };
    expect(knightsPlacements(command)).toEqual([
      { kind: 'cardInventor', id: 'h:1,0', from: 'h:0,0' },
      { kind: 'cardInventor', id: 'h:0,0', from: 'h:1,0' },
    ]);
  });

  test('a card that stops after one pick finishes at it', () => {
    const [pick] = knightsPlacements({
      type: 'PLAY_PROGRESS_CARD',
      card: 'smith',
      params: { vertices: ['v:0,0,N'] },
    });
    expect(pick).toMatchObject({ kind: 'cardSmith', from: 'v:0,0,N', finish: true });
  });

  test('every kind has a target, and every card kind is one of them', () => {
    for (const kind of KNIGHTS_PLACEMENT_KINDS) expect(targetOfKind(kind)).not.toBeNull();
    for (const kind of Object.values(CARD_KINDS)) expect(KIND_INFO[kind]).toBeDefined();
  });

  test('the choices the game asks for hold everything else up', () => {
    for (const kind of ['relocate', 'pillage', 'metropolis', 'deserterRemove'] as const)
      expect(isForcedKind(kind)).toBe(true);
    expect(isForcedKind('knight')).toBe(false);
    expect(isTwoStepKind('moveKnight')).toBe(true);
    expect(isTwoStepKind('knight')).toBe(false);
  });
});

describe('two-pick modes', () => {
  const choices = [
    { id: 'b', type: 'vertex', from: 'a', command: { type: 'MOVE_KNIGHT' } },
    { id: 'c', type: 'vertex', from: 'a', command: { type: 'MOVE_KNIGHT' } },
    { id: 'z', type: 'vertex', from: 'y', command: { type: 'MOVE_KNIGHT' } },
    { id: 'y', type: 'vertex', from: 'y', command: { type: 'DONE' }, finish: true },
  ] as const;

  test('the first picks list each thing that can be picked first once', () => {
    expect(firstPicks(choices).map((pick) => pick.id)).toEqual(['a', 'y']);
  });

  test('the second picks are what follows the first, and the finish if it has one', () => {
    expect(secondPicks(choices, 'a').targets.map((pick) => pick.id)).toEqual(['b', 'c']);
    expect(secondPicks(choices, 'a').finish).toBeUndefined();
    expect(secondPicks(choices, 'y').finish?.command.type).toBe('DONE');
  });
});

describe('improvements', () => {
  test('the tracks that may be bought are read off the legal commands', () => {
    const commands: CommandShape[] = [
      { type: 'BUILD_IMPROVEMENT', track: 'science' },
      { type: 'BUILD_IMPROVEMENT', track: 'trade' },
      { type: 'END_TURN' },
    ];
    expect(improvableTracks(commands)).toEqual(['trade', 'science']);
  });
});

describe('knights points', () => {
  test('a metropolis is two points and a defender card one', () => {
    const state = withKnights({
      metropolises: { trade: { seat: 1, vertex: 'v:0,0,N' } },
      defenders: { 1: 2 },
    });
    expect(knightsVictoryPoints(state, 1)).toBe(4);
    expect(knightsVictoryPoints(state, 0)).toBe(0);
    expect(victoryBreakdown(state, 1, 0)).toMatchObject({ knights: 4, total: 4 });
  });

  test('the merchant and shown Printer or Constitution cards count as the engine counts them', () => {
    const base = withKnights({ merchant: { seat: 2, hex: genesis.board.hexes[0]?.id ?? '' } });
    const state: GameState = {
      ...base,
      seats: base.seats.map((seat) =>
        seat.seat === 2
          ? {
              ...seat,
              cardSlots: [
                {
                  slotId: 'progress:1',
                  deck: 'progress-science',
                  acquiredTurn: 1,
                  revealed: 'printer',
                },
                {
                  slotId: 'progress:2',
                  deck: 'progress-trade',
                  acquiredTurn: 1,
                  revealed: 'merchant',
                },
              ],
            }
          : seat,
      ),
    };
    expect(knightsVictoryPoints(state, 2)).toBe(2);
    const engineTotal = engine.hooks
      .victoryPoints(state, 2, undefined, [])
      .reduce((sum, item) => sum + item.points, 0);
    expect(knightsVictoryPoints(state, 2)).toBe(engineTotal);
  });

  test('the breakdown of a game with none has no knights row', () => {
    expect(victoryBreakdown(genesis, 0, 0)).not.toHaveProperty('knights');
  });

  test('a knight strength maps onto the three art levels', () => {
    expect([0, 1, 2, 3, 4].map(knightLevel)).toEqual([1, 1, 2, 3, 3]);
  });
});
