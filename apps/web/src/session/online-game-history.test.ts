import { canonicalEncode } from '@cp2p/codec';
import { BASE_VERSION, createBaseEngine } from '@cp2p/engine';
import type { GameState, Seat } from '@cp2p/engine';
import type { AuditReport, EscrowCeremonyStore, SessionAuditState } from '@cp2p/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import {
  deriveOnlineGameStats,
  loadOnlineGameOutcome,
  saveOnlineGameOutcome,
} from './online-game-history.js';

class MemoryStore implements EscrowCeremonyStore {
  readonly records = new Map<string, Uint8Array>();
  readonly locks = new Map<string, Promise<void>>();

  async load(id: string): Promise<Uint8Array | null> {
    return this.records.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
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

  async withCeremonyLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(id, next);
    await previous;
    try {
      return await task();
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
      release();
    }
  }
}

const identity = { gameId: 'A'.repeat(22), genesisDigest: 'B'.repeat(43) };
const terminalHead = { seq: 10, hash: 'a'.repeat(64) };
const finalHead = { seq: 12, hash: 'c'.repeat(64) };

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function makeState(): GameState {
  const engine = createBaseEngine();
  const initial = engine.createGame(
    {
      modules: [{ id: 'base', version: BASE_VERSION }],
      seats: [0, 1],
      options: { base: { vpTarget: 3 } },
    },
    new Uint8Array(32).fill(7),
  );
  return {
    ...initial,
    seats: initial.seats.map((seat) => ({ ...seat, publicVp: seat.seat === 0 ? 4 : 2 })),
    result: { winner: 0, reason: 'public-vp', atTurn: 9 },
  };
}

function makeReport(
  head: { seq: number; hash: string },
  changes: Partial<AuditReport> = {},
): AuditReport {
  return {
    ok: true,
    complete: true,
    missingSeats: [],
    violations: [],
    inputErrors: [],
    cheatFindings: [],
    terminal: { seq: terminalHead.seq, hash: terminalHead.hash },
    finalHead: { ...head },
    historyError: null,
    auditError: null,
    finalHiddenVictoryPoints: { 0: 2, 1: 1 },
    ...changes,
  };
}

function input(
  audit: SessionAuditState,
  head = terminalHead,
  localSeat: Seat | null = 0,
  terminal = terminalHead,
) {
  return {
    ...identity,
    head,
    terminalHead: terminal,
    state: makeState(),
    localSeat,
    audit,
  };
}

afterEach(() => vi.restoreAllMocks());

test('keeps hidden scores out of pending and failed history; verified scores drive local stats', async () => {
  const store = new MemoryStore();
  const pending = await saveOnlineGameOutcome(store, input({ kind: 'verifying' }));
  expect(pending.audit.status).toBe('pending');
  expect(pending.finalScores).toBeNull();
  expect(deriveOnlineGameStats([pending])).toEqual({
    gamesPlayed: 0,
    wins: 0,
    averageVictoryPoints: null,
  });

  const failedReport = makeReport(terminalHead, {
    ok: false,
    violations: [
      {
        seq: 7,
        seat: 1,
        kind: 'invalid-proof',
        detail: 'invalid proof',
      },
    ],
  });
  const failed = await saveOnlineGameOutcome(
    store,
    input({ kind: 'complete', report: failedReport }),
  );
  expect(failed.audit.status).toBe('failed');
  expect(failed.finalScores).toBeNull();

  const verified = await saveOnlineGameOutcome(
    store,
    input({ kind: 'complete', report: makeReport(terminalHead) }),
  );
  expect(verified.finalScores).toEqual([
    { seat: 0, publicPoints: 4, hiddenPoints: 2, totalPoints: 6 },
    { seat: 1, publicPoints: 2, hiddenPoints: 1, totalPoints: 3 },
  ]);
  expect(deriveOnlineGameStats([verified])).toEqual({
    gamesPlayed: 1,
    wins: 1,
    averageVictoryPoints: 6,
  });
  expect(await loadOnlineGameOutcome(store, identity.gameId, identity.genesisDigest)).toEqual(
    verified,
  );
  await expect(loadOnlineGameOutcome(store, identity.gameId, 'D'.repeat(43))).rejects.toThrow(
    'another game or genesis',
  );

  const mismatchStore = new MemoryStore();
  const wrongHeadReport = makeReport({ seq: 11, hash: 'e'.repeat(64) });
  const wrongHead = await saveOnlineGameOutcome(
    mismatchStore,
    input({ kind: 'complete', report: wrongHeadReport }),
  );
  expect(wrongHead.audit.status).toBe('failed');
  expect(wrongHead.finalScores).toBeNull();

  const missingSeatReport = makeReport(terminalHead, { finalHiddenVictoryPoints: { 0: 2 } });
  const missingSeat = await saveOnlineGameOutcome(
    new MemoryStore(),
    input({ kind: 'complete', report: missingSeatReport }),
  );
  expect(missingSeat.audit.status).toBe('failed');
  expect(missingSeat.finalScores).toBeNull();
});

test('advances only to newer exact heads and re-audits new post-terminal certified entries', async () => {
  const store = new MemoryStore();
  await saveOnlineGameOutcome(store, input({ kind: 'complete', report: makeReport(terminalHead) }));

  await expect(
    saveOnlineGameOutcome(store, input({ kind: 'verifying' }, { seq: 9, hash: 'd'.repeat(64) })),
  ).rejects.toThrow('terminal head is inconsistent');
  await expect(
    saveOnlineGameOutcome(
      store,
      input({ kind: 'verifying' }, { seq: 10, hash: 'd'.repeat(64) }, 0, {
        seq: 10,
        hash: 'd'.repeat(64),
      }),
    ),
  ).rejects.toThrow('conflicts');

  const advanced = await saveOnlineGameOutcome(store, input({ kind: 'verifying' }, finalHead));
  expect(advanced.head).toEqual(finalHead);
  expect(advanced.terminalHead).toEqual(terminalHead);
  expect(advanced.finalScores).toBeNull();

  const reverified = await saveOnlineGameOutcome(
    store,
    input({ kind: 'complete', report: makeReport(finalHead) }, finalHead),
  );
  expect(reverified.audit.status).toBe('verified');
  expect(reverified.finalScores?.[0]?.totalPoints).toBe(6);
  await expect(
    saveOnlineGameOutcome(store, input({ kind: 'verifying' }, terminalHead)),
  ).rejects.toThrow('conflicts');
});

test('rejects corrupt records and excludes unknown local seats from statistics', async () => {
  const store = new MemoryStore();
  const headless = await saveOnlineGameOutcome(
    store,
    input({ kind: 'complete', report: makeReport(terminalHead) }, terminalHead, null),
  );
  expect(headless.localSeat).toBeNull();
  expect(deriveOnlineGameStats([headless])).toEqual({
    gamesPlayed: 0,
    wins: 0,
    averageVictoryPoints: null,
  });

  const key = `online-game/${identity.gameId}/outcome`;
  store.records.set(key, canonicalEncode({ ...headless, extraSecretField: 'must reject' }));
  await expect(
    loadOnlineGameOutcome(store, identity.gameId, identity.genesisDigest),
  ).rejects.toThrow(/./);
});

test('rejects malformed display input before writing any outcome bytes', async () => {
  const store = new MemoryStore();
  const malformed = input({ kind: 'verifying' });
  malformed.state.result = { winner: 0, reason: '', atTurn: 9 };
  await expect(saveOnlineGameOutcome(store, malformed)).rejects.toThrow('Invalid');
  expect(store.records.size).toBe(0);
});
