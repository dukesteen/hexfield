import type { Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { botAwaitsTradeReplies, chooseBotPending } from './bot-pending.js';

const state = (activeSeat: Seat) => ({ turn: { activeSeat } });
const player = (seat: Seat, ...allowed: string[]) => ({ kind: 'player' as const, seat, allowed });

test('waits for a mandatory human discard before choosing the active bot', () => {
  const discard = player(1, 'DISCARD');
  const active = player(0, 'ROLL_DICE');
  expect(chooseBotPending(state(0), [active, discard], new Set([0]))).toBeNull();
  expect(chooseBotPending(state(0), [active, discard], new Set([0, 1]))).toBe(discard);
});

test('an offering bot waits patiently for human replies, hosted bots answer at once', () => {
  const active = player(0, 'END_TURN', 'CONFIRM_TRADE', 'CANCEL_TRADE');
  const human = player(1, 'PROPOSE_TRADE', 'RESPOND_TRADE');
  const bot = player(2, 'PROPOSE_TRADE', 'RESPOND_TRADE');
  // A hosted bot's reply comes first even when a person earlier in seat order still owes one.
  expect(chooseBotPending(state(0), [active, human, bot], new Set([0, 2]))).toBe(bot);
  expect(botAwaitsTradeReplies(state(0), [active, human, bot], new Set([0, 2]))).toBe(false);
  // With only the person left, the offering bot is chosen, flagged to wait before settling.
  expect(chooseBotPending(state(0), [active, human], new Set([0, 2]))).toBe(active);
  expect(botAwaitsTradeReplies(state(0), [active, human], new Set([0, 2]))).toBe(true);
  // Once every reply is in it settles at the normal pace.
  expect(botAwaitsTradeReplies(state(0), [active], new Set([0, 2]))).toBe(false);
  // A person's offer: hosted bots answer, then the person decides; no bot acts meanwhile.
  expect(chooseBotPending(state(1), [player(1, 'END_TURN'), bot], new Set([2]))).toBe(bot);
  const other = player(3, 'PROPOSE_TRADE', 'RESPOND_TRADE');
  expect(chooseBotPending(state(1), [player(1, 'END_TURN'), other], new Set([2]))).toBeNull();
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

test('a fog draw is the driver’s to resolve, and the bot then takes its gold choice', () => {
  const fog = {
    kind: 'random' as const,
    request: {
      type: 'draw',
      deck: 'fog-terrain',
      public: true,
      seat: 0,
      slotId: 'fog-terrain:0',
      remaining: 9,
      hex: 'h:2,1',
    },
    systemType: 'FOG_REVEALED',
  };
  // While the draw is pending no bot acts, even with a claim-only player pending beside it.
  expect(chooseBotPending(state(0), [fog], new Set([0]))).toBeNull();
  expect(chooseBotPending(state(0), [fog, player(0, 'CLAIM_VICTORY')], new Set([0]))).toBeNull();
  // A gold reveal leaves the revealer's one-card choice, which the bot answers.
  const gold = player(0, 'CHOOSE_GOLD');
  expect(chooseBotPending(state(0), [gold], new Set([0]))).toBe(gold);
});
