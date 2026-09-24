import { describe, expect, test } from 'vitest';
import { createBaseEngine } from '@cp2p/engine';
import type { Pending } from '@cp2p/engine';
import { createLocalRandomSource, deriveSeed } from './random-source.js';

const engine = createBaseEngine();
const config = {
  modules: [{ id: 'base', version: '1.0.0' }],
  seats: [0, 1, 2, 3] as const,
  options: { base: {} },
};

describe('seeded local random source', () => {
  test('domain and game index separate deterministic streams', () => {
    expect(deriveSeed(42, 0, 'system')).toEqual(deriveSeed(42, 0, 'system'));
    expect(deriveSeed(42, 0, 'system')).not.toEqual(deriveSeed(42, 1, 'system'));
    expect(deriveSeed(42, 0, 'system')).not.toEqual(deriveSeed(42, 0, 'genesis'));
  });

  test('deals the full 25-card deck at documented counts, then rejects exhaustion', () => {
    const state = engine.createGame(
      { ...config, seats: [...config.seats] },
      deriveSeed(7, 0, 'genesis'),
    );
    const privates = new Map(config.seats.map((seat) => [seat, engine.createPrivateState(seat)]));
    const source = createLocalRandomSource(deriveSeed(7, 0, 'system'));
    const cards: string[] = [];
    for (let index = 0; index < 25; index++) {
      const pending: Pending = {
        kind: 'random',
        systemType: 'CARD_DEALT',
        request: { type: 'draw', deck: 'dev', seat: 0, slotId: `dev:${index}` },
      };
      const answer = source.resolve(pending, state, privates);
      expect(answer.input).toMatchObject({ kind: 'system', type: 'CARD_DEALT', seat: 0 });
      const card = answer.input.card;
      if (typeof card !== 'string') throw new Error('Missing local card identity');
      cards.push(card);
    }
    expect(
      Object.fromEntries(
        [...new Set(cards)].map((card) => [card, cards.filter((value) => value === card).length]),
      ),
    ).toEqual({ knight: 14, victoryPoint: 5, roadBuilding: 2, yearOfPlenty: 2, monopoly: 2 });
    expect(() =>
      source.resolve(
        {
          kind: 'random',
          systemType: 'CARD_DEALT',
          request: { type: 'draw', seat: 0, slotId: 'dev:25' },
        },
        state,
        privates,
      ),
    ).toThrow('Invalid development draw');
  });
});
