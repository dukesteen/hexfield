// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BoardRenderer } from '@cp2p/renderer';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CardFlight } from './card-flights';
import { heldHand, heldTotal, useCardHolds } from './card-holds';
import type { VisualEffects } from './visual-effects';
import { CARD_FLIGHT_MS, CARD_LANDS_MS, useVisualEffects } from './use-visual-effects.js';

const mock = vi.hoisted(() => ({
  session: null as unknown,
  effects: null as unknown,
  hand: {} as Record<string, number>,
}));

vi.mock('../../store/session-store', () => ({
  sessionForActions: () => mock.session,
  useSessionStore: { getState: () => ({ revealedSeat: 0 }) },
}));

vi.mock('./visual-effects', () => ({
  deriveVisualEffects: () => mock.effects,
}));

const renderer: Pick<BoardRenderer, 'playEffects' | 'skipAnimations' | 'getPixelPosition'> = {
  playEffects: () => undefined,
  skipAnimations: () => undefined,
  getPixelPosition: () => ({ x: 10, y: 20 }),
};

function setRect(element: HTMLElement, left: number, top: number) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: left,
      y: top,
      left,
      top,
      right: left + 30,
      bottom: top + 40,
      width: 30,
      height: 40,
      toJSON: () => ({}),
    }),
  });
}

/** The revealed hand with a slot per kind, the bank, and a panel for seat 1. */
function addTable() {
  const dock = document.createElement('section');
  dock.className = 'hand-dock';
  for (const [index, kind] of ['wool', 'grain', 'ore'].entries()) {
    const slot = document.createElement('div');
    slot.dataset.resource = kind;
    const image = document.createElement('img');
    setRect(image, 100 + index * 40, 400);
    slot.append(image);
    dock.append(slot);
  }
  const bank = document.createElement('section');
  bank.className = 'bank-panel';
  setRect(bank, 500, 100);
  const panel = document.createElement('aside');
  panel.dataset.seatPanel = '1';
  setRect(panel, 600, 50);
  document.body.append(dock, bank, panel);
}

let publish: ((update: unknown) => void) | null = null;
let revision = 0;

function setupSession() {
  mock.session = {
    getState: () => ({ config: { seats: [0, 1] } }),
    getPrivate: (seat: number) => (seat === 0 ? { hand: { ...mock.hand } } : null),
    subscribe: (listener: (update: unknown) => void) => {
      publish = listener;
      return () => {
        publish = null;
      };
    },
  };
}

/** Apply a new true hand along with the flights one update derives. */
function emit(hand: Record<string, number>, cardFlights: readonly CardFlight[], events = 1) {
  mock.hand = hand;
  mock.effects = {
    board: [],
    flights: [],
    cardFlights,
    productionGains: [],
  } satisfies VisualEffects;
  revision += 1;
  act(() =>
    publish?.({
      revision,
      state: { config: { seats: [0, 1] } },
      events: Array.from({ length: events }, () => ({ type: 'anything' })),
      pending: [],
      timers: [],
      status: { kind: 'running' },
    }),
  );
}

/** What the hand dock and the viewer's panel would draw now. */
function shown(): Record<string, number> {
  const holds = useCardHolds.getState().holds;
  const hand = heldHand(mock.hand, holds, 0);
  const total = Object.values(mock.hand).reduce((sum, count) => sum + count, 0);
  return { ...hand, total: heldTotal(total, holds, 0) };
}

function card(id: string, patch: Partial<CardFlight>): CardFlight {
  return { id, from: 'bank', to: 0, face: 'grain', count: 1, private: true, ...patch };
}

function View({ reducedMotion = false }: { reducedMotion?: boolean }) {
  const { overlay, skip } = useVisualEffects(renderer, reducedMotion);
  return (
    <>
      {overlay}
      <button type="button" onClick={skip}>
        Skip
      </button>
    </>
  );
}

const frame = () => act(() => vi.advanceTimersByTime(16));

beforeEach(() => {
  vi.useFakeTimers();
  // Frames run on the fake clock, one every 16ms.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((run) =>
    window.setTimeout(() => run(Date.now()), 16),
  );
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => window.clearTimeout(id));
  vi.setSystemTime(0);
  mock.hand = { wool: 1, grain: 1, ore: 0 };
  revision = 0;
  setupSession();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  useCardHolds.getState().clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('a card flying into the hand shows the old count until it lands', async () => {
  addTable();
  render(<View />);
  emit({ wool: 1, grain: 2, ore: 0 }, [card('in', {})]);
  expect(shown()).toMatchObject({ grain: 1, total: 2 });
  await frame();
  expect(document.querySelector('.trade-card-flight[data-card="grain"]')).not.toBeNull();
  expect(shown()).toMatchObject({ grain: 1, total: 2 });
  await act(() => vi.advanceTimersByTime(CARD_LANDS_MS - 1));
  expect(shown().grain).toBe(1);
  await act(() => vi.advanceTimersByTime(1));
  expect(shown()).toMatchObject({ grain: 2, total: 3 });
});

test('a card leaving the hand keeps its count until it takes off from its slot', async () => {
  addTable();
  render(<View />);
  emit({ wool: 0, grain: 1, ore: 0 }, [card('stolen', { from: 0, to: 1, face: 'wool' })]);
  expect(shown()).toMatchObject({ wool: 1, total: 2 });
  await frame();
  expect(shown()).toMatchObject({ wool: 0, total: 1 });
  const flight = document.querySelector<HTMLElement>('.trade-card-flight[data-card="wool"]');
  // It starts at the wool slot (115, 420) and ends at seat 1's panel (615, 70).
  expect(flight?.style.left).toBe('115px');
  expect(flight?.style.getPropertyValue('--flight-dx')).toBe('500px');
  expect(flight?.style.getPropertyValue('--flight-dy')).toBe('-350px');
});

test('reduced motion shows the true counts at once', () => {
  addTable();
  render(<View reducedMotion />);
  emit({ wool: 1, grain: 2, ore: 0 }, [card('in', {})]);
  expect(shown()).toMatchObject({ grain: 2, total: 3 });
  expect(vi.getTimerCount()).toBe(0);
});

test('a new update lands the cards still in the air at once, then settles on the state', async () => {
  addTable();
  render(<View />);
  emit({ wool: 1, grain: 2, ore: 0 }, [card('first', {})]);
  await act(() => vi.advanceTimersByTime(200));
  expect(shown()).toMatchObject({ grain: 1, total: 2 });
  emit({ wool: 1, grain: 3, ore: 1 }, [card('second', {}), card('ore', { face: 'ore' })]);
  // The first card is fast-forwarded: its count shows; the new ones are held.
  expect(shown()).toMatchObject({ grain: 2, ore: 0, total: 3 });
  expect(document.querySelector('.trade-card-flight')).toBeNull();
  await frame();
  expect(document.querySelectorAll('.trade-card-flight')).toHaveLength(2);
  await act(() => vi.advanceTimersByTime(CARD_LANDS_MS));
  expect(shown()).toMatchObject({ grain: 3, ore: 1, total: 5 });
  await act(() => vi.runAllTimers());
  expect(useCardHolds.getState().holds).toEqual([]);
});

test.each(['jump', 'skip', 'unreachable'] as const)(
  'a %s shows the true counts immediately',
  async (reason) => {
    if (reason !== 'unreachable') addTable();
    render(<View />);
    emit({ wool: 1, grain: 2, ore: 0 }, [card('in', {})]);
    if (reason === 'jump') emit({ wool: 0, grain: 5, ore: 0 }, [], 0);
    if (reason === 'skip') fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    if (reason === 'unreachable') await frame();
    expect(useCardHolds.getState().holds).toEqual([]);
    expect(shown().grain).toBe(mock.hand.grain);
    expect(document.querySelector('.trade-card-flight')).toBeNull();
  },
);

test('a hold never outlives its deadline even if its flight never launches', async () => {
  addTable();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
  render(<View />);
  emit({ wool: 1, grain: 2, ore: 0 }, [card('stuck', {})]);
  expect(shown().grain).toBe(1);
  // The deadline: scrolling, the whole flight, and two seconds of slack.
  await act(() => vi.advanceTimersByTime(350 + CARD_FLIGHT_MS + 2_000));
  expect(shown().grain).toBe(2);
});
