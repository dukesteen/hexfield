import { describe, expect, test } from 'vitest';
import { MemorySafetyStore } from './safety-store.js';

describe('MemorySafetyStore', () => {
  test('uses absent-only initial CAS and monotonically advances revisions', async () => {
    const store = new MemorySafetyStore();
    expect(await store.load()).toBeNull();
    expect(await store.save(0, Uint8Array.of(1))).toBe(false);
    expect(await store.save(null, Uint8Array.of(1))).toBe(true);
    expect(await store.load()).toEqual({ revision: 0, bytes: Uint8Array.of(1) });
    expect(await store.save(null, Uint8Array.of(2))).toBe(false);
    expect(await store.save(1, Uint8Array.of(2))).toBe(false);
    expect(await store.save(0, Uint8Array.of(2))).toBe(true);
    expect(await store.load()).toEqual({ revision: 1, bytes: Uint8Array.of(2) });
  });

  test('allows only one concurrent writer for a given revision', async () => {
    const store = new MemorySafetyStore();
    expect(await store.save(null, Uint8Array.of(0))).toBe(true);

    const results = await Promise.all([
      store.save(0, Uint8Array.of(1)),
      store.save(0, Uint8Array.of(2)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => !result)).toHaveLength(1);
    expect(await store.load()).toMatchObject({ revision: 1 });
    const current = await store.load();
    expect(
      current?.bytes?.toString() === Uint8Array.of(1).toString() ||
        current?.bytes?.toString() === Uint8Array.of(2).toString(),
    ).toBe(true);
  });

  test('copies bytes when saving and loading', async () => {
    const store = new MemorySafetyStore();
    const source = Uint8Array.of(3, 4);
    expect(await store.save(null, source)).toBe(true);
    source.fill(9);

    const firstRead = await store.load();
    expect(firstRead?.bytes).toEqual(Uint8Array.of(3, 4));
    firstRead?.bytes.fill(8);
    expect((await store.load())?.bytes).toEqual(Uint8Array.of(3, 4));
  });

  test('the retained store remains available across controller lifetimes', async () => {
    const persistentStore = new MemorySafetyStore();
    const firstController = persistentStore;
    expect(await firstController.save(null, Uint8Array.of(5, 6))).toBe(true);

    const restartedController = persistentStore;
    expect(await restartedController.load()).toEqual({
      revision: 0,
      bytes: Uint8Array.of(5, 6),
    });
    expect(await restartedController.save(0, Uint8Array.of(7))).toBe(true);
    expect(await firstController.load()).toEqual({ revision: 1, bytes: Uint8Array.of(7) });
  });

  test('rejects invalid inputs and revision overflow without mutation', async () => {
    const store = new MemorySafetyStore();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Model an untyped JS caller violating the TS interface.
    const invalidByteArray = [1, 2] as unknown as Uint8Array;
    expect(await store.save(Number.NaN, Uint8Array.of(1))).toBe(false);
    expect(await store.save(-1, Uint8Array.of(1))).toBe(false);
    expect(await store.save(0.5, Uint8Array.of(1))).toBe(false);
    expect(await store.save(null, invalidByteArray)).toBe(false);
    expect(await store.load()).toBeNull();

    expect(await store.save(null, Uint8Array.of(1))).toBe(true);
    Object.defineProperty(store, 'record', {
      configurable: true,
      value: { revision: Number.MAX_SAFE_INTEGER, bytes: Uint8Array.of(1) },
      writable: true,
    });
    expect(await store.save(Number.MAX_SAFE_INTEGER, Uint8Array.of(2))).toBe(false);
    expect(await store.load()).toEqual({
      revision: Number.MAX_SAFE_INTEGER,
      bytes: Uint8Array.of(1),
    });
  });
});
