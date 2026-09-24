import { expect, test } from 'vitest';
import { createBaseEngine } from '@cp2p/engine';
import type { Input } from '@cp2p/engine';
import { fuzz, invalidMutations } from './fuzz.js';

const engine = createBaseEngine();
const state = engine.createGame(
  { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1, 2], options: { base: {} } },
  new Uint8Array(32),
);

test('mutations use real nonpending seats and fully shaped system inputs', () => {
  const started = engine.apply(state, { kind: 'system', type: 'START_SEAT', seat: 0 });
  if (!started.ok) throw new Error(started.error.message);
  const legal = engine.getLegalCommands(started.value.state, 0).commands[0];
  if (!legal) throw new Error('Missing setup command');
  const command: Input = { kind: 'command', seat: 0, command: legal };
  const wrong = invalidMutations(command, started.value.state, engine, 'wrong-seat-real', 0);
  expect(wrong).toHaveLength(1);
  expect(wrong[0]?.input).toMatchObject({ kind: 'command', seat: 1 });
  expect(engine.validate(started.value.state, wrong[0]?.input ?? command)).toMatchObject({
    ok: false,
    error: { code: 'not-pending' },
  });

  const startInput: Input = { kind: 'system', type: 'START_SEAT', seat: 0 };
  const mismatch = invalidMutations(startInput, state, engine, 'system-mismatch', 0);
  expect(mismatch[0]?.input).toMatchObject({ kind: 'system', type: 'DICE_RESULT', dice: [1, 1] });
  expect(engine.validate(state, mismatch[0]?.input ?? startInput)).toMatchObject({
    ok: false,
    error: { code: 'not-pending' },
  });
  const during = invalidMutations(startInput, state, engine, 'command-during-system', 0);
  expect(during[0]?.input).toMatchObject({ kind: 'command', command: { type: 'ROLL_DICE' } });
  expect(engine.validate(state, during[0]?.input ?? startInput)).toMatchObject({
    ok: false,
    error: { code: 'not-pending' },
  });
});

test('missing required fields follow handler metadata and count mutations preserve totals', () => {
  const trade: Input = {
    kind: 'command',
    seat: 0,
    command: { type: 'OFFER_TRADE', give: { brick: 1 }, want: { grain: 1 }, to: [1] },
  };
  expect(
    invalidMutations(trade, state, engine, 'missing-required', 0).map((item) => item.label),
  ).toEqual(['command:OFFER_TRADE:give', 'command:OFFER_TRADE:want']);
  const dice: Input = { kind: 'system', type: 'DICE_RESULT', dice: [1, 2] };
  expect(
    invalidMutations(dice, state, engine, 'missing-required', 0).map((item) => item.label),
  ).toEqual(['system:DICE_RESULT:dice']);
  const balanced = engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2],
      options: { base: { diceMode: 'balanced' } },
    },
    new Uint8Array(32),
  );
  const indexedDice: Input = { kind: 'system', type: 'DICE_RESULT', dice: [1, 1], index: 0 };
  expect(
    invalidMutations(indexedDice, balanced, engine, 'missing-required', 0).map(
      (item) => item.label,
    ),
  ).toEqual(['system:DICE_RESULT:dice', 'system:DICE_RESULT:index']);
  const discard: Input = {
    kind: 'command',
    seat: 0,
    command: { type: 'DISCARD', cards: { brick: 1, wool: 2 } },
  };
  const negative = invalidMutations(discard, state, engine, 'negative-sum-preserving', 0)[0]?.input;
  expect(negative).toMatchObject({ command: { cards: { brick: -1, lumber: 4 } } });
  expect(invalidMutations(discard, state, engine, 'fractional-count', 0)[0]?.input).toMatchObject({
    command: { cards: { brick: 0.5 } },
  });
  expect(invalidMutations(discard, state, engine, 'string-count', 0)[0]?.input).toMatchObject({
    command: { cards: { brick: '1' } },
  });
  expect(invalidMutations(discard, state, engine, 'unsafe-count', 0)[0]?.input).toMatchObject({
    command: { cards: { brick: Number.MAX_SAFE_INTEGER + 1 } },
  });
});

test('seeded fuzz exercises balanced index, per-key omission, pending, and private audit paths', () => {
  const result = fuzz({ seed: 43, iterations: 12_000 });
  expect(result.iterations).toBe(12_000);
  for (const family of [
    'wrong-seat-real',
    'system-mismatch',
    'command-during-system',
    'stale-duplicate',
    'invalid-index',
    'negative-sum-preserving',
  ])
    expect(result.families[family]).toBeGreaterThan(0);
  expect(result.missingRequiredKeys['command:OFFER_TRADE:want']).toBeGreaterThan(0);
  expect(result.missingRequiredKeys['system:CARD_DEALT:slotId']).toBeGreaterThan(0);
  expect(result.validLookingAccepted).toBeGreaterThan(0);
  for (const type of [
    'command:PLACE_SETTLEMENT',
    'command:PLACE_ROAD',
    'command:BUILD_ROAD',
    'command:MOVE_ROBBER',
    'command:STEAL',
    'command:DISCARD',
    'command:OFFER_TRADE',
    'command:MARITIME_TRADE',
    'system:DICE_RESULT',
  ])
    expect(result.validLookingAcceptedByType[type]).toBeGreaterThan(0);
});
