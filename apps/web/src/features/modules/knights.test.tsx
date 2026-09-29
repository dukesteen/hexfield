// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { BARBARIAN_FIXTURE, createBaseEngine, knightsExt } from '@cp2p/engine';
import type { GameState } from '@cp2p/engine';
import type { BoardRenderer } from '@cp2p/renderer';
import { genesis, presentation, testI18n, withI18n } from '../knights/test-support';
import { BarbarianCountdown, BarbarianDialog } from './knights';

let i18n: Awaited<ReturnType<typeof testI18n>>;
beforeAll(async () => {
  // The view-change callbacks are fired by hand inside act().
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  i18n = await testI18n();
});
afterEach(cleanup);

/** A renderer that only knows whether the track is on screen, and who to tell when that changes. */
function fakeRenderer(visible: { value: boolean }) {
  const listeners = new Set<() => void>();
  const renderer = {
    isFixtureInView: (id: string) => id === BARBARIAN_FIXTURE && visible.value,
    subscribeViewChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    // The countdown reads only these two members of the renderer.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    renderer: renderer as unknown as BoardRenderer,
    changed: () => {
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

function atStep(step: number): GameState {
  const ext = knightsExt(genesis);
  return { ...genesis, ext: { ...genesis.ext, knights: { ...ext, barbarians: { step } } } };
}

function countdown(state: GameState, renderer: BoardRenderer | null) {
  const openFixture = vi.fn<(id: string) => void>();
  const view = withI18n(
    i18n,
    <BarbarianCountdown
      state={state}
      hints={[]}
      presentation={presentation}
      renderer={renderer}
      openFixture={openFixture}
    />,
  );
  return { openFixture, view };
}

test('the countdown stays away while the printed track is on screen', () => {
  const fake = fakeRenderer({ value: true });
  countdown(atStep(2), fake.renderer);
  expect(screen.queryByTestId('barbarian-countdown')).toBeNull();
});

test('it appears when the track scrolls out of view and names the steps left', () => {
  const visible = { value: true };
  const fake = fakeRenderer(visible);
  countdown(atStep(2), fake.renderer);
  visible.value = false;
  act(() => fake.changed());
  const pill = screen.getByTestId('barbarian-countdown');
  expect(pill.textContent).toContain('Barbarians: 5 steps');
  expect(pill.getAttribute('data-urgent')).toBe('false');
});

test('it turns urgent in the last two steps, and says step in the singular', () => {
  const fake = fakeRenderer({ value: false });
  countdown(atStep(6), fake.renderer);
  act(() => fake.changed());
  const pill = screen.getByTestId('barbarian-countdown');
  expect(pill.textContent).toContain('Barbarians: 1 step');
  expect(pill.textContent).not.toContain('steps');
  expect(pill.getAttribute('data-urgent')).toBe('true');
});

test('tapping it opens the track dialog', () => {
  const fake = fakeRenderer({ value: false });
  const { openFixture } = countdown(atStep(1), fake.renderer);
  act(() => fake.changed());
  fireEvent.click(screen.getByTestId('barbarian-countdown'));
  expect(openFixture).toHaveBeenCalledWith(BARBARIAN_FIXTURE);
});

test('it stops listening when it goes away', () => {
  const fake = fakeRenderer({ value: false });
  const { view } = countdown(atStep(1), fake.renderer);
  expect(fake.listeners.size).toBe(1);
  view.unmount();
  expect(fake.listeners.size).toBe(0);
});

test('with no renderer, or in a game without knights, there is no countdown', () => {
  countdown(atStep(1), null);
  expect(screen.queryByTestId('barbarian-countdown')).toBeNull();
  const fake = fakeRenderer({ value: false });
  const base = createBaseEngine().createGame(
    { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1], options: {} },
    new Uint8Array(32),
  );
  countdown(base, fake.renderer);
  act(() => fake.changed());
  expect(screen.queryByTestId('barbarian-countdown')).toBeNull();
});

test('the track dialog shows the odds and who would hold the line', () => {
  const onClose = vi.fn<() => void>();
  withI18n(
    i18n,
    <BarbarianDialog state={atStep(3)} hints={[]} presentation={presentation} onClose={onClose} />,
  );
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('Landing in 4 steps.');
  expect(dialog.querySelector('li[data-here="true"]')?.textContent).toBe('3');
  // A board with no cities has nothing for the barbarians to take.
  expect(screen.getByRole('status').textContent).toContain('would hold the line');
  expect(screen.getAllByRole('row')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledOnce();
});
