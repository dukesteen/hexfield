// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createBaseEngine, failure, success } from '@cp2p/engine';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { afterEach, expect, test, vi } from 'vitest';
import { useGameActions } from './GameActions';

const harness = vi.hoisted(() => {
  const state = {
    revealedSeat: 0,
    privateState: {},
    legal: { commands: [] },
    status: null,
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
  const useSessionStore = (selector: (value: typeof state) => unknown) => selector(state);
  useSessionStore.getState = () => state;
  return { state, session, useSessionStore };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../store/session-store', () => ({
  useSessionStore: harness.useSessionStore,
  sessionForActions: () => harness.session.current,
}));
vi.mock('../actions/availability', () => ({
  deriveActionAvailability: () => ({
    placements: { settlement: [], road: [], city: [], freeRoad: [], robber: [] },
    primary: [{ type: 'ROLL_DICE', commands: [{ type: 'ROLL_DICE' }] }],
    availableTypes: ['ROLL_DICE'],
    cardPlays: [],
  }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  harness.session.current = null;
  harness.state.revision = 7;
  harness.state.closeActionDialog.mockClear();
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
  expect(view.result.current.nextStep).toEqual({ kind: 'pending', text: 'game:submittingAction' });
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
