// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import rules from '../../i18n/locales/en/rules.json';
import game from '../../i18n/locales/en/game.json';
import {
  StealSheet,
  STEAL_FLIP_MS,
  STEAL_REDUCED_HOLD_MS,
  STEAL_REVEAL_HOLD_MS,
} from './StealSheet';
import { STEAL_FAN_MAX, useStealReveal, type StealReveal } from './steal-reveal';

function nth(list: readonly HTMLElement[], index: number): HTMLElement {
  const item = list[index];
  if (!item) throw new Error(`No element at ${index}`);
  return item;
}

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { rules, game } }, initImmediate: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useStealReveal.getState().reset();
});

function reveal(partial: Partial<StealReveal> = {}): StealReveal {
  return {
    id: 'r',
    thief: 0,
    victim: 2,
    handSize: 7,
    picked: null,
    face: null,
    launch: null,
    ...partial,
  };
}

function sheet(
  value: StealReveal,
  handlers: {
    onPick?: (index: number) => void;
    onDone?: (from: { x: number; y: number } | null) => void;
    reducedMotion?: boolean;
  } = {},
) {
  return (
    <I18nextProvider i18n={i18n}>
      <StealSheet
        reveal={value}
        victimName="Bob"
        victimColor="orange"
        reducedMotion={handlers.reducedMotion ?? false}
        onPick={handlers.onPick ?? (() => {})}
        onDone={handlers.onDone ?? (() => {})}
      />
    </I18nextProvider>
  );
}

test('the sheet fans the victim hand face down, one back per public card', () => {
  render(sheet(reveal()));
  expect(screen.getByRole('dialog', { name: 'Steal a card' })).toBeTruthy();
  const cards = screen.getAllByRole('button', { name: /face down/ });
  expect(cards).toHaveLength(7);
  expect(cards[2]?.getAttribute('aria-label')).toBe('Card 3 of 7, face down');
  expect(screen.getByText('Bob')).toBeTruthy();
  expect(screen.getByText('7 cards')).toBeTruthy();
  // No face exists anywhere before the fair result is in.
  expect(document.querySelector('.steal-card-face')).toBeNull();
});

test('a big hand fans the first backs and counts the rest', () => {
  render(sheet(reveal({ handSize: 20 })));
  expect(screen.getAllByRole('button', { name: /face down/ })).toHaveLength(STEAL_FAN_MAX);
  expect(screen.getByLabelText('and 8 more cards').textContent).toBe('+8');
  expect(screen.getByText('20 cards')).toBeTruthy();
});

test('arrow keys move between the backs and a tap picks one', () => {
  const onPick = vi.fn<(index: number) => void>();
  render(sheet(reveal({ handSize: 4 }), { onPick }));
  const cards = screen.getAllByRole('button', { name: /face down/ });
  expect(cards.map((card) => card.tabIndex)).toEqual([0, -1, -1, -1]);
  cards[0]?.focus();
  fireEvent.keyDown(nth(cards, 0), { key: 'ArrowRight' });
  expect(document.activeElement).toBe(cards[1]);
  fireEvent.keyDown(nth(cards, 1), { key: 'End' });
  expect(document.activeElement).toBe(cards[3]);
  fireEvent.keyDown(nth(cards, 3), { key: 'ArrowRight' });
  expect(document.activeElement).toBe(cards[0]);
  fireEvent.keyDown(nth(cards, 0), { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(cards[3]);
  fireEvent.click(nth(cards, 3));
  expect(onPick).toHaveBeenCalledWith(3);
});

test('a picked back waits for the result, then turns over, announces it and hands off', () => {
  vi.useFakeTimers();
  const onPick = vi.fn<(index: number) => void>();
  const onDone = vi.fn<(from: { x: number; y: number } | null) => void>();
  const view = render(sheet(reveal({ picked: 2 }), { onPick, onDone }));
  const picked = nth(screen.getAllByRole('button'), 2);
  expect(picked.className).toContain('is-pending');
  expect(screen.getByRole('status').textContent).toBe('Drawing a card at random…');
  // Once picked, no other back can be picked.
  fireEvent.click(nth(screen.getAllByRole('button'), 0));
  expect(onPick).not.toHaveBeenCalled();

  view.rerender(sheet(reveal({ picked: 2, face: 'ore' }), { onPick, onDone }));
  act(() => {
    vi.advanceTimersByTime(20);
  });
  expect(picked.className).toContain('is-turned');
  expect(picked.getAttribute('aria-label')).toBe('Card 3 of 7, Ore');
  expect(screen.getByRole('status').textContent).toBe('You stole 1 Ore from Bob');
  expect(document.querySelector('.steal-card-face')).not.toBeNull();
  act(() => {
    vi.advanceTimersByTime(STEAL_FLIP_MS + STEAL_REVEAL_HOLD_MS - 100);
  });
  expect(onDone).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(200);
  });
  expect(onDone).toHaveBeenCalledTimes(1);
});

test('reduced motion shows the face at once and closes with no flight', () => {
  vi.useFakeTimers();
  const onDone = vi.fn<(from: { x: number; y: number } | null) => void>();
  render(sheet(reveal({ picked: 0, face: 'grain' }), { onDone, reducedMotion: true }));
  expect(screen.getAllByRole('button')[0]?.className).toContain('is-turned');
  expect(document.querySelector('.steal-sheet-still')).not.toBeNull();
  act(() => {
    vi.advanceTimersByTime(STEAL_REDUCED_HOLD_MS);
  });
  expect(onDone).toHaveBeenCalledWith(null);
});

test('a result fills the open steal of its victim, whatever back was tapped', () => {
  const store = useStealReveal.getState();
  store.open(0, 2, 5);
  store.pick(9); // Out of range: ignored.
  expect(useStealReveal.getState().active?.picked).toBeNull();
  store.pick(4);
  store.pick(1); // A second tap changes nothing.
  expect(useStealReveal.getState().active?.picked).toBe(4);
  const launch = vi.fn<(from: unknown) => void>();
  // Another victim's result is not this sheet's.
  expect(store.offer({ thief: 0, victim: 1, handSize: 3, face: 'wool', launch }, false)).toBe(
    false,
  );
  expect(store.offer({ thief: 0, victim: 2, handSize: 5, face: 'ore', launch }, false)).toBe(true);
  expect(useStealReveal.getState().active).toMatchObject({ picked: 4, face: 'ore' });
  expect(useStealReveal.getState().finish()?.launch).toBe(launch);
  expect(useStealReveal.getState().active).toBeNull();
});

test('a Bishop robs seat after seat: each result waits its turn on the sheet', () => {
  const store = useStealReveal.getState();
  const first = vi.fn<(from: unknown) => void>();
  const second = vi.fn<(from: unknown) => void>();
  expect(
    store.offer({ thief: 0, victim: 1, handSize: 4, face: 'brick', launch: first }, true),
  ).toBe(true);
  expect(
    store.offer({ thief: 0, victim: 3, handSize: 2, face: 'coin', launch: second }, true),
  ).toBe(true);
  expect(useStealReveal.getState().active).toMatchObject({
    victim: 1,
    face: 'brick',
    picked: null,
  });
  expect(useStealReveal.getState().queue).toHaveLength(1);
  useStealReveal.getState().pick(3);
  expect(useStealReveal.getState().finish()?.victim).toBe(1);
  expect(useStealReveal.getState().active).toMatchObject({ victim: 3, face: 'coin', handSize: 2 });
  // Resetting lands whatever is still waiting, so no count stays held back.
  useStealReveal.getState().reset();
  expect(second).toHaveBeenCalledWith(null);
  expect(useStealReveal.getState().active).toBeNull();
});

test('with the setting off an unexpected steal is not held for a sheet', () => {
  const launch = vi.fn<(from: unknown) => void>();
  expect(
    useStealReveal
      .getState()
      .offer({ thief: 0, victim: 1, handSize: 4, face: 'ore', launch }, false),
  ).toBe(false);
  expect(useStealReveal.getState().active).toBeNull();
});
