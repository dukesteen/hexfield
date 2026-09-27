// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  waitFor,
  within,
} from '@testing-library/react';
import { createBaseEngine, failure, success } from '@cp2p/engine';
import { getPieceIconUrl } from '@cp2p/renderer';
import type { SessionStatus } from '@cp2p/protocol';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { afterEach, expect, test, vi } from 'vitest';
import { useGameActions } from './GameActions';

const harness = vi.hoisted(() => {
  const state = {
    revealedSeat: 0,
    privateState: {},
    legal: { commands: [] },
    status: null as SessionStatus | null,
    conflicted: false,
    revision: 7,
    placementMode: null,
    placementCancelled: false,
    previewPlacement: null,
    openDialog: null,
    selectedCardSlot: null,
    optionalChoices: [],
    optionalViewingSeat: null,
    closeActionDialog: vi.fn<() => void>(),
  };
  const session: { current: unknown } = { current: null };
  const availability = {
    placements: {
      settlement: [],
      road: [] as { id: string; command: { type: string } }[],
      city: [],
      freeRoad: [],
      robber: [],
    },
    primary: [{ type: 'ROLL_DICE', commands: [{ type: 'ROLL_DICE' }] }],
    availableTypes: ['ROLL_DICE'],
    cardPlays: [],
  };
  const choosePlacement = vi.fn<(kind: string) => void>();
  const openActionDialog = vi.fn<(dialog: string) => void>();
  Object.assign(state, { choosePlacement, openActionDialog });
  const useSessionStore = (selector: (value: typeof state) => unknown) => selector(state);
  useSessionStore.getState = () => state;
  return { state, session, availability, choosePlacement, openActionDialog, useSessionStore };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../store/session-store', () => ({
  useSessionStore: harness.useSessionStore,
  sessionForActions: () => harness.session.current,
}));
vi.mock('../actions/availability', () => ({
  deriveActionAvailability: () => harness.availability,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  harness.session.current = null;
  harness.state.revision = 7;
  harness.state.status = null;
  harness.state.placementCancelled = false;
  harness.state.closeActionDialog.mockClear();
  harness.choosePlacement.mockClear();
  harness.openActionDialog.mockClear();
  harness.availability.placements.road.length = 0;
  harness.availability.primary = [{ type: 'ROLL_DICE', commands: [{ type: 'ROLL_DICE' }] }];
});

test('a certified void removes actions and rejects a command captured before termination', () => {
  const validate = vi.fn<() => void>();
  const submit = vi.fn<() => void>();
  harness.session.current = { validate, submit };
  const state = createBaseEngine().createGame(
    { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1], options: { base: {} } },
    new Uint8Array(32).fill(7),
  );
  const view = renderHook(() =>
    useGameActions(state, [], { players: [], botDelayMs: 0 }, { compact: true }),
  );
  const command = view.result.current.nextStep;
  if (command.kind !== 'command') throw new Error('Expected an action before termination');
  harness.state.status = { kind: 'void' };
  view.rerender();
  expect(view.result.current.nextStep).toEqual({
    kind: 'text',
    tone: 'muted',
    text: 'lobby:onlineGameVoidTitle',
  });
  expect(view.result.current.availability).toBeNull();
  expect(view.result.current.highlights).toEqual({});
  const desktop = render(
    <>
      {view.result.current.desktopStatus}
      {view.result.current.desktopTurn}
    </>,
  );
  expect(desktop.getByRole('status').textContent).toBe('lobby:onlineGameVoidTitle');
  expect(desktop.queryByRole('button')).toBeNull();
  act(() => command.run());
  expect(validate).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

test('desktop controls expose only engine-offered build, trade, and turn actions', () => {
  harness.state.placementCancelled = true;
  harness.availability.placements.road.push({ id: 'e:0,0,W', command: { type: 'BUILD_ROAD' } });
  harness.availability.primary.push({ type: 'MARITIME_TRADE', commands: [] });
  harness.availability.primary.push({ type: 'SKIP', commands: [{ type: 'SKIP' }] });
  const state = createBaseEngine().createGame(
    { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1], options: { base: {} } },
    new Uint8Array(32).fill(7),
  );
  const view = renderHook(() =>
    useGameActions(state, [], {
      players: [
        { seat: 0, name: 'Alice', color: 'red', shape: 'circle' },
        { seat: 1, name: 'Bob', color: 'blue', shape: 'square' },
      ],
      botDelayMs: 0,
    }),
  );
  const controls = render(
    <>
      {view.result.current.desktopBuild}
      {view.result.current.desktopStatus}
      {view.result.current.desktopTrade}
      {view.result.current.desktopTurn}
    </>,
  );
  const road = controls.getByRole('button', { name: 'game:buildAction.road' });
  expect(road.hasAttribute('disabled')).toBe(false);
  expect(road.querySelector('img')?.getAttribute('src')).toBe(getPieceIconUrl('road', 'red'));
  const dock = render(<>{view.result.current.dock}</>);
  expect(
    within(dock.container)
      .getByRole('button', { name: 'game:buildAction.road' })
      .querySelector('img')
      ?.getAttribute('src'),
  ).toBe(getPieceIconUrl('road', 'red'));
  expect(
    controls.container.querySelector('.desktop-build-panel .desktop-context-actions'),
  ).toBeNull();
  expect(
    controls.container.querySelector('.desktop-action-status .desktop-context-actions'),
  ).not.toBeNull();
  expect(
    controls.getByRole('button', { name: 'game:buildAction.settlement' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(
    controls.getByRole('button', { name: 'game:command.BUY_DEV_CARD' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(controls.getByRole('button', { name: 'game:bank' }).hasAttribute('disabled')).toBe(false);
  expect(controls.getByRole('button', { name: 'game:players' }).hasAttribute('disabled')).toBe(
    true,
  );
  const roll = within(controls.container).getByRole('button', { name: /game:command.ROLL_DICE/ });
  expect(roll.hasAttribute('disabled')).toBe(false);
  expect(roll.classList.contains('action-roll-dice')).toBe(true);
  expect(dock.container.querySelector('.action-roll-dice')).not.toBeNull();
  fireEvent.click(road);
  expect(harness.choosePlacement).toHaveBeenCalledWith('road');
  fireEvent.click(controls.getByRole('button', { name: 'game:bank' }));
  expect(harness.openActionDialog).toHaveBeenCalledWith('bank');
  const mobile = render(
    <>
      {view.result.current.mobileBuild}
      {view.result.current.mobileTrade}
    </>,
  );
  const mobileControls = within(mobile.container);
  const mobileRoad = mobileControls.getByRole('button', { name: 'game:buildAction.road' });
  expect(mobile.container.querySelectorAll('.mobile-build-row')).toHaveLength(4);
  expect(mobileRoad.querySelector('.mobile-build-art')?.getAttribute('src')).toBe(
    getPieceIconUrl('road', 'red'),
  );
  expect(mobileRoad.querySelectorAll('.mobile-build-cost img')).toHaveLength(2);
  expect(
    mobileControls.getByRole('button', { name: 'game:buildAction.city' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(
    mobileControls.getByRole('button', { name: 'game:players' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(mobileControls.getByRole('button', { name: 'game:bank' }).hasAttribute('disabled')).toBe(
    false,
  );
  expect(mobileControls.getByRole('button', { name: 'game:command.SKIP' })).toBeDefined();
  fireEvent.click(mobileRoad);
  fireEvent.click(mobileControls.getByRole('button', { name: 'game:bank' }));
  expect(harness.choosePlacement).toHaveBeenCalledTimes(2);
  expect(harness.openActionDialog).toHaveBeenCalledTimes(2);
});

test('pending feedback appears before submit and blocks a duplicate, then rejection clears it', async () => {
  let finish: ((value: ReturnType<typeof failure>) => void) | undefined;
  const submit = vi.fn<() => Promise<ReturnType<typeof failure>>>(
    () =>
      new Promise<ReturnType<typeof failure>>((resolve) => {
        finish = resolve;
      }),
  );
  const validate = vi.fn<() => ReturnType<typeof success>>(() => success(undefined));
  harness.session.current = { validate, submit };
  const state = createBaseEngine().createGame(
    { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1], options: { base: {} } },
    new Uint8Array(32).fill(7),
  );
  const presentation: GamePresentation = { players: [], botDelayMs: 0 };
  const view = renderHook(() => useGameActions(state, [], presentation, { compact: true }));
  expect(view.result.current.nextStep.kind).toBe('command');
  const initialStep = view.result.current.nextStep;
  if (initialStep.kind !== 'command') throw new Error('Expected an action command');
  act(() => {
    initialStep.run();
  });
  expect(view.result.current.submitting).toBe(true);
  expect(view.result.current.nextStep).toEqual({
    kind: 'pending',
    text: 'game:submittingAction',
    turnAction: { label: 'game:command.ROLL_DICE', rollDice: true },
  });
  expect(submit).not.toHaveBeenCalled();
  expect(validate).not.toHaveBeenCalled();
  act(() => {
    initialStep.run();
  });
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit).toHaveBeenCalledWith(0, { type: 'ROLL_DICE' }, { expectedRevision: 7 });
  await act(async () => finish?.(failure('invalid-action', 'Rejected')));
  expect(view.result.current.submitting).toBe(false);
  expect(view.result.current.nextStep).toEqual({
    kind: 'text',
    tone: 'alert',
    text: 'game:invalidAction',
  });
  expect(harness.state.closeActionDialog).not.toHaveBeenCalled();
});

test('a changed revision during the paint delay stops submission even if animation frames pause', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
  const validate = vi.fn<() => ReturnType<typeof success>>(() => success(undefined));
  const submit = vi.fn<() => void>();
  harness.session.current = { validate, submit };
  const state = createBaseEngine().createGame(
    { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1], options: { base: {} } },
    new Uint8Array(32).fill(7),
  );
  const view = renderHook(() =>
    useGameActions(state, [], { players: [], botDelayMs: 0 }, { compact: true }),
  );
  const step = view.result.current.nextStep;
  if (step.kind !== 'command') throw new Error('Expected an action command');
  act(() => step.run());
  harness.state.revision = 8;
  await waitFor(() => expect(view.result.current.submitting).toBe(false));
  expect(validate).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(view.result.current.nextStep).toEqual({
    kind: 'text',
    tone: 'alert',
    text: 'game:staleAction',
  });
});

test('a head change while worker validation is pending prevents stale submit', async () => {
  let finish: ((value: ReturnType<typeof success>) => void) | undefined;
  const validate = vi.fn<() => Promise<ReturnType<typeof success>>>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const submit = vi.fn<() => Promise<ReturnType<typeof success>>>(async () => success(undefined));
  harness.session.current = { mode: 'p2p', validate, submit };
  const state = createBaseEngine().createGame(
    { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1], options: { base: {} } },
    new Uint8Array(32).fill(7),
  );
  const view = renderHook(() =>
    useGameActions(state, [], { players: [], botDelayMs: 0 }, { compact: true }),
  );
  const step = view.result.current.nextStep;
  if (step.kind !== 'command') throw new Error('Expected an action command');
  act(() => step.run());
  await waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
  expect(view.result.current.submitting).toBe(true);
  expect(submit).not.toHaveBeenCalled();
  harness.state.revision = 8;
  await act(async () => finish?.(success(undefined)));
  expect(submit).not.toHaveBeenCalled();
  expect(view.result.current.nextStep).toMatchObject({ kind: 'text', text: 'game:staleAction' });
});
