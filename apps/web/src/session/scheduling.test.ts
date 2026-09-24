import { describe, expect, test } from 'vitest';
import { createBaseEngine } from '@cp2p/engine';
import type { GameState, Pending, Seat } from '@cp2p/engine';
import { chooseBotPending, timerKey } from './scheduling.js';

const engine = createBaseEngine();
const state = engine.createGame(
  {
    modules: [{ id: 'base', version: '1.0.0' }],
    seats: [0, 1, 2],
    options: { base: { mapLayout: 'random' } },
  },
  new Uint8Array(32).fill(3),
);

function inMain(offers: unknown[] = []): GameState {
  const base = state.ext.base;
  if (typeof base !== 'object' || base === null) throw new Error('Missing base state');
  return {
    ...state,
    turn: { number: 7, activeSeat: 0, phase: [{ module: 'base', id: 'main', data: null }] },
    ext: { ...state.ext, base: { ...base, offers } },
  };
}

const offer = (id: number) => ({ id, proposer: 0, to: [1], acceptedBy: [], declinedBy: [] });

describe('local scheduling', () => {
  test('nonactive discard seats each receive a distinct timer and the first mandatory bot acts', () => {
    const current = inMain();
    const pending: Pending[] = [
      {
        kind: 'player',
        seat: 0,
        allowed: ['DISCARD'],
        deadline: { phase: 'discard', seconds: 11 },
      },
      {
        kind: 'player',
        seat: 1,
        allowed: ['DISCARD'],
        deadline: { phase: 'discard', seconds: 11 },
      },
      { kind: 'player', seat: 2, allowed: ['CLAIM_VICTORY'] },
    ];
    const first = pending[0];
    const second = pending[1];
    if (first?.kind !== 'player' || second?.kind !== 'player') throw new Error('Missing discard');
    expect(timerKey(current, first)).not.toBeNull();
    expect(timerKey(current, second)).not.toBeNull();
    expect(timerKey(current, first)).not.toBe(timerKey(current, second));
    expect(chooseBotPending(current, pending, new Set<Seat>([1]))).toBeNull();
    expect(chooseBotPending(current, pending, new Set<Seat>([0, 1]))?.seat).toBe(0);
  });

  test('a replacement offer has a new responder timer key and proposal-only bots wait', () => {
    const pending: Pending = {
      kind: 'player',
      seat: 1,
      allowed: ['RESPOND_TRADE', 'PROPOSE_TRADE'],
      deadline: { phase: 'main', seconds: 15 },
    };
    if (pending.kind !== 'player') throw new Error('Missing responder');
    expect(timerKey(inMain([offer(8)]), pending)).not.toBe(timerKey(inMain([offer(9)]), pending));
    expect(timerKey(inMain(), pending)).toBeNull();
    const proposal: Pending[] = [{ kind: 'player', seat: 1, allowed: ['PROPOSE_TRADE'] }];
    expect(chooseBotPending(inMain(), proposal, new Set<Seat>([1]))).toBeNull();
  });
});
