import { afterEach, expect, test } from 'vitest';
import { baseModule, success, type GameConfig, type Seat } from '@cp2p/engine';
import { standardFixedBoard } from '@cp2p/maps';
import { LocalSession, type GameSession, type SessionUpdate } from '../session';
import { attachSession, pauseForExternalConflict, useSessionStore } from './session-store';

const live: LocalSession[] = [];
afterEach(() => {
  for (const session of live) session.dispose();
  live.length = 0;
});

function sessionFixture() {
  const config: GameConfig = {
    modules: [{ id: 'base', version: baseModule().version }],
    seats: [0, 1],
    options: { base: { mapLayout: 'standard-fixed' } },
    board: standardFixedBoard(),
  };
  const made = LocalSession.create({
    config,
    humanSeats: [0, 1],
    botSeats: [],
    genesisSeed: new Uint8Array(32).fill(9),
    entropy: { randomBytes: (target) => target.fill(7) },
  });
  if (!made.ok) throw new Error(made.error.message);
  live.push(made.value);
  return made.value;
}

function fakeView(source: LocalSession, humans: Seat[]) {
  const listeners = new Set<(update: SessionUpdate) => void>();
  const pauses: boolean[] = [];
  const update: SessionUpdate = {
    revision: source.exportSave().genesis.length,
    state: source.getState(),
    events: [],
    pending: source.getPending(),
    timers: [],
    status: { kind: 'running' },
  };
  const session: GameSession = {
    mode: 'local',
    getState: () => update.state,
    getPrivate: (seat) => source.getPrivate(seat),
    getPending: () => update.pending,
    getTimers: () => update.timers,
    getLegalCommands: (seat) => source.getLegalCommands(seat),
    validate: () => success(undefined),
    getEvents: () => [],
    controllableSeats: () => humans,
    submit: async () => success(undefined),
    subscribe: (listener) => {
      listeners.add(listener);
      listener(update);
      return () => listeners.delete(listener);
    },
    exportSave: () => source.exportSave(),
    setPaused: (paused) => pauses.push(paused),
    dispose: () => undefined,
  };
  return {
    session,
    pauses,
    setPending: (pending: SessionUpdate['pending']) => {
      update.pending = pending;
      listeners.forEach((listener) => listener(update));
    },
    emit: () => listeners.forEach((listener) => listener(update)),
  };
}

test('a cross-tab pause survives later session updates', () => {
  const source = sessionFixture();
  const fixture = fakeView(source, [0, 1]);
  const detach = attachSession('game-1', fixture.session);
  expect(fixture.pauses.at(-1)).toBe(true);
  pauseForExternalConflict();
  fixture.emit();
  expect(fixture.pauses.at(-1)).toBe(true);
  detach();
});

test('one human auto-reveals, but manual conceal stays closed until a real handoff', () => {
  const source = sessionFixture();
  const required = source.getState().turn.activeSeat;
  const fixture = fakeView(source, [required]);
  const detach = attachSession('game-2', fixture.session);
  expect(useSessionStore.getState().revealedSeat).toBe(required);
  useSessionStore.getState().conceal();
  fixture.emit();
  expect(useSessionStore.getState().revealedSeat).toBeNull();
  expect(useSessionStore.getState().privateState).toBeNull();
  expect(fixture.pauses.at(-1)).toBe(true);
  detach();
});

test('a setup pending for a bot does not expose the active human hand', () => {
  const source = sessionFixture();
  const human = source.getState().turn.activeSeat;
  const bot = (human === 0 ? 1 : 0) as Seat;
  const fixture = fakeView(source, [human]);
  fixture.setPending([{ kind: 'player', seat: bot, allowed: ['PLACE_SETTLEMENT'] }]);
  const detach = attachSession('game-3', fixture.session);
  expect(useSessionStore.getState().waitingSeat).toBeNull();
  expect(useSessionStore.getState().revealedSeat).toBeNull();
  expect(useSessionStore.getState().privateState).toBeNull();
  fixture.setPending([{ kind: 'player', seat: human, allowed: ['PLACE_SETTLEMENT'] }]);
  expect(useSessionStore.getState().revealedSeat).toBe(human);
  detach();
});
