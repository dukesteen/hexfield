import { knightsConfig, knightsEngine } from '@cp2p/engine';
import type { GameState, PrivateState, Result } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { PRIVATE_TIMEOUT_TYPES, timedPrivateCommand } from './turn-timeout.js';

const engine = knightsEngine();

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** A knights game whose seat 0 holds the given public card total and progress slots. */
function fixture(total: number, hand: Record<string, number>, slots: string[]) {
  const base = engine.createGame(knightsConfig({ seats: 3 }), new Uint8Array(32).fill(5));
  const state: GameState = {
    ...base,
    seats: base.seats.map((seat) =>
      seat.seat === 0
        ? {
            ...seat,
            resources: { ...seat.resources, total },
            cardSlots: slots.map((_, index) => ({
              slotId: `progress:${index}`,
              deck: 'progress-trade',
              acquiredTurn: 0,
            })),
          }
        : seat,
    ),
  };
  const priv: PrivateState = {
    ...engine.createPrivateState(0, knightsConfig({ seats: 3 })),
    hand: { ...engine.createPrivateState(0, knightsConfig({ seats: 3 })).hand, ...hand },
    slots: Object.fromEntries(slots.map((card, index) => [`progress:${index}`, card])),
  };
  return { state, priv };
}

describe('timed defaults for private choices', () => {
  test('names the private choices the owner makes', () => {
    expect(PRIVATE_TIMEOUT_TYPES).toEqual(
      expect.arrayContaining([
        'DISCARD',
        'DISCARD_PROGRESS',
        'SABOTEUR_DISCARD',
        'WEDDING_GIVE',
        'HARBOR_REPLY',
      ]),
    );
  });

  test('a Wedding gift is two cards, the most plentiful kinds first; a Saboteur discard is half', () => {
    const { state, priv } = fixture(5, { ore: 3, cloth: 2 }, []);
    expect(value(timedPrivateCommand(state, priv, ['WEDDING_GIVE']))).toEqual({
      type: 'WEDDING_GIVE',
      cards: expect.objectContaining({ ore: 2 }),
    });
    expect(value(timedPrivateCommand(state, priv, ['SABOTEUR_DISCARD']))).toEqual({
      type: 'SABOTEUR_DISCARD',
      cards: expect.objectContaining({ ore: 2 }),
    });
  });

  test('a hand that cannot satisfy the choice is reported, not guessed', () => {
    const { state, priv } = fixture(4, { ore: 1 }, []);
    expect(timedPrivateCommand(state, priv, ['WEDDING_GIVE']).ok).toBe(false);
  });

  test('a Harbor reply gives the first commodity held, or none', () => {
    expect(value(timedPrivateCommand(...harbor(fixture(2, { coin: 1, paper: 1 }, []))))).toEqual({
      type: 'HARBOR_REPLY',
      commodity: 'coin',
    });
    expect(value(timedPrivateCommand(...harbor(fixture(1, { ore: 1 }, []))))).toEqual({
      type: 'HARBOR_REPLY',
      commodity: 'none',
    });
  });

  test('surplus progress cards are the newest ones, and nothing is discarded at the limit', () => {
    const six = fixture(0, {}, ['spy', 'crane', 'merchant', 'wedding', 'smith', 'mining']);
    expect(value(timedPrivateCommand(six.state, six.priv, ['DISCARD_PROGRESS']))).toEqual({
      type: 'DISCARD_PROGRESS',
      cards: [
        { slotId: 'progress:4', card: 'smith' },
        { slotId: 'progress:5', card: 'mining' },
      ],
    });
    const four = fixture(0, {}, ['spy', 'crane', 'merchant', 'wedding']);
    expect(value(timedPrivateCommand(four.state, four.priv, ['DISCARD_PROGRESS']))).toBeNull();
    expect(value(timedPrivateCommand(four.state, four.priv, ['END_TURN']))).toBeNull();
  });
});

function harbor(input: {
  state: GameState;
  priv: PrivateState;
}): [GameState, PrivateState, string[]] {
  return [input.state, input.priv, ['HARBOR_REPLY']];
}
