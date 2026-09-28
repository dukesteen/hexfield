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

test('an out-of-turn optional trade cannot starve the active player', () => {
  const optional = player(1, 'PROPOSE_TRADE', 'CANCEL_TRADE');
  const active = player(2, 'BUILD_CITY', 'END_TURN');
  expect(chooseBotPending(state(2), [optional, active], new Set([1]))).toBeNull();
  expect(chooseBotPending(state(2), [optional, active], new Set([2]))).toBe(active);
});

test('a hosted bot takes its special build phase while another seat is active', () => {
  const build = player(
    3,
    'BUILD_ROAD',
    'BUILD_SETTLEMENT',
    'BUILD_CITY',
    'BUY_DEV_CARD',
    'END_SBP',
  );
  expect(chooseBotPending(state(2), [build], new Set([3]))).toBe(build);
  expect(chooseBotPending(state(2), [build], new Set([2]))).toBeNull();
});
