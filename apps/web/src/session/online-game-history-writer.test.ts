import { BASE_VERSION, createBaseEngine } from '@cp2p/engine';
import type { GameState, Seat } from '@cp2p/engine';
import type {
  AuditReport,
  EscrowCeremonyStore,
  SessionAuditState,
  SessionUpdate,
} from '@cp2p/protocol';
import { expect, test, vi } from 'vitest';
import { loadOnlineGameOutcome, loadOnlineGameVoid } from './online-game-history.js';
import { createOnlineGameHistoryWriter } from './online-game-history-writer.js';

class MemoryStore implements EscrowCeremonyStore {
  readonly records = new Map<string, Uint8Array>();
  failNextWrite = false;

  async load(id: string): Promise<Uint8Array | null> {
    return this.records.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('temporary storage error');
    }
    if (this.records.has(id)) return false;
    this.records.set(id, bytes.slice());
    return true;
  }

  async compareAndSwap(
    id: string,
    expected: Uint8Array,
    replacement: Uint8Array,
  ): Promise<boolean> {
    const current = this.records.get(id);
    if (!current || !sameBytes(current, expected)) return false;
    this.records.set(id, replacement.slice());
    return true;
  }

  async withCeremonyLock<T>(_id: string, task: () => Promise<T>): Promise<T> {
    return task();
  }
}

const gameId = 'A'.repeat(22);
const digest = 'B'.repeat(43);
const terminalHead = { seq: 8, hash: 'a'.repeat(64) };
const finalHead = { seq: 10, hash: 'c'.repeat(64) };

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function endedState(): GameState {
  const state = createBaseEngine().createGame(
    {
      modules: [{ id: 'base', version: BASE_VERSION }],
      seats: [0, 1],
      options: { base: { vpTarget: 3 } },
    },
    new Uint8Array(32).fill(11),
  );
  return {
    ...state,
    result: { winner: 0, reason: 'public-vp', atTurn: 7 },
    seats: state.seats.map((seat) => ({ ...seat, publicVp: seat.seat === 0 ? 4 : 2 })),
  };
}

function report(): AuditReport {
  return {
    ok: true,
    complete: true,
    missingSeats: [],
    violations: [],
    inputErrors: [],
    cheatFindings: [],
    terminal: terminalHead,
    finalHead,
    historyError: null,
    auditError: null,
    finalHiddenVictoryPoints: { 0: 2, 1: 1 },
  };
}

function sessionHarness() {
  const state = endedState();
  let head = { ...finalHead };
  let audit: SessionAuditState = { kind: 'verifying' };
  const listeners = new Set<(update: SessionUpdate) => void>();
  const session = {
    getCommittedHead: () => ({ ...head }),
    getAudit: () => audit,
    controllableSeats: (): Seat[] => [0],
    subscribe(listener: (update: SessionUpdate) => void) {
      listeners.add(listener);
      listener({
        revision: head.seq,
        state,
        events: [],
        pending: [],
        timers: [],
        status: { kind: 'complete' },
        audit,
      });
      return () => listeners.delete(listener);
    },
  };
  return {
    session,
    publish(nextAudit: SessionAuditState, nextHead = head) {
      audit = nextAudit;
      head = { ...nextHead };
      for (const listener of listeners)
        listener({
          revision: head.seq,
          state,
          events: [],
          pending: [],
          timers: [],
          status: { kind: 'complete' },
          audit,
        });
    },
  };
}

test('serializes final metadata updates and keeps the first terminal head across later audit records', async () => {
  const store = new MemoryStore();
  const harness = sessionHarness();
  const writer = createOnlineGameHistoryWriter({
    store,
    gameId,
    genesisDigest: digest,
    session: harness.session,
    localHumanSeat: 0,
    terminalHead,
  });
  harness.publish({ kind: 'complete', report: report() });
  await writer.flush();

  const outcome = await loadOnlineGameOutcome(store, gameId, digest);
  expect(outcome?.head).toEqual(finalHead);
  expect(outcome?.terminalHead).toEqual(terminalHead);
  expect(outcome?.audit.status).toBe('verified');
  writer.stop();
});

test('captures the first live terminal head, retries metadata errors, and drains after stopping', async () => {
  const store = new MemoryStore();
  const harness = sessionHarness();
  const onError = vi.fn<(error: Error) => void>();
  store.failNextWrite = true;
  const writer = createOnlineGameHistoryWriter({
    store,
    gameId,
    genesisDigest: digest,
    session: harness.session,
    localHumanSeat: 0,
    terminalHead: null,
    onError,
  });
  await writer.flush();
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'temporary storage error' }),
  );

  harness.publish({ kind: 'verifying' });
  writer.stop();
  await writer.flush();
  const outcome = await loadOnlineGameOutcome(store, gameId, digest);
  expect(outcome?.terminalHead).toEqual(finalHead);
  expect(outcome?.audit.status).toBe('pending');
});

test('reports metadata failures in production when no error callback is supplied', async () => {
  const store = new MemoryStore();
  const harness = sessionHarness();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  store.failNextWrite = true;
  const writer = createOnlineGameHistoryWriter({
    store,
    gameId,
    genesisDigest: digest,
    session: harness.session,
    localHumanSeat: 0,
    terminalHead,
  });
  await writer.flush();
  expect(warning).toHaveBeenCalledWith('Could not save online game history metadata');
  writer.stop();
  warning.mockRestore();
});

test('does not write metadata before the game ends', async () => {
  const store = new MemoryStore();
  const harness = sessionHarness();
  const state = createBaseEngine().createGame(
    {
      modules: [{ id: 'base', version: BASE_VERSION }],
      seats: [0, 1],
      options: { base: { vpTarget: 3 } },
    },
    new Uint8Array(32).fill(9),
  );
  const listeners = new Set<(update: SessionUpdate) => void>();
  const session = {
    getCommittedHead: () => harness.session.getCommittedHead(),
    getAudit: () => harness.session.getAudit(),
    controllableSeats: () => [0] as Seat[],
    subscribe(listener: (update: SessionUpdate) => void) {
      listeners.add(listener);
      listener({
        revision: 0,
        state,
        events: [],
        pending: [],
        timers: [],
        status: { kind: 'running' },
        audit: { kind: 'not-started' },
      });
      return () => listeners.delete(listener);
    },
  };
  const writer = createOnlineGameHistoryWriter({
    store,
    gameId,
    genesisDigest: digest,
    session,
    localHumanSeat: 0,
    terminalHead: null,
  });
  await writer.flush();
  expect(store.records.size).toBe(0);
  writer.stop();
});

test('a certified void persists a terminal marker without a winner or audit', async () => {
  const store = new MemoryStore();
  const state = { ...endedState(), result: null };
  const session = {
    ...sessionHarness().session,
    subscribe(listener: (update: SessionUpdate) => void) {
      listener({
        revision: finalHead.seq,
        state,
        events: [],
        pending: [],
        timers: [],
        status: { kind: 'void' },
        audit: { kind: 'not-started' },
      });
      return () => undefined;
    },
  };
  const writer = createOnlineGameHistoryWriter({
    store,
    gameId,
    genesisDigest: digest,
    session,
    localHumanSeat: 0,
    terminalHead: null,
  });
  writer.stop();
  await writer.flush();
  expect(await loadOnlineGameOutcome(store, gameId, digest)).toBeNull();
  expect(await loadOnlineGameVoid(store, gameId, digest)).toEqual({
    protocol: 'online-game-void-v1',
    gameId,
    genesisDigest: digest,
    head: finalHead,
  });
  await expect(loadOnlineGameVoid(store, gameId, 'C'.repeat(43))).rejects.toThrow('another game');
});
