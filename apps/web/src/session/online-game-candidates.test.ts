import { canonicalEncode } from '@cp2p/codec';
import { MAX_MESSAGE_BYTES } from '@cp2p/protocol';
import type { EscrowCeremonyStore } from '@cp2p/protocol';
import { describe, expect, test } from 'vitest';
import { createOnlineGameCandidateStore } from './online-game-candidates.js';

interface SharedMemory {
  records: Map<string, Uint8Array>;
  locks: Map<string, Promise<void>>;
}

class MemoryEscrowStore implements EscrowCeremonyStore {
  constructor(private readonly shared: SharedMemory = { records: new Map(), locks: new Map() }) {}

  async load(id: string): Promise<Uint8Array | null> {
    return this.shared.records.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.shared.records.has(id)) return false;
    this.shared.records.set(id, bytes.slice());
    return true;
  }

  async compareAndSwap(
    id: string,
    expected: Uint8Array,
    replacement: Uint8Array,
  ): Promise<boolean> {
    const current = this.shared.records.get(id);
    if (!current || !equalBytes(current, expected)) return false;
    this.shared.records.set(id, replacement.slice());
    return true;
  }

  async withCeremonyLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.shared.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.shared.locks.set(id, current);
    await previous;
    try {
      return await task();
    } finally {
      if (this.shared.locks.get(id) === current) this.shared.locks.delete(id);
      release();
    }
  }
}

const firstDigest = 'A'.repeat(43);
const secondDigest = 'B'.repeat(43);

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

describe('online game cheat candidate store', () => {
  test('persists candidates across adapter recreation', async () => {
    const memory = { records: new Map(), locks: new Map() } satisfies SharedMemory;
    const first = createOnlineGameCandidateStore(new MemoryEscrowStore(memory), firstDigest);
    expect(await first.putIfAbsent('claim/seat-0', Uint8Array.of(1, 2, 3))).toBe(true);

    const reopened = createOnlineGameCandidateStore(new MemoryEscrowStore(memory), firstDigest);
    expect(await reopened.loadAll()).toEqual([
      { id: 'claim/seat-0', bytes: Uint8Array.of(1, 2, 3) },
    ]);
  });

  test('serializes concurrent inserts and never replaces an exact duplicate id', async () => {
    const memory = { records: new Map(), locks: new Map() } satisfies SharedMemory;
    const first = createOnlineGameCandidateStore(new MemoryEscrowStore(memory), firstDigest);
    const second = createOnlineGameCandidateStore(new MemoryEscrowStore(memory), firstDigest);

    const duplicateWrites = await Promise.all([
      first.putIfAbsent('claim/same', Uint8Array.of(1)),
      second.putIfAbsent('claim/same', Uint8Array.of(2)),
    ]);
    expect(duplicateWrites.filter(Boolean)).toHaveLength(1);
    const winner = (await first.loadAll()).find((entry) => entry.id === 'claim/same');
    expect([Uint8Array.of(1), Uint8Array.of(2)]).toContainEqual(winner?.bytes);
    expect(await second.putIfAbsent('claim/same', Uint8Array.of(9))).toBe(false);
    expect((await first.loadAll()).find((entry) => entry.id === 'claim/same')?.bytes).toEqual(
      winner?.bytes,
    );

    const distinctWrites = await Promise.all([
      first.putIfAbsent('claim/left', Uint8Array.of(3)),
      second.putIfAbsent('claim/right', Uint8Array.of(4)),
    ]);
    expect(distinctWrites).toEqual([true, true]);
    expect((await first.loadAll()).map(({ id }) => id).toSorted()).toEqual([
      'claim/left',
      'claim/right',
      'claim/same',
    ]);
  });

  test('deletes only the selected candidate', async () => {
    const store = createOnlineGameCandidateStore(new MemoryEscrowStore(), firstDigest);
    await store.putIfAbsent('claim/one', Uint8Array.of(1));
    await store.putIfAbsent('claim/two', Uint8Array.of(2));

    await store.delete('claim/one');
    await store.delete('claim/missing');
    expect(await store.loadAll()).toEqual([{ id: 'claim/two', bytes: Uint8Array.of(2) }]);
  });

  test('isolates supplied bytes and every returned byte array', async () => {
    const store = createOnlineGameCandidateStore(new MemoryEscrowStore(), firstDigest);
    const supplied = Uint8Array.of(10, 20, 30);
    await store.putIfAbsent('claim/copy', supplied);
    supplied.fill(0);

    const firstRead = await store.loadAll();
    firstRead[0]?.bytes.fill(255);
    expect(await store.loadAll()).toEqual([{ id: 'claim/copy', bytes: Uint8Array.of(10, 20, 30) }]);
  });

  test('fails closed on invalid, duplicate, and oversized stored catalogues', async () => {
    const memory = { records: new Map(), locks: new Map() } satisfies SharedMemory;
    const recordKey = `online-game/${firstDigest}/cheat-candidates`;
    const store = createOnlineGameCandidateStore(new MemoryEscrowStore(memory), firstDigest);
    const corrupt = async (entries: unknown[]) => {
      const bytes = canonicalEncode(entries);
      memory.records.set(recordKey, bytes);
      await expect(store.loadAll()).rejects.toThrow(/.+/);
      expect(memory.records.get(recordKey)).toEqual(bytes);
    };

    await corrupt([{ id: '../escape', bytes: Uint8Array.of(1) }]);
    await corrupt([
      { id: 'claim/duplicate', bytes: Uint8Array.of(1) },
      { id: 'claim/duplicate', bytes: Uint8Array.of(2) },
    ]);
    await corrupt([{ id: 'claim/large', bytes: new Uint8Array(MAX_MESSAGE_BYTES + 1) }]);
    await corrupt(
      Array.from({ length: 65 }, (_, index) => ({ id: `claim/${index}`, bytes: Uint8Array.of(1) })),
    );
  });

  test('isolates catalogues by game digest', async () => {
    const memory = { records: new Map(), locks: new Map() } satisfies SharedMemory;
    const first = createOnlineGameCandidateStore(new MemoryEscrowStore(memory), firstDigest);
    const second = createOnlineGameCandidateStore(new MemoryEscrowStore(memory), secondDigest);
    await first.putIfAbsent('claim/same', Uint8Array.of(1));
    await second.putIfAbsent('claim/same', Uint8Array.of(2));

    expect(await first.loadAll()).toEqual([{ id: 'claim/same', bytes: Uint8Array.of(1) }]);
    expect(await second.loadAll()).toEqual([{ id: 'claim/same', bytes: Uint8Array.of(2) }]);
  });
});
