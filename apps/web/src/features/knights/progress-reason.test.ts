import { expect, test } from 'vitest';
import { knightsConfig, knightsEngine, knightsExt } from '@cp2p/engine';
import type { GameState, Seat } from '@cp2p/engine';
import { notPlayableReason } from './progress-reason';

const genesis = knightsEngine().createGame(knightsConfig({ seats: 3 }), new Uint8Array(32).fill(6));

function at(step: string, activeSeat: Seat = 0, robberLocked = true): GameState {
  const ext = knightsExt(genesis);
  return {
    ...genesis,
    turn: { ...genesis.turn, activeSeat, phase: [{ module: 'base', id: step, data: null }] },
    ext: { ...genesis.ext, knights: { ...ext, robberLocked } },
  };
}

test('a victory card is never played, whoever holds the turn', () => {
  expect(notPlayableReason(at('main'), 0, 'printer')).toBe('victory');
  expect(notPlayableReason(at('main', 1), 0, 'constitution')).toBe('victory');
});

test("another seat's turn comes before any timing", () => {
  expect(notPlayableReason(at('main', 2), 0, 'mining')).toBe('notYourTurn');
  expect(notPlayableReason(at('preRoll', 2), 0, 'alchemist')).toBe('notYourTurn');
});

test('the Alchemist is only before the roll; the other cards only after it', () => {
  expect(notPlayableReason(at('main'), 0, 'alchemist')).toBe('onlyBeforeRoll');
  expect(notPlayableReason(at('preRoll'), 0, 'mining')).toBe('afterRoll');
  expect(notPlayableReason(at('discard'), 0, 'mining')).toBe('finishStep');
});

test('the Bishop waits for the robber; otherwise the card has no target', () => {
  expect(notPlayableReason(at('main'), 0, 'bishop')).toBe('robberLocked');
  expect(notPlayableReason(at('main', 0, false), 0, 'bishop')).toBe('noTarget');
  expect(notPlayableReason(at('main'), 0, 'deserter')).toBe('noTarget');
  expect(notPlayableReason(at('main'), 0, 'mining', true)).toBe('busy');
});
