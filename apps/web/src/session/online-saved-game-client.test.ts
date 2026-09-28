// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import {
  deleteStoredGame,
  exportStoredGameReplay,
  exportStoredGameReplayWithSignal,
} from './online-saved-game-client.js';

const vault = vi.hoisted(() => ({
  withIdleVaultReleased: vi.fn<(task: () => Promise<unknown>) => Promise<unknown>>(),
}));
vi.mock('./online-vault-controller.js', () => ({ getOnlineVaultController: () => vault }));

type Request = { id: number; kind: string; gameId: string; genesisDigest?: string };

function isRequest(value: unknown): value is Request {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'id') === 'number' &&
    typeof Reflect.get(value, 'kind') === 'string' &&
    typeof Reflect.get(value, 'gameId') === 'string'
  );
}

class FakeWorker {
  static last: FakeWorker | null = null;
  static respond: ((request: Request) => unknown) | null = null;
  readonly #events = new EventTarget();
  readonly #posted: unknown[] = [];
  terminated = false;

  constructor(_url: URL, _options: WorkerOptions) {
    FakeWorker.last = this;
  }

  postMessage(message: unknown): void {
    this.#posted.push(message);
    if (!isRequest(message)) throw new Error('Invalid worker request');
    const request = message;
    const response = FakeWorker.respond?.(request);
    if (response !== undefined)
      queueMicrotask(() =>
        this.#events.dispatchEvent(new MessageEvent('message', { data: response })),
      );
  }

  addEventListener(type: string, listener: EventListener): void {
    this.#events.addEventListener(type, listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.#events.removeEventListener(type, listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string, event: Event): void {
    this.#events.dispatchEvent(event);
  }

  request(): Request {
    const value = this.#posted[0];
    if (!isRequest(value)) throw new Error('No worker request');
    return value;
  }
}

const gameId = 'a'.repeat(22);
const genesisDigest = 'b'.repeat(43);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeWorker.last = null;
  FakeWorker.respond = null;
});

function installWorker(): void {
  vi.stubGlobal('Worker', FakeWorker);
  vault.withIdleVaultReleased.mockImplementation((task) => task());
}

test('export sends only a game locator and returns detached bounded bytes', async () => {
  installWorker();
  const bytes = Uint8Array.of(1, 2, 3);
  FakeWorker.respond = ({ id }) => ({ id, kind: 'exported', bytes });

  const exported = await exportStoredGameReplay(gameId);

  expect(FakeWorker.last?.request()).toMatchObject({ kind: 'export', gameId });
  expect(Object.keys(FakeWorker.last?.request() ?? {}).toSorted()).toEqual([
    'gameId',
    'id',
    'kind',
  ]);
  expect(exported).toEqual(bytes);
  expect(exported).not.toBe(bytes);
  exported[0] = 99;
  expect(bytes[0]).toBe(1);
  expect(FakeWorker.last?.terminated).toBe(true);
});

test('delete returns busy without treating the saved game as deleted', async () => {
  installWorker();
  FakeWorker.respond = ({ id }) => ({ id, kind: 'deleted', result: 'busy' });

  await expect(deleteStoredGame(gameId, genesisDigest)).resolves.toBe('busy');
  expect(FakeWorker.last?.request()).toMatchObject({
    kind: 'delete',
    gameId,
    genesisDigest,
  });
  expect(FakeWorker.last?.terminated).toBe(true);
});

test('a live vault scope refuses deletion before starting a worker', async () => {
  installWorker();
  vault.withIdleVaultReleased.mockResolvedValueOnce(null);
  await expect(deleteStoredGame(gameId, genesisDigest)).resolves.toBe('busy');
  expect(FakeWorker.last).toBeNull();
});

test('invalid identity never starts a worker and abort terminates an active export', async () => {
  installWorker();
  await expect(exportStoredGameReplay('bad')).rejects.toThrow('identifier');
  expect(FakeWorker.last).toBeNull();

  const controller = new AbortController();
  const pending = exportStoredGameReplayWithSignal(gameId, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(FakeWorker.last?.terminated).toBe(true);
});

test('worker failure and deadline terminate the one-shot worker', async () => {
  installWorker();
  FakeWorker.respond = null;
  const controller = new AbortController();
  const pending = exportStoredGameReplayWithSignal(gameId, controller.signal);
  const worker = FakeWorker.last;
  if (!worker) throw new Error('Worker was not created');
  worker.emit('error', new Event('error'));
  await expect(pending).rejects.toThrow('worker failed');
  expect(worker.terminated).toBe(true);

  vi.useFakeTimers();
  const timeoutPending = exportStoredGameReplay(gameId);
  const timeoutResult = timeoutPending.then(
    () => 'resolved',
    () => 'rejected',
  );
  const timeoutWorker = FakeWorker.last;
  if (!timeoutWorker) throw new Error('Worker was not created');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await timeoutResult).toBe('rejected');
  expect(timeoutWorker.terminated).toBe(true);
});
