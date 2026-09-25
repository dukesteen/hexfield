import { describe, expect, test } from 'vitest';
import { VirtualClock } from './virtual-clock.js';

describe('VirtualClock', () => {
  test('runs equal-time timers in insertion order, including nested same-time timers', () => {
    const clock = new VirtualClock({ startAt: 10 });
    const calls: string[] = [];
    clock.setTimeout(() => {
      calls.push('first');
      clock.setTimeout(() => calls.push('nested'), 0);
    }, 5);
    clock.setTimeout(() => calls.push('second'), 5);

    expect(clock.advanceBy(5)).toBe(3);
    expect(calls).toEqual(['first', 'second', 'nested']);
    expect(clock.now()).toBe(15);
  });

  test('runNext executes one callback while runUntil stops when its predicate passes', () => {
    const clock = new VirtualClock();
    const calls: number[] = [];
    clock.setTimeout(() => calls.push(1), 4);
    clock.setTimeout(() => calls.push(2), 4);
    expect(clock.runNext()).toBe(true);
    expect(calls).toEqual([1]);
    expect(clock.runUntil(() => calls.length === 2)).toBe(true);
    expect(calls).toEqual([1, 2]);
    expect(clock.runNext()).toBe(false);
  });

  test('cancellation is idempotent and foreign handles do not affect timers', () => {
    const clock = new VirtualClock();
    const otherClock = new VirtualClock();
    let calls = 0;
    const handle = clock.setTimeout(() => calls++, 1);
    const foreignHandle = otherClock.setTimeout(() => calls++, 1);
    clock.clearTimeout(handle);
    clock.clearTimeout(handle);
    clock.clearTimeout(foreignHandle);
    clock.clearTimeout(undefined);
    expect(clock.pendingTimerCount()).toBe(0);
    expect(otherClock.pendingTimerCount()).toBe(1);
    clock.advanceTo(1);
    otherClock.advanceTo(1);
    expect(calls).toBe(1);
  });

  test('operation limits stop recurring timers without losing the next timer', () => {
    const clock = new VirtualClock();
    let calls = 0;
    const recur = () => {
      calls++;
      clock.setTimeout(recur, 1);
    };
    clock.setTimeout(recur, 1);

    expect(() => clock.advanceTo(100, 3)).toThrow('operation limit');
    expect(calls).toBe(3);
    expect(clock.now()).toBe(3);
    expect(clock.pendingTimerCount()).toBe(1);
    expect(() => clock.runUntil(() => false, 2)).toThrow('operation limit');
    expect(calls).toBe(5);
  });

  test('rejects backwards time and reentrant clock advancement', () => {
    const clock = new VirtualClock();
    expect(() => clock.advanceTo(-1)).toThrow('cannot move backwards');
    expect(() => clock.advanceBy(-1)).toThrow('non-negative');
    clock.setTimeout(() => {
      expect(() => clock.runNext()).toThrow('cannot be advanced');
      expect(() => clock.runUntil(() => true)).toThrow('cannot be advanced');
    }, 0);
    clock.runNext();
  });
});
