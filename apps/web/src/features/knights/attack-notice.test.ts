import { beforeAll, describe, expect, test } from 'vitest';
import type { TFunction } from 'i18next';
import { knightsExt } from '@cp2p/engine';
import type { AttackReport, GameState, Seat } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { attackNotice, placeOf } from './attack-notice';
import { genesis, testI18n, withFrame } from './test-support';

let t: TFunction;
beforeAll(async () => {
  const i18n = await testI18n();
  t = i18n.getFixedT('en');
});

const name = (seat: Seat) => ['Ada', 'Bo', 'Cy'][seat] ?? '?';

/** Land vertices far enough apart to hold a city each. */
const graph = buildBoardGraph(genesis.board.hexes);
const land = new Set(
  genesis.board.hexes.filter((hex) => hex.terrain !== 'sea').map((hex) => hex.id),
);
const spots = graph.vertexIds.filter((vertex, index) =>
  (graph.vertexHexes[index] ?? []).every((hex) => land.has(hex)),
);
const [cityA = '', cityB = '', cityC = ''] = [spots[0], spots[10], spots[20]];

function attackState(
  report: Partial<AttackReport>,
  buildings: { seat: Seat; vertex: string; kind: 'settlement' | 'city' }[] = [],
): GameState {
  const ext = knightsExt(genesis);
  return {
    ...genesis,
    board: { ...genesis.board, buildings },
    ext: {
      ...genesis.ext,
      knights: {
        ...ext,
        lastAttack: {
          turn: 9,
          strength: 3,
          defense: 1,
          contributions: [1, 0, 2],
          outcome: 'pillaged',
          defender: null,
          tied: [],
          pillaged: [],
          ...report,
        },
      },
    },
  };
}

const texts = (state: GameState, viewer: Seat | null) =>
  attackNotice(state, viewer, name, t)?.lines.map((line) => line.text) ?? [];

describe('the barbarian attack announcement', () => {
  test('says nothing before the first attack', () => {
    expect(attackNotice(genesis, 0, name, t)).toBeNull();
  });

  test('a defended attack names the defender, and tells the defender it is them', () => {
    const state = attackState({ outcome: 'defended', strength: 2, defense: 4, defender: 2 });
    const notice = attackNotice(state, 0, name, t);
    expect(notice).toMatchObject({
      outcome: 'defended',
      strength: 2,
      defense: 4,
      headline: 'The knights held the line.',
    });
    expect(notice?.contributions).toEqual([
      { seat: 0, name: 'Ada', level: 1 },
      { seat: 1, name: 'Bo', level: 0 },
      { seat: 2, name: 'Cy', level: 2 },
    ]);
    expect(texts(state, 0)[0]).toBe('Cy led the defense: +1 VP (Defender of Catan).');
    const mine = attackNotice(state, 2, name, t)?.lines[0];
    expect(mine).toEqual({
      text: 'You led the defense: +1 VP (Defender of Catan).',
      you: true,
    });
  });

  test('a tie names the tied players, and tells a tied viewer to draw', () => {
    const state = attackState({ outcome: 'defended', defense: 4, tied: [0, 2] });
    expect(texts(state, 1)).toContain('Ada, Cy tied for the lead: each draws a progress card.');
    expect(texts(state, 1).some((line) => line.startsWith('You tied'))).toBe(false);
    expect(texts(state, 0)).toContain('You tied for the lead: pick a deck to draw from.');
  });

  test('a pillaged viewer is told which city fell and why, and that it was their only one', () => {
    const state = attackState({ pillaged: [{ seat: 1, vertex: cityA, sideways: false }] }, [
      { seat: 1, vertex: cityA, kind: 'settlement' },
      { seat: 0, vertex: cityB, kind: 'city' },
    ]);
    const place = placeOf(state, cityA, t);
    expect(place).not.toBe('');
    const notice = attackNotice(state, 1, name, t);
    expect(notice?.headline).toBe('The barbarians won and pillaged.');
    expect(notice?.lost).toEqual([{ seat: 1, vertex: cityA }]);
    expect(notice?.lines.filter((line) => line.you).map((line) => line.text)).toEqual([
      `Your city by ${place} fell and is a settlement now. Your knights gave 0, the fewest (1 vs 3 in all).`,
      'It was your only city, so there was nothing to choose.',
    ]);
  });

  test('a seat that still has cities after its loss is not told it was its only one', () => {
    const state = attackState({ pillaged: [{ seat: 1, vertex: cityA, sideways: false }] }, [
      { seat: 1, vertex: cityA, kind: 'settlement' },
      { seat: 1, vertex: cityC, kind: 'city' },
    ]);
    expect(texts(state, 1).some((line) => line.includes('only city'))).toBe(false);
  });

  test('other players read who lost the city and the weakest defense', () => {
    const state = attackState({ pillaged: [{ seat: 1, vertex: cityA, sideways: false }] }, [
      { seat: 1, vertex: cityA, kind: 'settlement' },
    ]);
    const place = placeOf(state, cityA, t);
    expect(texts(state, 0)).toEqual([
      `Bo lost the city by ${place}.`,
      'The weakest defenders had 0 active knight levels.',
      'Every knight is inactive again.',
    ]);
    expect(texts(state, null)).toEqual(texts(state, 0));
  });

  test('a seat choosing its city is named, and the chooser is asked to choose', () => {
    const state = withFrame(attackState({}), 'pillage', { remaining: [1], roll: 8 });
    expect(texts(state, 0)).toContain('Bo is choosing which city to lose.');
    expect(texts(state, 1)).toContain(
      'Your knights gave 0, the fewest: choose which city you lose.',
    );
  });

  test('with nobody to pillage, it says so; the first attack frees the robber', () => {
    const state = attackState({});
    expect(texts(state, 0)).toContain('No player had a city the barbarians could take.');
    expect(attackNotice(state, 0, name, t, true)?.lines.at(-1)?.text).toBe(
      'The robber is now active.',
    );
  });
});
