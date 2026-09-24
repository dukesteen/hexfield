import { describe, expect, test } from 'vitest';
import { createBaseEngine, DEV_CARD_COUNTS } from '@cp2p/engine';
import type { GameState, Pending, PrivateState, Seat } from '@cp2p/engine';
import { createBrowserRandomSource, randomIndex, remainingDevPool } from './random.js';
import type { Entropy } from './random.js';

const engine = createBaseEngine();
function genesis(): GameState {
  return engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2],
      options: { base: { mapLayout: 'random' } },
    },
    new Uint8Array(32).fill(8),
  );
}
function privates(): Map<Seat, PrivateState> {
  const seats: Seat[] = [0, 1, 2];
  return new Map(seats.map((seat) => [seat, engine.createPrivateState(seat)]));
}

describe('browser random source', () => {
  test('uniform index rejects biased tail bytes', () => {
    let calls = 0;
    const entropy: Entropy = {
      randomBytes(target) {
        target.fill(0);
        new DataView(target.buffer).setUint32(0, calls++ === 0 ? 0xffff_ffff : 7, true);
      },
    };
    expect(randomIndex(entropy, 3)).toBe(1);
    expect(calls).toBe(2);
  });

  test('forced random dice are one-shot and balanced dice reject the force', () => {
    const entropy: Entropy = {
      randomBytes(target) {
        target.fill(0);
      },
    };
    const source = createBrowserRandomSource(entropy);
    const pending: Pending = {
      kind: 'random',
      systemType: 'DICE_RESULT',
      request: { type: 'dice', mode: 'random' },
    };
    if (pending.kind !== 'random') throw new Error('Missing dice request');
    source.forceNextDice([5, 6]);
    expect(source.resolve(pending, genesis(), privates()).input).toEqual({
      kind: 'system',
      type: 'DICE_RESULT',
      dice: [5, 6],
    });
    expect(source.resolve(pending, genesis(), privates()).input).toEqual({
      kind: 'system',
      type: 'DICE_RESULT',
      dice: [1, 1],
    });
    source.forceNextDice([2, 3]);
    expect(() =>
      source.resolve(
        { ...pending, request: { type: 'dice', mode: 'balanced' } },
        genesis(),
        privates(),
      ),
    ).toThrow('balanced');
  });

  test('remaining stock is derived from exact slot identities and rejects an impossible save', () => {
    const state = genesis();
    const secrets = privates();
    const starting = Object.values(DEV_CARD_COUNTS).reduce((sum, count) => sum + count, 0);
    expect(remainingDevPool(state, secrets)).toHaveLength(starting);
    const drawn = {
      ...state,
      decks: {
        ...state.decks,
        dev: { remaining: starting - 1, drawn: [{ seat: 0 as Seat, slotId: 'dev-1' }] },
      },
      seats: state.seats.map((seat) =>
        seat.seat === 0
          ? { ...seat, cardSlots: [{ slotId: 'dev-1', deck: 'dev', acquiredTurn: 1 }] }
          : seat,
      ),
    };
    const owner = secrets.get(0);
    if (!owner) throw new Error('Missing private owner');
    secrets.set(0, { ...owner, slots: { 'dev-1': 'victoryPoint' } });
    expect(remainingDevPool(drawn, secrets)).toHaveLength(starting - 1);
    secrets.set(0, { ...owner, slots: { 'dev-1': 'not-a-card' } });
    expect(() => remainingDevPool(drawn, secrets)).toThrow('stock');
  });
});
