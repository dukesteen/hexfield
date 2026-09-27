import type { Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { chooseBotPending } from './bot-pending.js';

const state = (activeSeat: Seat) => ({ turn: { activeSeat } });
const player = (seat: Seat, ...allowed: string[]) => ({ kind: 'player' as const, seat, allowed });

test('waits for a mandatory human discard before choosing the active bot', () => {
  const discard = player(1, 'DISCARD');
  const active = player(0, 'ROLL_DICE');
  expect(chooseBotPending(state(0), [active, discard], new Set([0]))).toBeNull();
  expect(chooseBotPending(state(0), [active, discard], new Set([0, 1]))).toBe(discard);
});

test('waits for mandatory human trade responses and selects a hosted bot response', () => {
  const response = player(2, 'RESPOND_TRADE');
  expect(chooseBotPending(state(0), [player(0, 'ROLL_DICE'), response], new Set([0]))).toBeNull();
  expect(chooseBotPending(state(0), [player(0, 'ROLL_DICE'), response], new Set([0, 2]))).toBe(
    response,
  );
});

test('ignores claim-only player pendings when selecting a normal bot action', () => {
  const claimOnly = player(0, 'CLAIM_VICTORY');
  const active = player(0, 'ROLL_DICE', 'CLAIM_VICTORY');
  expect(chooseBotPending(state(0), [claimOnly], new Set([0]))).toBeNull();
  expect(chooseBotPending(state(0), [claimOnly, active], new Set([0]))).toBe(active);
});

test('returns no action when no eligible hosted bot has a player pending', () => {
  expect(chooseBotPending(state(0), [player(0, 'ROLL_DICE')], new Set())).toBeNull();
});
