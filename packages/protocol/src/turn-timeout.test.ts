import { hashValue, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { BASE_VERSION, createBaseEngine } from '@cp2p/engine';
import type { GameState, Result } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { entryHash, signEntry } from './genesis.js';
import { VirtualClock } from './testing/virtual-clock.js';
import {
  advanceTimerAnchors,
  LocalTimerObserver,
  timedDiscardCommand,
  TURN_TIMEOUT_PROTOCOL,
  verifyTimeoutEvidence,
} from './turn-timeout.js';
import type { LogEntry } from './types.js';

const engine = createBaseEngine();
const key = new Uint8Array(32).fill(9);
const signer = identityFromSecret(key).peerId;

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function game(phase: 'main' | 'preRoll' | 'discard'): GameState {
  const state = engine.createGame(
    {
      modules: [{ id: 'base', version: BASE_VERSION }],
      seats: [0, 1],
      options: {
        base: {
          turnTimer: { preRollSec: 10, mainSec: 10, discardSec: 10, robberSec: 10 },
        },
      },
    },
    new Uint8Array(32),
  );
  return {
    ...state,
    turn: {
      ...state.turn,
      activeSeat: 0,
      phase: [
        { module: 'base', id: phase, data: phase === 'discard' ? { remaining: [0, 1] } : null },
      ],
    },
  };
}

function entry(seq: number, state: GameState, previous?: LogEntry): LogEntry {
  return signEntry(
    {
      seq,
      term: 1,
      prevHash: previous ? entryHash(previous) : '0'.repeat(64),
      payload: {
        kind: 'system',
        input: { kind: 'system', type: 'TIMEOUT', seat: 0, phase: 'main' },
        evidence: {
          kind: 'proof',
          protocol: TURN_TIMEOUT_PROTOCOL,
          data: { pendingSince: 0, deadlineMs: 10_000 },
        },
      },
      stateHash: toHex(hashValue(state)),
      sequencer: signer,
    },
    key,
  );
}

describe('verified turn timer anchors', () => {
  test('state-preserving entry retains the original anchor and a new phase resets it', () => {
    const main = game('main');
    const first = entry(4, main);
    const initial = value(advanceTimerAnchors(engine, main, first));
    expect(initial).toHaveLength(1);
    expect(initial[0]?.pendingSince).toEqual({ seq: 4, hash: entryHash(first) });
    const control = entry(5, main, first);
    const unchanged = value(advanceTimerAnchors(engine, main, control, initial));
    expect(unchanged).toEqual(initial);
    const preRoll = game('preRoll');
    const changed = entry(6, preRoll, control);
    expect(
      value(advanceTimerAnchors(engine, preRoll, changed, unchanged))[0]?.pendingSince.seq,
    ).toBe(6);
  });

  test('two simultaneous discards have independent certified anchors', () => {
    const discards = game('discard');
    const first = entry(8, discards);
    const anchors = value(advanceTimerAnchors(engine, discards, first));
    expect(anchors.map((anchor) => anchor.seat)).toEqual([0, 1]);
    expect(new Set(anchors.map((anchor) => anchor.key)).size).toBe(2);
    const next = entry(9, discards, first);
    expect(value(advanceTimerAnchors(engine, discards, next, anchors))).toEqual(anchors);
  });

  test('strict evidence and local elapsed gate reject early, then accept at tolerance', () => {
    const state = game('main');
    const anchors = value(advanceTimerAnchors(engine, state, entry(4, state)));
    const anchor = anchors[0];
    if (!anchor) throw new Error('Missing timer');
    const input = { kind: 'system' as const, type: 'TIMEOUT', seat: 0 as const, phase: 'main' };
    const evidence = {
      kind: 'proof' as const,
      protocol: TURN_TIMEOUT_PROTOCOL,
      data: { pendingSince: 4, deadlineMs: 10_000 },
    };
    expect(verifyTimeoutEvidence(input, evidence, anchors).ok).toBe(true);
    expect(
      verifyTimeoutEvidence(
        input,
        { ...evidence, data: { ...evidence.data, pendingSince: 5 } },
        anchors,
      ).ok,
    ).toBe(false);
    expect(
      verifyTimeoutEvidence(input, { ...evidence, data: { ...evidence.data, extra: 1 } }, anchors)
        .ok,
    ).toBe(false);
    const clock = new VirtualClock();
    const local = new LocalTimerObserver(clock, anchors);
    clock.advanceBy(6_999);
    expect(local.untilVote(anchor)).toBe(1);
    expect(local.canVote(anchor)).toMatchObject({
      ok: false,
      error: { code: 'turn-timeout-early' },
    });
    clock.advanceBy(1);
    expect(local.untilVote(anchor)).toBe(0);
    expect(local.canVote(anchor).ok).toBe(true);
    expect(local.timers()[0]?.remainingMs).toBe(3_000);
    const restarted = new LocalTimerObserver(clock, anchors);
    expect(restarted.canVote(anchor).ok).toBe(false);
    expect(restarted.timers()[0]?.remainingMs).toBe(10_000);
  });

  test('a private discard uses only the owner hand and remains an engine-legal command', () => {
    const initial = game('discard');
    const state: GameState = {
      ...initial,
      seats: initial.seats.map((seat) =>
        seat.seat === 0
          ? {
              ...seat,
              resources: {
                total: 9,
                min: { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 },
                max: { brick: 9, lumber: 9, wool: 9, grain: 9, ore: 9 },
              },
            }
          : seat,
      ),
    };
    const owner = {
      ...engine.createPrivateState(0),
      hand: { brick: 2, lumber: 1, wool: 0, grain: 3, ore: 3 },
    };
    const command = value(timedDiscardCommand(state, owner));
    expect(command).toEqual({
      type: 'DISCARD',
      cards: { brick: 0, lumber: 0, wool: 0, grain: 3, ore: 1 },
    });
    expect(engine.validate(state, { kind: 'command', seat: 0, command }).ok).toBe(true);
  });
});
