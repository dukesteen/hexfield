// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { engineForConfig, exactResourceBounds, moduleSelection } from '@cp2p/engine';
import type { GameConfig, GameState, Seat } from '@cp2p/engine';
import { deriveActionAvailability } from '../actions/availability';
import { ModuleHud } from './ModuleHud';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) =>
      values?.name === undefined ? key : `${key}:${values.name}`,
  }),
}));

afterEach(cleanup);

const config: GameConfig = {
  modules: moduleSelection(['base', 'five-six']),
  seats: [0, 1, 2, 3, 4],
  options: {},
};
const engine = engineForConfig(config);
const presentation = {
  players: ([0, 1, 2, 3, 4] as const).map((seat) => ({
    seat,
    name: `P${seat}`,
    color: 'blue' as const,
    shape: 'circle' as const,
  })),
  botDelayMs: 0,
};

/** A five-seat game at seat 1's special build phase, with seat 1 holding plenty of cards. */
function specialBuildState(): GameState {
  let state = engine.createGame(config, new Uint8Array(32).fill(3));
  const step = (input: Parameters<typeof engine.apply>[1]) => {
    const next = engine.apply(state, input);
    if (!next.ok) throw new Error(next.error.message);
    state = next.value.state;
  };
  step({ kind: 'system', type: 'START_SEAT', seat: 0 });
  while (state.turn.phase.at(-1)?.id === 'setup') {
    const pending = engine.getPending(state)[0];
    if (pending?.kind !== 'player') throw new Error('No setup seat');
    const command = engine.getLegalCommands(state, pending.seat).commands[0];
    if (!command) throw new Error('No setup command');
    step({ kind: 'command', seat: pending.seat, command });
  }
  step({ kind: 'command', seat: 0, command: { type: 'ROLL_DICE' } });
  step({ kind: 'system', type: 'DICE_RESULT', dice: [2, 3] });
  step({ kind: 'command', seat: 0, command: { type: 'END_TURN' } });
  const bounds = exactResourceBounds({ brick: 3, lumber: 3, wool: 3, grain: 3, ore: 3 });
  if (!bounds.ok) throw new Error(bounds.error.message);
  return {
    ...state,
    seats: state.seats.map((seat) =>
      seat.seat === 1 ? { ...seat, resources: bounds.value } : seat,
    ),
  };
}

describe('five-six special build phase UI', () => {
  test('the building seat is offered builds, buys and Done building only', () => {
    const state = specialBuildState();
    const pending = engine.getPending(state);
    const builder: Seat = 1;
    const availability = deriveActionAvailability(
      engine.getLegalCommands(state, builder),
      pending,
      builder,
    );
    expect(availability.allowedTypes).toEqual([
      'BUILD_ROAD',
      'BUILD_SETTLEMENT',
      'BUILD_CITY',
      'BUY_DEV_CARD',
      'END_SBP',
    ]);
    expect(availability.primary.map((group) => group.type).toSorted()).toEqual([
      'BUY_DEV_CARD',
      'END_SBP',
    ]);
    expect(availability.templates).toEqual([]);
    expect(availability.cardPlays).toEqual([]);
    expect(availability.placements.city.length).toBeGreaterThan(0);
    const other = deriveActionAvailability(engine.getLegalCommands(state, 0), pending, 0);
    expect(other.allowedTypes).toEqual([]);
  });

  test('a banner names the seat in its special build phase', () => {
    render(<ModuleHud state={specialBuildState()} presentation={presentation} />);
    expect(screen.getByRole('status').textContent).toContain('game:specialBuild:P1');
  });

  test('no banner outside the special build phase', () => {
    const state = engine.createGame(config, new Uint8Array(32).fill(3));
    const page = render(<ModuleHud state={state} presentation={presentation} />);
    expect(page.container.querySelector('.special-build-banner')).toBeNull();
  });
});
