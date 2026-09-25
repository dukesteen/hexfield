import { afterEach, expect, test } from 'vitest';
import { baseModule, success, type GameConfig, type Seat } from '@cp2p/engine';
import { standardFixedBoard } from '@cp2p/maps';
import type { EdgeId, VertexId } from '@cp2p/engine/geometry';
import { LocalSession, type GameSession, type SessionUpdate } from '../session';
import { attachSession, pauseForExternalConflict, useSessionStore } from './session-store';

const live: LocalSession[] = [];
afterEach(() => {
  for (const session of live) session.dispose();
  live.length = 0;
});

function sessionFixture(seats: Seat[] = [0, 1]) {
  const config: GameConfig = {
    modules: [{ id: 'base', version: baseModule().version }],
    seats,
    options: { base: { mapLayout: 'standard-fixed' } },
    board: standardFixedBoard(),
  };
  const made = LocalSession.create({
    config,
    humanSeats: seats,
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
    setPhase: (phase: string) => {
      update.state = {
        ...update.state,
        turn: {
          ...update.state.turn,
          phase: [{ module: 'base', id: phase, data: {} }],
        },
      };
      listeners.forEach((listener) => listener(update));
    },
    setActiveSeat: (seat: Seat) => {
      update.state = { ...update.state, turn: { ...update.state.turn, activeSeat: seat } };
      listeners.forEach((listener) => listener(update));
    },
    emit: () => listeners.forEach((listener) => listener(update)),
    advanceRevision: () => {
      update.revision += 1;
      listeners.forEach((listener) => listener(update));
    },
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
  expect(useSessionStore.getState().conflicted).toBe(true);
  expect(useSessionStore.getState().privateState).toBeNull();
  useSessionStore.getState().reveal(source.getState().turn.activeSeat);
  expect(useSessionStore.getState().revealedSeat).toBeNull();
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

test('a single human keeps their own hand visible during a bot turn', () => {
  const source = sessionFixture();
  const human = source.getState().turn.activeSeat;
  const bot = (human === 0 ? 1 : 0) as Seat;
  const fixture = fakeView(source, [human]);
  fixture.setPending([{ kind: 'player', seat: bot, allowed: ['PLACE_SETTLEMENT'] }]);
  const detach = attachSession('game-3', fixture.session);
  try {
    expect(useSessionStore.getState().waitingSeat).toBeNull();
    expect(useSessionStore.getState().revealedSeat).toBe(human);
    expect(useSessionStore.getState().privateState).not.toBeNull();
    useSessionStore.getState().conceal();
    expect(useSessionStore.getState().waitingSeat).toBe(human);
    expect(useSessionStore.getState().revealedSeat).toBeNull();
    expect(fixture.pauses.at(-1)).toBe(true);
    fixture.emit();
    expect(useSessionStore.getState().waitingSeat).toBe(human);
    useSessionStore.getState().autoReveal(human);
    expect(useSessionStore.getState().revealedSeat).toBeNull();
    useSessionStore.getState().reveal(human);
    expect(useSessionStore.getState().revealedSeat).toBe(human);
    fixture.setPending([{ kind: 'player', seat: human, allowed: ['PLACE_SETTLEMENT'] }]);
    expect(useSessionStore.getState().revealedSeat).toBe(human);
  } finally {
    detach();
  }
});

test('multiple humans choose optional trade viewing without forcing a handoff', () => {
  const source = sessionFixture([0, 1, 2]);
  const fixture = fakeView(source, [0, 1]);
  fixture.setActiveSeat(2);
  fixture.setPending([
    { kind: 'player', seat: 2, allowed: ['END_TURN'] },
    { kind: 'player', seat: 0, allowed: ['PROPOSE_TRADE'] },
    { kind: 'player', seat: 1, allowed: ['PROPOSE_TRADE', 'CANCEL_TRADE'] },
  ]);
  const detach = attachSession('game-optional', fixture.session);
  expect(useSessionStore.getState().waitingSeat).toBeNull();
  expect(useSessionStore.getState().optionalChoices).toEqual([0, 1]);
  useSessionStore.getState().viewOptionalSeat(1);
  expect(useSessionStore.getState().waitingSeat).toBe(1);
  expect(fixture.pauses.at(-1)).toBe(true);
  useSessionStore.getState().reveal(1);
  expect(useSessionStore.getState().revealedSeat).toBe(1);
  expect(fixture.pauses.at(-1)).toBe(false);
  useSessionStore.getState().leaveOptionalSeat();
  expect(useSessionStore.getState().waitingSeat).toBeNull();
  expect(useSessionStore.getState().privateState).toBeNull();
  detach();
});

test('optional non-active trade actions do not interrupt a bot turn', () => {
  const source = sessionFixture();
  const bot = source.getState().turn.activeSeat;
  const human = (bot === 0 ? 1 : 0) as Seat;
  const fixture = fakeView(source, [human]);
  fixture.setPending([
    { kind: 'player', seat: bot, allowed: ['ROLL_DICE'] },
    { kind: 'player', seat: human, allowed: ['PROPOSE_TRADE', 'CANCEL_TRADE'] },
  ]);
  const detach = attachSession('game-4', fixture.session);
  expect(useSessionStore.getState().waitingSeat).toBeNull();
  expect(fixture.pauses.at(-1)).toBe(false);
  fixture.setPending([
    { kind: 'player', seat: bot, allowed: ['ROLL_DICE'] },
    { kind: 'player', seat: human, allowed: ['PROPOSE_TRADE', 'RESPOND_TRADE'] },
  ]);
  expect(useSessionStore.getState().waitingSeat).toBeNull();
  expect(useSessionStore.getState().revealedSeat).toBe(human);
  detach();
});

test('an active human can pass optional trade control to another human and return', () => {
  const source = sessionFixture();
  const active = source.getState().turn.activeSeat;
  const responder = (active === 0 ? 1 : 0) as Seat;
  const fixture = fakeView(source, [active, responder]);
  fixture.setPending([
    { kind: 'player', seat: active, allowed: ['CONFIRM_TRADE', 'CANCEL_TRADE', 'END_TURN'] },
    { kind: 'player', seat: responder, allowed: ['PROPOSE_TRADE', 'RESPOND_TRADE'] },
  ]);
  const detach = attachSession('game-trade-response', fixture.session);
  useSessionStore.getState().reveal(active);
  expect(useSessionStore.getState().revealedSeat).toBe(active);
  expect(useSessionStore.getState().optionalChoices).toEqual([responder]);
  useSessionStore.getState().viewOptionalSeat(responder);
  expect(useSessionStore.getState().waitingSeat).toBe(responder);
  useSessionStore.getState().reveal(responder);
  expect(useSessionStore.getState().revealedSeat).toBe(responder);
  useSessionStore.getState().leaveOptionalSeat();
  expect(useSessionStore.getState().waitingSeat).toBe(active);
  expect(useSessionStore.getState().revealedSeat).toBeNull();
  detach();
});

test('privacy and phase changes clear transient placements and dialogs', () => {
  const source = sessionFixture();
  const human = source.getState().turn.activeSeat;
  const fixture = fakeView(source, [human]);
  const detach = attachSession('game-5', fixture.session);
  useSessionStore.getState().choosePlacement('road');
  useSessionStore.getState().openActionDialog('plenty', 'dev:1');
  expect(useSessionStore.getState().selectedCardSlot).toBe('dev:1');
  useSessionStore.getState().conceal();
  expect(useSessionStore.getState().placementMode).toBeNull();
  expect(useSessionStore.getState().openDialog).toBeNull();
  expect(useSessionStore.getState().selectedCardSlot).toBeNull();
  useSessionStore.getState().reveal(human);
  useSessionStore.getState().choosePlacement('settlement');
  fixture.setPhase('main');
  expect(useSessionStore.getState().placementMode).toBeNull();
  detach();
});

test('building candidate remains changeable and clears on cancellation, privacy, or revision', () => {
  const source = sessionFixture();
  const human = source.getState().turn.activeSeat;
  const fixture = fakeView(source, [human]);
  const detach = attachSession('road-preview', fixture.session);
  const first = { kind: 'road' as const, id: 'e:0,0,NE' as EdgeId };
  const second = { kind: 'road' as const, id: 'e:0,0,NW' as EdgeId };
  const city = { kind: 'city' as const, id: 'v:0,0,N' as VertexId };
  try {
    useSessionStore.getState().choosePlacement('road');
    useSessionStore.getState().selectPlacementCandidate(first);
    expect(useSessionStore.getState().previewPlacement).toEqual(first);
    useSessionStore.getState().selectPlacementCandidate(second);
    expect(useSessionStore.getState().previewPlacement).toEqual(second);
    useSessionStore.getState().clearPlacementCandidate();
    expect(useSessionStore.getState().previewPlacement).toBeNull();
    expect(useSessionStore.getState().placementMode).toBe('road');
    useSessionStore.getState().choosePlacement('city');
    useSessionStore.getState().selectPlacementCandidate(city);
    expect(useSessionStore.getState().previewPlacement).toEqual(city);
    fixture.advanceRevision();
    expect(useSessionStore.getState().previewPlacement).toBeNull();
    useSessionStore.getState().selectPlacementCandidate(first);
    useSessionStore.getState().conceal();
    expect(useSessionStore.getState().previewPlacement).toBeNull();
  } finally {
    detach();
  }
});

test('real three-human snake setup hands control to each pending placement seat', async () => {
  const session = sessionFixture([0, 1, 2]);
  const detach = attachSession('snake-setup', session);
  const acted: Seat[] = [];
  try {
    for (let step = 0; step < 12; step += 1) {
      const pending = session
        .getPending()
        .find(
          (item) =>
            item.kind === 'player' &&
            item.allowed.some((type) => type === 'PLACE_SETTLEMENT' || type === 'PLACE_ROAD'),
        );
      if (pending?.kind !== 'player') throw new Error(`Missing setup pending at step ${step}`);
      acted.push(pending.seat);
      expect(useSessionStore.getState().waitingSeat).toBe(pending.seat);
      useSessionStore.getState().reveal(pending.seat);
      expect(useSessionStore.getState().revealedSeat).toBe(pending.seat);
      const command = session
        .getLegalCommands(pending.seat)
        .commands.find((item) => pending.allowed.includes(item.type));
      if (!command) throw new Error(`Missing setup command at step ${step}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each placement determines the next pending seat.
      const result = await session.submit(pending.seat, command);
      expect(result.ok).toBe(true);
    }
    const order = [acted[0], acted[2], acted[4]];
    expect(new Set(order).size).toBe(3);
    expect(acted).toEqual(
      order
        .flatMap((seat) => [seat, seat])
        .concat(order.toReversed().flatMap((seat) => [seat, seat])),
    );
  } finally {
    detach();
  }
});
