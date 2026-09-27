// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import {
  exportStoredOnlineFullSave,
  importOnlineFullSaveFile,
  OnlineFullSaveClientError,
  openImportedOnlineFullSave,
} from './online-full-save-client.js';

class FakeWorker {
  static last: FakeWorker | null = null;
  static respond: ((request: Record<string, unknown>) => unknown) | null = null;
  readonly events = new EventTarget();
  posted: unknown = null;
  transferred: Transferable[] = [];
  terminated = false;

  constructor(_url: URL, _options: WorkerOptions) {
    FakeWorker.last = this;
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.posted = message;
    this.transferred = transfer;
    if (!isRecord(message)) throw new Error('Malformed request');
    const response = FakeWorker.respond?.(message);
    if (response !== undefined)
      queueMicrotask(() =>
        this.events.dispatchEvent(new MessageEvent('message', { data: response })),
      );
  }

  addEventListener(type: string, listener: EventListener): void {
    this.events.addEventListener(type, listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.events.removeEventListener(type, listener);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

afterEach(() => {
  FakeWorker.last = null;
  FakeWorker.respond = null;
  vi.unstubAllGlobals();
});

test('export sends only the game ID and explicit choice, never locally held material', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const bytes = Uint8Array.of(1, 2, 3);
  FakeWorker.respond = ({ id }) => ({ id, kind: 'exported', bytes });
  const exported = await exportStoredOnlineFullSave('a'.repeat(22), { includePrivate: false });
  expect(FakeWorker.last?.posted).toMatchObject({ gameId: 'a'.repeat(22), includePrivate: false });
  expect(Object.keys(FakeWorker.last?.posted ?? {}).toSorted()).toEqual([
    'gameId',
    'id',
    'includePrivate',
    'kind',
  ]);
  expect(exported).toEqual(bytes);
  expect(exported).not.toBe(bytes);
  expect(FakeWorker.last?.terminated).toBe(true);
});

test('import transfers bounded encrypted bytes and preserves password failure code', async () => {
  const worker = new FakeWorker(new URL('https://example.test'), { type: 'module' });
  FakeWorker.respond = ({ id }) => ({
    id,
    kind: 'error',
    code: 'full-save-decrypt',
    message: 'Wrong passphrase',
  });
  const source = Uint8Array.of(1, 2, 3);
  await expect(
    importOnlineFullSaveFile(source, 'wrong passphrase', () => worker),
  ).rejects.toMatchObject({
    code: 'full-save-decrypt',
  });
  expect(source).toEqual(Uint8Array.of(1, 2, 3));
  expect(worker.transferred).toHaveLength(1);
  expect(worker.terminated).toBe(true);
  expect(new OnlineFullSaveClientError('full-save-passphrase', 'Required').code).toBe(
    'full-save-passphrase',
  );
});

test('leaving read-only open terminates its worker', async () => {
  const worker = new FakeWorker(new URL('https://example.test'), { type: 'module' });
  const controller = new AbortController();
  const opened = openImportedOnlineFullSave('a'.repeat(64), controller.signal, () => worker);
  controller.abort();
  await expect(opened).rejects.toMatchObject({ name: 'AbortError' });
  expect(worker.terminated).toBe(true);
});
