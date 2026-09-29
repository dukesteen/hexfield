import { beforeAll, describe, expect, test } from 'vitest';
import type { TFunction } from 'i18next';
import { knightsExt } from '@cp2p/engine';
import type { AttackReport, GameEvent, GameState } from '@cp2p/engine';
import {
  KNIGHTS_ACTOR_EVENTS,
  derivedKnightsEvents,
  formatKnightsEvent,
  knightsEventArt,
} from './log';
import { genesis, testI18n } from './test-support';

let t: TFunction;
beforeAll(async () => {
  const i18n = await testI18n();
  t = i18n.getFixedT('en');
});

const name = (seat: number) => ['Ada', 'Bo', 'Cy'][seat] ?? '?';
const line = (event: GameEvent) => formatKnightsEvent(event, t, name);

describe('log lines', () => {
  test('improvements, metropolises and their theft read as sentences', () => {
    expect(line({ type: 'improvementBuilt', seat: 0, track: 'trade', level: 2 })).toBe(
      'Ada bought Trade level 2.',
    );
    expect(line({ type: 'metropolisPlaced', seat: 1, track: 'science' })).toBe(
      'Bo placed the Science metropolis.',
    );
    expect(line({ type: 'metropolisPlaced', seat: 1, track: 'science', from: 2 })).toBe(
      'Bo took the Science metropolis from Cy.',
    );
  });

  test('knights: recruited, promoted to a named level, displaced, deserted', () => {
    expect(line({ type: 'knightBuilt', seat: 0 })).toBe('Ada recruited a knight.');
    expect(line({ type: 'knightBuilt', seat: 0, deserted: true })).toBe(
      'Ada placed a knight taken from a deserter.',
    );
    expect(line({ type: 'knightPromoted', seat: 0, level: 3 })).toBe(
      'Ada promoted a knight to a mighty knight.',
    );
    // A level outside 1 to 3 is clamped rather than shown as a missing key.
    expect(line({ type: 'knightPromoted', seat: 0, level: 9 })).toContain('mighty');
    expect(line({ type: 'knightDisplaced', seat: 0, displaced: 1 })).toContain('Bo');
  });

  test('progress cards name the card, the deck and the counts', () => {
    expect(line({ type: 'progressCardPlayed', seat: 0, card: 'wedding' })).toContain('Wedding');
    expect(line({ type: 'cardDealt', seat: 1, deck: 'progress-science' })).toBe(
      'Bo drew a Science progress card.',
    );
    expect(line({ type: 'progressDiscarded', seat: 0, count: 1 })).toBe(
      'Ada discarded 1 progress card.',
    );
    expect(line({ type: 'progressDiscarded', seat: 0, count: 2 })).toBe(
      'Ada discarded 2 progress cards.',
    );
    expect(line({ type: 'weddingGift', seat: 1, to: 0, count: 2 })).toBe('Bo gave Ada 2 cards.');
    expect(line({ type: 'sabotageDiscard', seat: 2, count: 3 })).toBe(
      'Cy discarded 3 cards to the bank.',
    );
    expect(line({ type: 'diceSet', seat: 0, dice: [2, 5] })).toBe(
      'Ada set the production dice to 2 and 5.',
    );
  });

  test('commodities and resources are both named', () => {
    expect(line({ type: 'harvested', seat: 0, count: 2, resource: 'ore' })).toContain('Ore');
    expect(line({ type: 'monopolyPlayed', seat: 0, kind: 'coin' })).toContain('Coin');
    expect(line({ type: 'aqueductChosen', seat: 0, resource: 'grain' })).toContain('Grain');
  });

  test('a barbarian attack says who won, who led and what was lost', () => {
    expect(
      line({
        type: 'barbarianAttack',
        outcome: 'defended',
        strength: 3,
        defense: 5,
        defender: 1,
        tied: [1],
        pillaged: [],
      }),
    ).toBe(
      'The barbarians landed and were beaten back (5 against 3). Bo led the defense and takes a Defender of Catan card.',
    );
    expect(
      line({
        type: 'barbarianAttack',
        outcome: 'defended',
        strength: 2,
        defense: 2,
        defender: null,
        tied: [0, 1],
        pillaged: [],
      }),
    ).toContain('tied for the lead');
    expect(
      line({
        type: 'barbarianAttack',
        outcome: 'pillaged',
        strength: 4,
        defense: 1,
        defender: null,
        tied: [],
        pillaged: [{ seat: 2 }, { seat: 7 }],
      }),
    ).toBe('The barbarians landed and won (1 against 4). Cy lost a city to the barbarians.');
    expect(
      line({
        type: 'barbarianAttack',
        outcome: 'pillaged',
        strength: 2,
        defense: 0,
        defender: null,
        tied: [],
        pillaged: [{ seat: 2 }],
        robberFreed: true,
      }),
    ).toBe(
      'The barbarians landed and won (0 against 2). Cy lost a city to the barbarians. The robber is active from now on.',
    );
    expect(line({ type: 'barbarianSail', step: 4, steps: 7 })).toBe(
      'The barbarian ship sails: step 4 of 7.',
    );
  });

  test('a sideways city is said to lie on its side', () => {
    expect(line({ type: 'cityPillaged', seat: 0, sideways: true })).toContain('on its side');
    expect(line({ type: 'cityPillaged', seat: 0 })).not.toContain('side');
  });

  test('an event the module does not own, or one missing its data, has no line', () => {
    expect(line({ type: 'roadBuilt', seat: 0 })).toBeNull();
    expect(line({ type: 'improvementBuilt', seat: 0, track: 'nonsense', level: 1 })).toBeNull();
    expect(line({ type: 'progressCardPlayed', seat: 0 })).toBeNull();
  });

  test('every event that names an actor gets a line with that actor in it', () => {
    const samples: Record<string, Record<string, unknown>> = {
      knightActivated: {},
      knightMoved: {},
      cityWallBuilt: {},
      merchantPlaced: {},
      harborOpened: {},
      saboteurPlayed: {},
      weddingPlayed: {},
      masterMerchantPlayed: { target: 1 },
      spyPlayed: { target: 1 },
      deserterPlayed: { target: 1 },
    };
    const lines: string[] = [];
    for (const [type, extra] of Object.entries(samples)) {
      expect(KNIGHTS_ACTOR_EVENTS.has(type)).toBe(true);
      lines.push(`${type}: ${line({ type, seat: 0, ...extra })}`);
    }
    // Each line names the actor, and none fell back to a bare key.
    for (const entry of lines) expect(entry).toContain('Ada');
  });
});

describe('log icons', () => {
  test('attack and sail events show the ship, pieces show the seat colour', () => {
    const ship = knightsEventArt({ type: 'barbarianAttack' }, 'red');
    expect(ship).toHaveLength(1);
    expect(knightsEventArt({ type: 'barbarianSail' }, undefined)).toEqual(ship);
    const knight = knightsEventArt({ type: 'knightBuilt', seat: 0 }, 'red');
    const other = knightsEventArt({ type: 'knightBuilt', seat: 0 }, 'blue');
    expect(knight).toHaveLength(1);
    expect(knight).not.toEqual(other);
  });

  test('other actor events fall back to a card back, and foreign events to nothing', () => {
    expect(knightsEventArt({ type: 'weddingPlayed', seat: 0 }, 'blue')).toHaveLength(1);
    expect(knightsEventArt({ type: 'roadBuilt', seat: 0 }, 'blue')).toBeNull();
    expect(knightsEventArt({ type: 'improvementBuilt', track: 'bogus' }, 'blue')).toBeNull();
  });
});

const at = (step: number, lastAttack: AttackReport | null = null): GameState => {
  const ext = knightsExt(genesis);
  return {
    ...genesis,
    ext: { ...genesis.ext, knights: { ...ext, barbarians: { step }, lastAttack } },
  };
};

describe('lines derived from the state, since the engine emits no event for them', () => {
  const attack: AttackReport = {
    turn: 4,
    strength: 3,
    defense: 1,
    contributions: [1, 0, 0],
    outcome: 'pillaged',
    defender: null,
    tied: [],
    pillaged: [{ seat: 2, vertex: 'v:0,0,N', sideways: false }],
  };

  test('a step forward is a sail line placed right after the dice', () => {
    const events: GameEvent[] = [
      { type: 'turnStarted' },
      { type: 'diceRolled', dice: [1, 2] },
      { type: 'produced' },
    ];
    expect(derivedKnightsEvents(at(1), at(2), events)).toEqual([
      { after: 2, event: { type: 'barbarianSail', step: 2, steps: 7 } },
    ]);
  });

  test('without a roll in the update the line goes last', () => {
    expect(derivedKnightsEvents(at(1), at(2), [{ type: 'x' }, { type: 'y' }])[0]?.after).toBe(2);
  });

  test('the landing becomes an attack line with the report in it', () => {
    const [derived] = derivedKnightsEvents(at(6), at(0, attack), []);
    expect(derived?.event).toMatchObject({
      type: 'barbarianAttack',
      outcome: 'pillaged',
      strength: 3,
      defense: 1,
      pillaged: [{ seat: 2 }],
    });
    // The derived event reads as the same sentence the formatter gives the real ones.
    expect(derived && line(derived.event)).toContain('Cy lost a city');
  });

  test('a still ship, or a step back with no attack, derives nothing', () => {
    expect(derivedKnightsEvents(at(3), at(3), [])).toEqual([]);
    expect(derivedKnightsEvents(at(3), at(0), [])).toEqual([]);
  });
});
