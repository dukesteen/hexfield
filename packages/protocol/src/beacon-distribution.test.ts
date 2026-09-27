import { createBaseEngine } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { randomDerivations } from './random-derivations.js';
import type { RandomPending } from './random-derivations.js';

const SAMPLE_ROUNDS = 100_000;
const CHI_SQUARE_MAX = 20.515; // df=5, upper-tail probability 0.001
const SUM_CHI_SQUARE_MAX = 29.588; // df=10, upper-tail probability 0.001

function required<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

test('beacon dice derivation has a uniform face distribution over 100,000 rounds', () => {
  const engine = createBaseEngine();
  const state = engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2, 3],
      options: { base: { mapLayout: 'random' } },
    },
    new Uint8Array(32).fill(7),
  );
  const pending: RandomPending = {
    kind: 'random',
    request: { type: 'dice', mode: 'random', sides: 6, count: 2 },
    systemType: 'DICE_RESULT',
  };
  const beaconOutput = new Uint8Array(32).fill(0x42);
  const counts = [Array<number>(6).fill(0), Array<number>(6).fill(0)];
  const sumCounts = Array<number>(11).fill(0);

  for (let round = 1; round <= SAMPLE_ROUNDS; round += 1) {
    const outcome = required(
      randomDerivations.derive(state, pending, beaconOutput, {
        game: 'beacon-distribution-v1',
        round,
      }),
    );
    if (outcome.kind !== 'system' || outcome.input.type !== 'DICE_RESULT')
      throw new Error('Beacon did not derive a dice result');
    const dice = outcome.input.dice;
    if (!Array.isArray(dice) || dice.length !== 2)
      throw new Error('Beacon dice result has an invalid shape');
    for (const [die, face] of dice.entries()) {
      if (!Number.isInteger(face) || face < 1 || face > 6)
        throw new Error('Beacon produced a face outside 1 through 6');
      const dieCounts = counts[die];
      if (!dieCounts) throw new Error('Beacon dice result has an unknown position');
      dieCounts[face - 1] = (dieCounts[face - 1] ?? 0) + 1;
    }
    const sumIndex = Number(dice[0]) + Number(dice[1]) - 2;
    sumCounts[sumIndex] = (sumCounts[sumIndex] ?? 0) + 1;
  }

  const expected = SAMPLE_ROUNDS / 6;
  const chiSquares = counts.map((dieCounts) =>
    dieCounts.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0),
  );
  expect(chiSquares).toHaveLength(2);
  for (const chiSquare of chiSquares) expect(chiSquare).toBeLessThan(CHI_SQUARE_MAX);
  const sumChiSquare = sumCounts.reduce((total, observed, index) => {
    const combinations = 6 - Math.abs(index - 5);
    const expectedSum = (SAMPLE_ROUNDS * combinations) / 36;
    return total + (observed - expectedSum) ** 2 / expectedSum;
  }, 0);
  expect(sumChiSquare).toBeLessThan(SUM_CHI_SQUARE_MAX);
});
