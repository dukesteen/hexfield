// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import type { BoardRenderer } from '@cp2p/renderer';
import type { Seat } from '@cp2p/engine';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CardFlight } from './card-flights';
import { heldHand, useCardHolds } from './card-holds';
import { useStealReveal } from './steal-reveal';
import type { VisualEffects } from './visual-effects';
import { CARD_LANDS_MS, useVisualEffects } from './use-visual-effects.js';

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
  for (const seat of [1, 2]) {
    const panel = document.createElement('aside');
    panel.dataset.seatPanel = String(seat);
    setRect(panel, 600, 50 * seat);
    document.body.append(panel);
  }
  document.body.append(dock);
}

/** Seat 1 holds 4 cards and seat 2 holds 9 before the steal. */
const table = {
  config: { seats: [0, 1, 2] },
  turn: { phase: [{ id: 'main' }] },
  seats: [
    { seat: 0, resources: { total: 2 } },
    { seat: 1, resources: { total: 4 } },
    { seat: 2, resources: { total: 9 } },
  ],
};

let publish: ((update: unknown) => void) | null = null;
let revision = 0;

function emit(
  hand: Record<string, number>,
  cardFlights: readonly CardFlight[],
  events: readonly unknown[] = [{ type: 'resourceStolen' }],
) {
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
      state: table,
      events,
      pending: [],
      timers: [],
      status: { kind: 'running' },
    }),
  );
}

function stolen(id: string, from: Seat, face: string): CardFlight {
  return { id: `${id}:steal:${face}`, from, to: 0, face, count: 1, private: true };
}

function View({ pick, reducedMotion = false }: { pick: boolean; reducedMotion?: boolean }) {
  const { overlay } = useVisualEffects(renderer, reducedMotion, pick);
  return <>{overlay}</>;
}

const shownOre = () => heldHand(mock.hand, useCardHolds.getState().holds, 0).ore;
const frame = () => act(() => vi.advanceTimersByTime(16));

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((run) =>
    window.setTimeout(() => run(Date.now()), 16),
  );
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => window.clearTimeout(id));
  vi.setSystemTime(0);
  mock.hand = { wool: 1, grain: 1, ore: 0 };
  revision = 0;
  mock.session = {
    getState: () => table,
    getPrivate: (seat: number) => (seat === 0 ? { hand: { ...mock.hand } } : null),
    subscribe: (listener: (update: unknown) => void) => {
      publish = listener;
      return () => {
        publish = null;
      };
    },
  };
  addTable();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  useStealReveal.getState().reset();
  useCardHolds.getState().clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('with the sheet, a stolen card waits on it face down and flies on from where it turned', async () => {
  render(<View pick />);
  useStealReveal.getState().open(0, 1, 4);
  useStealReveal.getState().pick(2);
  emit({ wool: 1, grain: 1, ore: 1 }, [stolen('5:0', 1, 'ore')]);
  await frame();
  // Nothing flies yet: the sheet has the result, and the hand still shows the old count.
  expect(document.querySelector('.trade-card-flight')).toBeNull();
  expect(useStealReveal.getState().active).toMatchObject({ picked: 2, face: 'ore' });
  expect(shownOre()).toBe(0);
  // The thief takes a while to look: the count still waits (a pinned hold, not a flight's).
  await act(() => vi.advanceTimersByTime(10_000));
  expect(shownOre()).toBe(0);
  const done = useStealReveal.getState().finish();
  act(() => done?.launch?.({ x: 300, y: 200 }));
  const flight = document.querySelector<HTMLElement>('.trade-card-flight[data-card="ore"]');
  expect(flight?.style.left).toBe('300px');
  // Already face up: it does not turn over again.
  expect(flight?.classList.contains('steal-reveal-flight')).toBe(false);
  // It lands on the ore slot (195, 420), and the count ticks up then.
  expect(flight?.style.getPropertyValue('--flight-dx')).toBe('-105px');
  expect(shownOre()).toBe(0);
  await act(() => vi.advanceTimersByTime(CARD_LANDS_MS));
  expect(shownOre()).toBe(1);
});

test('without the sheet, the stolen card leaves the victim face down and turns over in flight', async () => {
  render(<View pick={false} />);
  emit({ wool: 1, grain: 1, ore: 1 }, [stolen('5:0', 1, 'ore')]);
  expect(useStealReveal.getState().active).toBeNull();
  expect(useStealReveal.getState().announced).toMatchObject({ victim: 1, face: 'ore' });
  await frame();
  const flight = document.querySelector<HTMLElement>('.trade-card-flight[data-card="ore"]');
  expect(flight?.classList.contains('steal-reveal-flight')).toBe(true);
  expect(flight?.querySelector('.steal-reveal-back')).not.toBeNull();
  expect(flight?.querySelector('.steal-reveal-face')).not.toBeNull();
  // From seat 1's panel (615, 70).
  expect(flight?.style.left).toBe('615px');
});

test('a Bishop robbing two seats shows them one after the other, each from its own hand size', async () => {
  render(<View pick />);
  mock.hand = { wool: 1, grain: 1, ore: 0 };
  emit(
    { wool: 1, grain: 2, ore: 1 },
    [stolen('7:0', 1, 'ore'), stolen('7:1', 2, 'grain')],
    [
      { type: 'progressCardPlayed', seat: 0, card: 'bishop' },
      { type: 'resourceStolen' },
      { type: 'resourceStolen' },
    ],
  );
  await frame();
  expect(document.querySelector('.trade-card-flight')).toBeNull();
  expect(useStealReveal.getState().active).toMatchObject({ victim: 1, handSize: 4, face: 'ore' });
  expect(useStealReveal.getState().queue).toMatchObject([
    { victim: 2, handSize: 9, face: 'grain' },
  ]);
  const holds = heldHand(mock.hand, useCardHolds.getState().holds, 0);
  expect(holds).toMatchObject({ ore: 0, grain: 1 });
  // A later update's flights do not drop the cards still waiting on the sheet.
  emit({ wool: 2, grain: 2, ore: 1 }, [
    { id: 'bank', from: 'bank', to: 0, face: 'wool', count: 1, private: true },
  ]);
  expect(heldHand(mock.hand, useCardHolds.getState().holds, 0)).toMatchObject({
    ore: 0,
    grain: 1,
  });
  const first = useStealReveal.getState().finish();
  expect(useStealReveal.getState().active?.victim).toBe(2);
  act(() => first?.launch?.(null));
  expect(heldHand(mock.hand, useCardHolds.getState().holds, 0)).toMatchObject({
    ore: 1,
    grain: 1,
  });
});

test('with the sheet on, a steal the thief did not make there (a timeout) just flies', async () => {
  render(<View pick />);
  emit({ wool: 1, grain: 1, ore: 1 }, [stolen('5:0', 1, 'ore')]);
  expect(useStealReveal.getState().active).toBeNull();
  await frame();
  expect(document.querySelector('.steal-reveal-flight[data-card="ore"]')).not.toBeNull();
});

test('reduced motion: the sheet still shows the result, with no hold and no flight', async () => {
  render(<View pick reducedMotion />);
  useStealReveal.getState().open(0, 2, 9);
  useStealReveal.getState().pick(0);
  emit({ wool: 1, grain: 1, ore: 1 }, [stolen('5:0', 2, 'ore')]);
  expect(useStealReveal.getState().active?.face).toBe('ore');
  expect(useCardHolds.getState().holds).toEqual([]);
  act(() => useStealReveal.getState().finish()?.launch?.(null));
  await frame();
  expect(document.querySelector('.trade-card-flight')).toBeNull();
});
