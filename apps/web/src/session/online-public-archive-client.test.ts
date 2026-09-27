import { expect, test } from 'vitest';
import {
  importPublicReplay,
  openPublicReplay,
  type PublicArchiveWorkerFactory,
} from './online-public-archive-client.js';
import { MAX_ONLINE_PUBLIC_ARCHIVE_BYTES } from './online-public-archive.js';

const ID = 'a'.repeat(64);

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
}

function fakeWorker(onRequest: (value: unknown, transfer?: Transferable[]) => unknown) {
  let terminated = false;
  const events = new EventTarget();
  const factory: PublicArchiveWorkerFactory = () => ({
    postMessage(value, transfer) {
      const response = onRequest(value, transfer);
      queueMicrotask(() => events.dispatchEvent(new MessageEvent('message', { data: response })));
    },
    addEventListener: (type, listener) => events.addEventListener(type, listener),
    removeEventListener: (type, listener) => events.removeEventListener(type, listener),
    terminate() {
      terminated = true;
    },
  });
  return { factory, terminated: () => terminated };
}

test('public import transfers a copy, enforces byte bounds, and terminates its worker', async () => {
  const supplied = Uint8Array.of(1, 2, 3);
  const worker = fakeWorker((value, transfer) => {
    expect(transfer).toHaveLength(1);
    expect(transfer?.[0]).not.toBe(supplied.buffer);
    expect(field(value, 'kind')).toBe('import');
    return { id: field(value, 'id'), kind: 'imported', archiveId: ID };
  });
  expect(await importPublicReplay(supplied, worker.factory)).toBe(ID);
  expect(supplied).toEqual(Uint8Array.of(1, 2, 3));
  expect(worker.terminated()).toBe(true);
  let created = false;
  await expect(
    importPublicReplay(new Uint8Array(MAX_ONLINE_PUBLIC_ARCHIVE_BYTES + 1), () => {
      created = true;
      return worker.factory();
    }),
  ).rejects.toThrow('size limit');
  expect(created).toBe(false);
});

test('public open refuses an unrelated worker response', async () => {
  const worker = fakeWorker((value) => ({
    id: field(value, 'id'),
    kind: 'opened',
    archive: { id: 'b'.repeat(64), events: [], players: [], state: {} },
  }));
  await expect(openPublicReplay(ID, worker.factory)).rejects.toThrow('another archive');
  expect(worker.terminated()).toBe(true);
});

test('abandoning a replay terminates its verifier before the deadline', async () => {
  const events = new EventTarget();
  let terminated = false;
  const factory: PublicArchiveWorkerFactory = () => ({
    postMessage() {},
    addEventListener: (type, listener) => events.addEventListener(type, listener),
    removeEventListener: (type, listener) => events.removeEventListener(type, listener),
    terminate() {
      terminated = true;
    },
  });
  const abort = new AbortController();
  const opening = openPublicReplay(ID, factory, abort.signal);
  abort.abort();
  await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
  expect(terminated).toBe(true);
});
