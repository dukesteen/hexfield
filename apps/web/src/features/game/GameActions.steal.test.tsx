// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createBaseEngine, exactResourceBounds, success } from '@cp2p/engine';
import type { CommandShape, GameState, Seat } from '@cp2p/engine';
import { afterEach, expect, test, vi } from 'vitest';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { useGameActions } from './GameActions';
import { useStealReveal } from './steal-reveal';

function nth(list: readonly HTMLElement[], index: number): HTMLElement {
  const item = list[index];
  if (!item) throw new Error(`No element at ${index}`);
  return item;
}

const harness = vi.hoisted(() => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- vi.hoisted runs before imports.
  const steal = (victim: number) => ({ type: 'STEAL', victim });
  const state = {
    revealedSeat: 0,
    privateState: {},
    legal: { commands: [steal(2)], templates: [] as never[] },
    status: null,
    conflicted: false,
    revision: 3,
    placementMode: null,
    placementCancelled: false,
    previewPlacement: null,
    shipMoveFrom: null,
    openDialog: null,
    selectedCardSlot: null,
    optionalChoices: [],
    optionalViewingSeat: null,
    closeActionDialog: () => {},
  };
  const availability = {
    placements: new Proxy({}, { get: () => [] }),
    primary: [] as { type: string; commands: unknown[] }[],
    availableTypes: ['STEAL'],
    cardPlays: [],
    progressPlays: [],
    improvements: [],
    templates: [],
    stealTargets: [] as { seat: number; command: unknown }[],
  };
  const session: { current: unknown } = { current: null };
  const useSessionStore = (selector: (value: typeof state) => unknown) => selector(state);
  useSessionStore.getState = () => state;
  return { state, availability, session, useSessionStore, steal };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));
vi.mock('../../store/session-store', () => ({
  useSessionStore: harness.useSessionStore,
  sessionForActions: () => harness.session.current,
}));
vi.mock('../actions/availability', () => ({
  deriveActionAvailability: () => harness.availability,
}));

afterEach(() => {
  cleanup();
  useStealReveal.getState().reset();
  harness.session.current = null;
  harness.availability.availableTypes = ['STEAL'];
});

const presentation: GamePresentation = {
  players: [
    { seat: 0, name: 'Alice', color: 'red', shape: 'circle' },
    { seat: 1, name: 'Cy', color: 'green', shape: 'square' },
    { seat: 2, name: 'Bob', color: 'orange', shape: 'triangle' },
  ],
  botDelayMs: 0,
};

/** A game where seat 1 holds 3 cards and seat 2 holds 6, and seat 0 must steal. */
function hand(brick: number) {
  const bounds = exactResourceBounds({ brick, lumber: 0, wool: 0, grain: 0, ore: 0 });
  if (!bounds.ok) throw new Error(bounds.error.message);
  return bounds.value;
}

function game(): GameState {
  const state = createBaseEngine().createGame(
    { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1, 2], options: { base: {} } },
    new Uint8Array(32).fill(7),
  );
  return {
    ...state,
    seats: state.seats.map((seat) =>
      seat.seat === 1
        ? { ...seat, resources: hand(3) }
        : seat.seat === 2
          ? { ...seat, resources: hand(6) }
          : seat,
    ),
  };
}

function setVictims(victims: readonly Seat[]) {
  const commands = victims.map((victim) => harness.steal(victim));
  harness.state.legal = { commands, templates: [] };
  harness.availability.primary = [{ type: 'STEAL', commands }];
  harness.availability.stealTargets = commands.map((command) => ({
    seat: command.victim,
    command,
  }));
  return commands;
}

function Forms({ state, pick }: { state: GameState; pick: boolean }) {
  const actions = useGameActions(state, [], presentation, { pickStealCard: pick });
  return <>{actions.forms}</>;
}

function mockSession() {
  const submit = vi.fn<(seat: Seat, command: CommandShape, options: unknown) => unknown>(() =>
    Promise.resolve(success(undefined)),
  );
  harness.session.current = { validate: () => success(undefined), submit };
  return submit;
}

/* eslint-disable no-await-in-loop -- Each pick runs its own steal after the previous one. */
test('picking a card submits only the victim: every back sends the same command', async () => {
  const sent: unknown[] = [];
  for (const index of [0, 5]) {
    const [steal] = setVictims([2]);
    const submit = mockSession();
    const view = render(<Forms state={game()} pick />);
    // One victim: its hand opens at once, one back per public card.
    const cards = await screen.findAllByRole('button', { name: /cardFaceDown/ });
    expect(cards).toHaveLength(6);
    fireEvent.click(nth(cards, index));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const [seat, command, options] = submit.mock.calls[0] ?? [];
    expect(seat).toBe(0);
    // The engine's own legal command, untouched: no index, no extra field.
    expect(command).toBe(steal);
    expect(command).toEqual({ type: 'STEAL', victim: 2 });
    expect(options).toEqual({ expectedRevision: 3 });
    expect(JSON.stringify(submit.mock.calls)).not.toContain('picked');
    expect(useStealReveal.getState().active?.picked).toBe(index);
    sent.push(submit.mock.calls[0]);
    view.unmount();
    useStealReveal.getState().reset();
  }
  expect(sent[0]).toEqual(sent[1]);
});

test('the fair result turns the tapped back over, then the sheet closes and the card flies', async () => {
  setVictims([2]);
  mockSession();
  const view = render(<Forms state={game()} pick />);
  const cards = await screen.findAllByRole('button', { name: /cardFaceDown/ });
  fireEvent.click(nth(cards, 1));
  await waitFor(() => expect(useStealReveal.getState().active?.picked).toBe(1));
  // The steal was made: the engine no longer offers it while the result is drawn.
  setVictims([]);
  harness.availability.availableTypes = [];
  view.rerender(<Forms state={game()} pick />);
  expect(screen.getByRole('dialog')).toBeTruthy();
  const launch = vi.fn<(from: unknown) => void>();
  act(() => {
    useStealReveal
      .getState()
      .offer({ thief: 0, victim: 2, handSize: 6, face: 'wool', launch }, true);
  });
  await waitFor(() =>
    expect(screen.getAllByRole('button')[1]?.getAttribute('aria-label')).toContain('cardFaceUp'),
  );
  await waitFor(() => expect(launch).toHaveBeenCalledTimes(1), { timeout: 3000 });
  expect(useStealReveal.getState().active).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('with several victims the thief chooses one first, and may go back', async () => {
  const [, toBob] = setVictims([1, 2]);
  const submit = mockSession();
  render(<Forms state={game()} pick />);
  fireEvent.click(screen.getByRole('button', { name: /"player":"Bob"/ }));
  expect(await screen.findAllByRole('button', { name: /cardFaceDown/ })).toHaveLength(6);
  fireEvent.click(screen.getByRole('button', { name: 'rules:steal.back' }));
  fireEvent.click(await screen.findByRole('button', { name: /"player":"Cy"/ }));
  expect(await screen.findAllByRole('button', { name: /cardFaceDown/ })).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'rules:steal.back' }));
  fireEvent.click(await screen.findByRole('button', { name: /"player":"Bob"/ }));
  fireEvent.click(nth(await screen.findAllByRole('button', { name: /cardFaceDown/ }), 2));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0]?.[1]).toBe(toBob);
});

test('with the setting off, choosing the victim steals at once and shows no sheet', async () => {
  const [steal] = setVictims([2]);
  const submit = mockSession();
  render(<Forms state={game()} pick={false} />);
  fireEvent.click(screen.getByRole('button', { name: /"player":"Bob"/ }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0]?.[1]).toBe(steal);
  expect(screen.queryByRole('button', { name: /cardFaceDown/ })).toBeNull();
  expect(useStealReveal.getState().active).toBeNull();
});

test('a steal no sheet showed is still announced', () => {
  setVictims([]);
  harness.availability.availableTypes = [];
  render(<Forms state={game()} pick={false} />);
  act(() => useStealReveal.getState().announce('x', 2, 'ore'));
  expect(document.querySelector('.steal-announcer')?.textContent).toContain('rules:steal.stole');
  expect(document.querySelector('.steal-announcer')?.textContent).toContain('"player":"Bob"');
});
