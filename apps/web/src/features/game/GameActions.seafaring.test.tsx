// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, waitFor, within } from '@testing-library/react';
import { createBaseEngine, success } from '@cp2p/engine';
import type { CommandShape, GameState } from '@cp2p/engine';
import type { PlacementChoice } from '../actions/availability';
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
    placementMode: null as string | null,
    placementCancelled: false,
    previewPlacement: null,
    shipMoveFrom: null as string | null,
    openDialog: null,
    selectedCardSlot: null,
    optionalChoices: [],
    optionalViewingSeat: null,
    closeActionDialog: vi.fn<() => void>(),
    choosePlacement: vi.fn<(kind: string) => void>(),
    cancelPlacement: vi.fn<() => void>(),
    clearPlacementCandidate: vi.fn<() => void>(),
    selectPlacementCandidate: vi.fn<(candidate: unknown) => void>(),
    selectShipToMove: vi.fn<(edge: string | null) => void>(),
    openActionDialog: vi.fn<(dialog: string) => void>(),
  };
  const session: { current: unknown } = { current: null };
  const placements = {
    settlement: [] as unknown[],
    road: [] as unknown[],
    city: [] as unknown[],
    freeRoad: [] as unknown[],
    robber: [] as unknown[],
    ship: [] as unknown[],
    freeShip: [] as unknown[],
    pirate: [] as unknown[],
    moveShip: [] as unknown[],
  };
  const availability = {
    placements,
    primary: [] as unknown[],
    availableTypes: [] as string[],
    cardPlays: [] as unknown[],
  };
  const useSessionStore = (selector: (value: typeof state) => unknown) => selector(state);
  useSessionStore.getState = () => state;
  return { state, session, availability, placements, useSessionStore };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values && 'count' in values ? `${key}:${String(values.count)}` : key,
  }),
}));
vi.mock('../../store/session-store', () => ({
  useSessionStore: harness.useSessionStore,
  sessionForActions: () => harness.session.current,
}));
vi.mock('../actions/availability', () => ({
  deriveActionAvailability: () => harness.availability,
}));

const base = createBaseEngine().createGame(
  { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1], options: { base: {} } },
  new Uint8Array(32).fill(7),
);
/** A base game dressed as a seafaring one: its board has a ship list, and the phase is chosen. */
function seaState(phase: string): GameState {
  return {
    ...base,
    board: { ...base.board, ships: [] },
    turn: { ...base.turn, phase: [{ id: phase, module: 'base', data: null }] },
  };
}
const presentation: GamePresentation = {
  players: [
    { seat: 0, name: 'Alice', color: 'red', shape: 'circle' },
    { seat: 1, name: 'Bob', color: 'blue', shape: 'square' },
  ],
  botDelayMs: 0,
};
const choice = (
  type: string,
  id: string,
  extra: Record<string, unknown> = {},
): PlacementChoice => ({
  id,
  type,
  command: { type, ...extra },
  ...(typeof extra.from === 'string' ? { from: extra.from } : {}),
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  harness.session.current = null;
  harness.state.placementMode = null;
  harness.state.placementCancelled = false;
  harness.state.shipMoveFrom = null;
  harness.state.revision = 7;
  for (const list of Object.values(harness.placements)) list.length = 0;
  for (const fn of [
    harness.state.closeActionDialog,
    harness.state.choosePlacement,
    harness.state.cancelPlacement,
    harness.state.clearPlacementCandidate,
    harness.state.selectPlacementCandidate,
    harness.state.selectShipToMove,
    harness.state.openActionDialog,
  ])
    fn.mockClear();
});

const MOVES = [
  choice('MOVE_SHIP', 'e:5,5,W', { from: 'e:1,1,W', to: 'e:5,5,W' }),
  choice('MOVE_SHIP', 'e:6,5,W', { from: 'e:1,1,W', to: 'e:6,5,W' }),
  choice('MOVE_SHIP', 'e:5,5,W', { from: 'e:2,2,W', to: 'e:5,5,W' }),
];

test('moving a ship first marks each ship that can sail, then only where the chosen one can go', () => {
  harness.placements.moveShip.push(...MOVES);
  harness.state.placementMode = 'moveShip';
  const view = renderHook(() => useGameActions(seaState('main'), [], presentation));
  // Step one: a ring on each movable ship, once even though it has several destinations.
  expect(view.result.current.highlights).toMatchObject({
    mode: 'edge',
    edges: ['e:1,1,W', 'e:2,2,W'],
    style: { edgeTarget: 'ring' },
  });
  expect(view.result.current.highlights.selectedEdges).toBeUndefined();
  expect(view.result.current.placementConfirmation).toBeNull();
  act(() => view.result.current.onBoardSelect({ kind: 'edge', id: 'e:1,1,W' }));
  expect(harness.state.selectShipToMove).toHaveBeenCalledWith('e:1,1,W');
  expect(harness.state.selectPlacementCandidate).not.toHaveBeenCalled();

  // Step two: that ship's own destinations, with the ship itself marked.
  harness.state.shipMoveFrom = 'e:1,1,W';
  view.rerender();
  expect(view.result.current.highlights).toMatchObject({
    mode: 'edge',
    edges: ['e:5,5,W', 'e:6,5,W'],
    selectedEdges: ['e:1,1,W'],
    style: { edgeTarget: 'wake' },
  });
  act(() => view.result.current.onBoardSelect({ kind: 'edge', id: 'e:6,5,W' }));
  expect(harness.state.selectPlacementCandidate).toHaveBeenCalledWith({
    kind: 'moveShip',
    id: 'e:6,5,W',
  });
});

test('a chosen ship that can no longer sail is forgotten', () => {
  harness.placements.moveShip.push(...MOVES);
  harness.state.placementMode = 'moveShip';
  harness.state.shipMoveFrom = 'e:9,9,W';
  const view = renderHook(() => useGameActions(seaState('main'), [], presentation));
  expect(view.result.current.highlights.edges).toEqual(['e:1,1,W', 'e:2,2,W']);
});

test('a 7 opens on the robber and offers the pirate beside it', async () => {
  harness.placements.robber.push(choice('MOVE_ROBBER', 'h:0,0', { hex: 'h:0,0' }));
  harness.placements.pirate.push(
    choice('MOVE_PIRATE', 'h:3,0', { hex: 'h:3,0' }),
    choice('MOVE_PIRATE', 'h:4,0', { hex: 'h:4,0' }),
  );
  const view = renderHook(() => useGameActions(seaState('moveRobber'), [], presentation));
  expect(view.result.current.highlights).toMatchObject({ mode: 'hex', hexes: ['h:0,0'] });
  const step = view.result.current.nextStep;
  if (step.kind !== 'board') throw new Error('The blocker choice is a board step');
  expect(step.alternatives?.map(({ kind, active }) => [kind, active])).toEqual([
    ['robber', true],
    ['pirate', false],
  ]);
  act(() => step.alternatives?.[1]?.select());
  expect(harness.state.choosePlacement).toHaveBeenCalledWith('pirate');

  // With the pirate chosen its sea hexes are the targets, and a tap sends the pirate there.
  harness.state.placementMode = 'pirate';
  const validate = vi.fn<() => ReturnType<typeof success>>(() => success(undefined));
  const submit = vi.fn<(seat: number, command: CommandShape) => Promise<unknown>>(async () =>
    success(undefined),
  );
  harness.session.current = { validate, submit };
  view.rerender();
  expect(view.result.current.highlights).toMatchObject({ mode: 'hex', hexes: ['h:3,0', 'h:4,0'] });
  const chosen = view.result.current.nextStep;
  if (chosen.kind !== 'board') throw new Error('The blocker choice is a board step');
  expect(chosen.alternatives?.map(({ active }) => active)).toEqual([false, true]);
  act(() => view.result.current.onBoardSelect({ kind: 'hex', id: 'h:4,0' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0]?.[1]).toEqual({ type: 'MOVE_PIRATE', hex: 'h:4,0' });
});

test('setup offers a ship beside the road, and Road Building a free ship beside the free road', () => {
  harness.placements.road.push(choice('PLACE_ROAD', 'e:0,0,W'));
  harness.placements.ship.push(choice('PLACE_SETUP_SHIP', 'e:1,0,W'));
  harness.state.placementMode = 'ship';
  const view = renderHook(() => useGameActions(seaState('setup'), [], presentation));
  expect(view.result.current.highlights).toMatchObject({
    mode: 'edge',
    edges: ['e:1,0,W'],
    style: { edgeTarget: 'wake' },
  });
  const step = view.result.current.nextStep;
  if (step.kind !== 'board') throw new Error('Setup placement is a board step');
  expect(step.alternatives?.map(({ kind, active }) => [kind, active])).toEqual([
    ['road', false],
    ['ship', true],
  ]);
  const status = render(<>{view.result.current.desktopStatus}</>);
  const group = status.container.querySelector('.desktop-context-actions');
  if (!(group instanceof HTMLElement)) throw new Error('The road and ship choice is missing');
  expect(
    within(group)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['game:buildAction.road', 'game:buildAction.ship']);
  cleanup();

  harness.placements.road.length = 0;
  harness.placements.ship.length = 0;
  harness.placements.freeRoad.push(choice('PLACE_FREE_ROAD', 'e:0,0,W'));
  harness.placements.freeShip.push(choice('PLACE_FREE_SHIP', 'e:1,0,W'));
  harness.state.placementMode = null;
  const building = renderHook(() => useGameActions(seaState('roadBuilding'), [], presentation));
  const free = building.result.current.nextStep;
  if (free.kind !== 'board') throw new Error('Road Building is a board step');
  expect(free.alternatives?.map(({ kind }) => kind)).toEqual(['freeRoad', 'freeShip']);
});

test('an open fog draw shows a revealing status on the board and in the next-step bar', () => {
  const draw = {
    kind: 'random' as const,
    request: {
      type: 'draw',
      deck: 'fog-terrain',
      public: true,
      seat: 0,
      slotId: 'fog-terrain:0',
      remaining: 8,
      hex: 'h:2,1',
    },
    systemType: 'FOG_REVEALED',
  };
  const state = seaState('fogReveal');
  const view = renderHook(() => useGameActions(state, [draw], presentation));
  expect(view.result.current.nextStep).toEqual({ kind: 'pending', text: 'game:fogRevealing' });
  const status = render(<>{view.result.current.desktopStatus}</>);
  expect(status.getByRole('status').textContent).toBe('game:fogRevealing');
  cleanup();
  // Once the draw is answered the indicator goes.
  const done = renderHook(() => useGameActions(state, [], presentation));
  expect(done.result.current.nextStep.kind).not.toBe('pending');
  const after = render(<>{done.result.current.desktopStatus}</>);
  expect(after.container.querySelector('.desktop-fog-revealing')).toBeNull();
});

test('the build menu of a seafaring game shows the ship with its supply and a move button', () => {
  harness.placements.ship.push(choice('BUILD_SHIP', 'e:1,0,W'));
  harness.placements.moveShip.push(...MOVES);
  harness.state.placementCancelled = true;
  const state = seaState('main');
  const view = renderHook(() => useGameActions(state, [], presentation));
  const menu = render(<>{view.result.current.desktopBuild}</>);
  const ship = menu.getByRole('button', { name: /game:buildAction.ship, game:shipsLeft:/ });
  expect(ship.hasAttribute('disabled')).toBe(false);
  expect(ship.querySelector('.build-supply')?.textContent).toBe(
    String(state.seats[0]?.piecesLeft.ship ?? 0),
  );
  expect(
    menu.getByRole('button', { name: 'game:buildAction.moveShip' }).hasAttribute('disabled'),
  ).toBe(false);
  fireClickAll(menu.getByRole('button', { name: 'game:buildAction.moveShip' }));
  expect(harness.state.choosePlacement).toHaveBeenCalledWith('moveShip');
  expect(menu.container.querySelector('.desktop-build-grid')?.getAttribute('data-seafaring')).toBe(
    'true',
  );
});

test('a game without ships has no ship or move button', () => {
  const view = renderHook(() => useGameActions(base, [], presentation));
  const menu = render(<>{view.result.current.desktopBuild}</>);
  expect(menu.queryByRole('button', { name: /ship/i })).toBeNull();
  expect(menu.container.querySelector('.desktop-build-grid')?.getAttribute('data-seafaring')).toBe(
    'false',
  );
});

function fireClickAll(element: HTMLElement): void {
  act(() => element.click());
}
