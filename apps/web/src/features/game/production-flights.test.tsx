// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Seat } from '@cp2p/engine';
import {
  type BoardAppearance,
  type BoardEffect,
  type BoardFocusPreview,
  type BoardHighlights,
  type BoardHit,
  type BoardRenderer,
  type BoardRendererDiagnostics,
  DICE_ROLL_DURATION_MS,
  PRODUCTION_TOKEN_PULSE_MS,
  type RenderModel,
  type ScreenPoint,
  getResourceCardUrl,
} from '@cp2p/renderer';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProductionGain, ResourceFlight, VisualEffects } from './visual-effects';
import { useVisualEffects } from './use-visual-effects.js';

const sessionMock = vi.hoisted(() => ({
  current: null as unknown,
  revealedSeat: 0,
}));
const effectsMock = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../../store/session-store', () => ({
  sessionForActions: () => sessionMock.current,
  useSessionStore: { getState: () => ({ revealedSeat: sessionMock.revealedSeat }) },
}));

vi.mock('./visual-effects', () => ({
  deriveVisualEffects: () => effectsMock.current,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  sessionMock.revealedSeat = 0;
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('.hand-dock, [data-seat-panel]').forEach((element) => element.remove());
  sessionMock.current = null;
  effectsMock.current = null;
  vi.useRealTimers();
});

function setEffects(
  flights: readonly ResourceFlight[],
  productionGains: readonly ProductionGain[] = [],
) {
  effectsMock.current = {
    board: [],
    flights,
    cardFlights: [],
    productionGains,
  } satisfies VisualEffects;
}

function flight(id: string, seat: Seat, resource: ResourceFlight['resource']): ResourceFlight {
  return { id, seat, resource, count: 1, fromHex: 'h:0,0' };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

function setRect(element: HTMLElement, bounds: DOMRect) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => bounds,
  });
}

function addHandCard(resource: string, bounds: DOMRect) {
  const hand = document.createElement('section');
  hand.className = 'hand-dock';
  const card = document.createElement('div');
  card.dataset.resource = resource;
  const image = document.createElement('img');
  setRect(image, bounds);
  card.append(image);
  hand.append(card);
  document.body.append(hand);
  return image;
}

function addSeatPanel(seat: Seat, bounds: DOMRect) {
  const panel = document.createElement('aside');
  panel.dataset.seatPanel = String(seat);
  setRect(panel, bounds);
  document.body.append(panel);
  return panel;
}

function setupSession() {
  let publish: ((update: unknown) => void) | null = null;
  const makeSession = () => ({
    getState: () => ({ config: { seats: [] } }),
    getPrivate: () => null,
    subscribe: (listener: (update: unknown) => void) => {
      publish = listener;
      return () => {
        publish = null;
      };
    },
  });
  sessionMock.current = makeSession();
  const emit = () => {
    if (!publish) throw new Error('Expected the visual-effects subscription');
    act(() =>
      publish?.({
        revision: 1,
        state: { config: { seats: [] } },
        events: [{ type: 'diceRolled' }],
        pending: [],
        timers: [],
        status: { kind: 'running' },
      }),
    );
  };
  return { emit, makeSession };
}

const point = { x: 10, y: 20 } satisfies ScreenPoint;
const skipAnimations = vi.fn<() => void>();
const renderer: BoardRenderer = {
  render: (_model: RenderModel) => undefined,
  setHighlights: (_highlights: BoardHighlights) => undefined,
  setFocusTarget: (_hit: BoardHit | null, _preview?: BoardFocusPreview) => undefined,
  setAppearance: (_appearance: BoardAppearance) => undefined,
  setReducedMotion: (_reduced: boolean) => undefined,
  setDebugIslands: (_enabled: boolean) => undefined,
  playEffects: (_effects: readonly BoardEffect[]) => undefined,
  skipAnimations,
  getDiagnostics: (): BoardRendererDiagnostics => ({
    renderedFrames: 0,
    rebuiltLayers: 0,
    activeEffects: 0,
    queuedDisposals: 0,
  }),
  setHarborLabelFormatter: (_formatter: (kind: string) => string) => undefined,
  hitTest: (_clientPoint: ScreenPoint) => null,
  subscribeViewChange: (_listener: () => void) => () => undefined,
  getPixelPosition: (_hit: BoardHit) => point,
  boardToScreen: (boardPoint: ScreenPoint) => boardPoint,
  screenToBoard: (clientPoint: ScreenPoint) => clientPoint,
  fitToBoard: () => undefined,
  isFixtureInView: () => false,
  destroy: () => undefined,
};

function EffectsView({ reducedMotion = false }: { reducedMotion?: boolean }) {
  const { overlay, receipts, skip } = useVisualEffects(renderer, reducedMotion);
  return (
    <>
      {overlay}
      <output data-testid="receipts">
        {receipts.map(({ seat, resources }) => `${seat}:${JSON.stringify(resources)}`).join(';')}
      </output>
      <button type="button" onClick={skip}>
        Skip
      </button>
    </>
  );
}

test('waits for dice and production pulses, then flies each card to its matching destination', async () => {
  const handImage = addHandCard('grain', rect(100, 120, 24, 36));
  addSeatPanel(0, rect(500, 500, 40, 40));
  addSeatPanel(1, rect(200, 240, 40, 20));
  const gains: ProductionGain[] = [
    { id: 'gain-local', seat: 0, resources: { grain: 1 } },
    { id: 'gain-other', seat: 1, resources: { brick: 1 } },
  ];
  setEffects([flight('local-grain', 0, 'grain'), flight('other-brick', 1, 'brick')], gains);
  const { emit } = setupSession();
  render(<EffectsView />);

  emit();
  expect(screen.getByTestId('receipts').textContent).toContain('0:{"grain":1}');
  expect(document.querySelector('.resource-flight')).toBeNull();

  await act(() => vi.advanceTimersByTime(DICE_ROLL_DURATION_MS + PRODUCTION_TOKEN_PULSE_MS - 1));
  expect(document.querySelector('.resource-flight')).toBeNull();

  await act(() => vi.advanceTimersByTime(1));
  const localFlight = document.querySelector<HTMLElement>('.resource-flight');
  expect(localFlight).not.toBeNull();
  expect(localFlight?.querySelector('img')?.getAttribute('src')).toBe(getResourceCardUrl('grain'));
  expect(localFlight?.style.left).toBe('10px');
  expect(localFlight?.style.top).toBe('20px');
  expect(localFlight?.style.getPropertyValue('--flight-dx')).toBe('102px');
  expect(localFlight?.style.getPropertyValue('--flight-dy')).toBe('118px');
  expect(handImage.isConnected).toBe(true);

  await act(() => vi.advanceTimersByTime(139));
  expect(document.querySelectorAll('.resource-flight')).toHaveLength(1);
  await act(() => vi.advanceTimersByTime(1));
  const otherFlight = [...document.querySelectorAll<HTMLElement>('.resource-flight')].find(
    (element) => element.querySelector('img')?.getAttribute('src') === getResourceCardUrl('brick'),
  );
  expect(otherFlight?.style.getPropertyValue('--flight-dx')).toBe('210px');
  expect(otherFlight?.style.getPropertyValue('--flight-dy')).toBe('230px');
});

test('scrolls a clipped revealed hand card into view before falling back to its player panel', async () => {
  const handImage = addHandCard('grain', rect(window.innerWidth + 100, 120, 24, 36));
  const scrollIntoView = vi.fn<() => void>();
  handImage.scrollIntoView = scrollIntoView;
  addSeatPanel(0, rect(80, 100, 20, 30));
  setEffects([flight('clipped-grain', 0, 'grain')]);
  const { emit } = setupSession();
  render(<EffectsView />);

  emit();
  await act(() => vi.advanceTimersByTime(DICE_ROLL_DURATION_MS + PRODUCTION_TOKEN_PULSE_MS));
  expect(scrollIntoView).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'nearest',
    inline: 'nearest',
  });
  expect(document.querySelector('.resource-flight')).toBeNull();

  await act(() => vi.advanceTimersByTime(349));
  expect(document.querySelector('.resource-flight')).toBeNull();
  await act(() => vi.advanceTimersByTime(1));
  const launchedFlight = document.querySelector<HTMLElement>('.resource-flight');
  expect(launchedFlight?.style.getPropertyValue('--flight-dx')).toBe('80px');
  expect(launchedFlight?.style.getPropertyValue('--flight-dy')).toBe('95px');
});

test.each(['skip', 'reduced motion', 'session replacement', 'unmount'] as const)(
  'cancels queued production flights on %s',
  async (reason) => {
    setEffects([flight('pending-grain', 0, 'grain')]);
    const { emit, makeSession } = setupSession();
    const view = render(<EffectsView />);
    emit();
    // The launch and the safety deadline of the count it holds back.
    expect(vi.getTimerCount()).toBe(2);

    if (reason === 'skip') fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    if (reason === 'reduced motion') view.rerender(<EffectsView reducedMotion />);
    if (reason === 'session replacement') {
      sessionMock.current = makeSession();
      view.rerender(<EffectsView />);
    }
    if (reason === 'unmount') view.unmount();

    expect(vi.getTimerCount()).toBe(0);
    await act(() =>
      vi.advanceTimersByTime(DICE_ROLL_DURATION_MS + PRODUCTION_TOKEN_PULSE_MS + 350),
    );
    expect(document.querySelector('.resource-flight')).toBeNull();
  },
);
