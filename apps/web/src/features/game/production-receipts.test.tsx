// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LocalSession, type SessionUpdate } from '../../session';
import { standardFixedBoard } from '@cp2p/maps';
import type { ProductionGain } from './visual-effects';
import { useProductionReceipts, useVisualEffects } from './use-visual-effects';

const sessionStub = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../store/session-store', () => ({
  sessionForActions: () => sessionStub.current,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function gain(id: string, seat: 0 | 1, resources: ProductionGain['resources']): ProductionGain {
  return { id, seat, resources };
}

test('receipts accumulate per seat while each production batch expires after eight seconds', async () => {
  const { result } = renderHook(() => useProductionReceipts(null));
  act(() => result.current.add([gain('a', 0, { brick: 2 })]));
  expect(result.current.receipts).toEqual([{ seat: 0, resources: { brick: 2 }, expiresAt: 8_000 }]);

  await act(() => vi.advanceTimersByTime(4_000));
  act(() => result.current.add([gain('b', 0, { ore: 1 }), gain('c', 1, { wool: 2 })]));
  expect(result.current.receipts).toEqual([
    { seat: 0, resources: { brick: 2, ore: 1 }, expiresAt: 12_000 },
    { seat: 1, resources: { wool: 2 }, expiresAt: 12_000 },
  ]);

  await act(() => vi.advanceTimersByTime(4_000));
  expect(result.current.receipts).toEqual([
    { seat: 0, resources: { ore: 1 }, expiresAt: 12_000 },
    { seat: 1, resources: { wool: 2 }, expiresAt: 12_000 },
  ]);
  await act(() => vi.advanceTimersByTime(4_000));
  expect(result.current.receipts).toEqual([]);
});

test('session replacement and unmount clear receipts and their expiry timer', () => {
  const firstSession = {};
  const nextSession = {};
  const { result, rerender, unmount } = renderHook(
    ({ session }) => useProductionReceipts(session),
    { initialProps: { session: firstSession } },
  );
  act(() => result.current.add([gain('a', 0, { grain: 1 })]));
  expect(vi.getTimerCount()).toBe(1);

  rerender({ session: nextSession });
  expect(result.current.receipts).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  act(() => result.current.add([gain('b', 1, { lumber: 1 })]));
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test('useVisualEffects subscribes without a renderer and Skip does not clear public receipts', () => {
  const made = LocalSession.create({
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1],
      options: { base: { mapLayout: 'standard-fixed' } },
      board: standardFixedBoard(),
    },
    humanSeats: [0, 1],
    botSeats: [],
    genesisSeed: new Uint8Array(32).fill(7),
  });
  if (!made.ok) throw new Error(made.error.message);
  const state = made.value.getState();
  let listener: ((update: SessionUpdate) => void) | null = null;
  sessionStub.current = {
    getState: () => state,
    subscribe: (next: (update: SessionUpdate) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  const { result, rerender, unmount } = renderHook(
    ({ reducedMotion }) => useVisualEffects(null, reducedMotion),
    { initialProps: { reducedMotion: true } },
  );
  const update: SessionUpdate = {
    revision: 1,
    state,
    events: [
      { type: 'resourcesProduced', bySeat: { '0': { grain: 2 } } },
      { type: 'resourceStolen', thief: 0, victim: 1, resource: 'ore' },
    ],
    pending: [],
    timers: [],
    status: { kind: 'running' },
  };
  act(() => listener?.(update));
  expect(result.current.receipts).toEqual([{ seat: 0, resources: { grain: 2 }, expiresAt: 8_000 }]);

  rerender({ reducedMotion: false });
  act(() => result.current.skip());
  expect(result.current.receipts).toEqual([{ seat: 0, resources: { grain: 2 }, expiresAt: 8_000 }]);
  unmount();
  expect(listener).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  made.value.dispose();
});
