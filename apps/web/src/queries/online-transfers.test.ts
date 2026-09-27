import { beforeEach, expect, test, vi } from 'vitest';
import type { GameWriterLeaseOptions } from '@cp2p/storage';
import { openDestinationTransfer } from './online-transfers.js';

const mocks = vi.hoisted(() => ({
  network: vi.fn<() => Promise<{ iceServers: never[]; iceTransportPolicy: 'all' }>>(),
  identity: vi.fn<() => Promise<{ peerId: string; dispose: () => void }>>(),
  lease:
    vi.fn<
      (
        game: string,
        self: string,
        options: GameWriterLeaseOptions,
      ) => Promise<{ close: () => Promise<void> } | null>
    >(),
  open: vi.fn<() => Promise<{ close: () => Promise<void> }>>(),
  constructWorker: vi.fn<() => void>(),
  closeStore: vi.fn<() => Promise<void>>(),
  disposeIdentity: vi.fn<() => void>(),
  closeLease: vi.fn<() => Promise<void>>(),
  closeBrowser: vi.fn<() => Promise<void>>(),
  shutdown: vi.fn<() => Promise<void>>(),
  fail: vi.fn<(error: Error) => void>(),
}));

vi.mock('./network.js', () => ({ loadOnlineConnectionSettings: mocks.network }));
vi.mock('../session/online-credentials.js', () => ({ loadOrCreateOnlineIdentity: mocks.identity }));
vi.mock('@cp2p/storage', () => ({
  IndexedDbByteStore: class {
    close = mocks.closeStore;
  },
  acquireGameWriterLease: mocks.lease,
}));
vi.mock('../session/online-worker-client.js', () => ({
  OnlineWorkerClient: class {
    constructor() {
      mocks.constructWorker();
    }
    shutdown = mocks.shutdown;
    fail = mocks.fail;
  },
}));
vi.mock('../session/online-transfer-browser.js', () => ({
  OnlineTransferBrowser: { openDestination: mocks.open },
}));

const invite = {
  body: {
    protocol: 'cp2p/online-transfer-invite/v4' as const,
    roomId: 'transferaa',
    attemptId: 'A'.repeat(43),
    gameId: 'g'.repeat(22),
    genesisDigest: 'B'.repeat(43),
    seat: 0 as const,
    sourceDevice: 'C'.repeat(43),
    serverUrl: 'wss://example.com',
  },
  sig: 'D'.repeat(86),
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.network.mockResolvedValue({ iceServers: [], iceTransportPolicy: 'all' });
  mocks.identity.mockResolvedValue({ peerId: 'destination', dispose: mocks.disposeIdentity });
  mocks.lease.mockResolvedValue({ close: mocks.closeLease });
  mocks.open.mockResolvedValue({ close: mocks.closeBrowser });
  for (const close of [mocks.closeStore, mocks.closeLease, mocks.closeBrowser, mocks.shutdown])
    close.mockResolvedValue(undefined);
});

test('identity failure closes the store before any worker is created', async () => {
  mocks.identity.mockRejectedValue(new Error('identity unavailable'));
  await expect(openDestinationTransfer(invite)).rejects.toThrow('identity unavailable');
  expect(mocks.closeStore).toHaveBeenCalledOnce();
  expect(mocks.constructWorker).not.toHaveBeenCalled();
});

test('writer contention releases identity and store without creating an importer', async () => {
  mocks.lease.mockResolvedValue(null);
  await expect(openDestinationTransfer(invite)).rejects.toThrow('another tab');
  expect(mocks.disposeIdentity).toHaveBeenCalledOnce();
  expect(mocks.closeStore).toHaveBeenCalledOnce();
  expect(mocks.constructWorker).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
});

test('worker constructor failure releases the acquired lease and identity', async () => {
  mocks.constructWorker.mockImplementation(() => {
    throw new Error('worker unavailable');
  });
  await expect(openDestinationTransfer(invite)).rejects.toThrow('worker unavailable');
  expect(mocks.disposeIdentity).toHaveBeenCalledOnce();
  expect(mocks.closeLease).toHaveBeenCalledOnce();
  expect(mocks.closeStore).toHaveBeenCalledOnce();
});

test('link initialization failure shuts down the importer and preserves the original error', async () => {
  mocks.open.mockRejectedValue(new Error('connection failed'));
  mocks.shutdown.mockRejectedValue(new Error('shutdown failed'));
  await expect(openDestinationTransfer(invite)).rejects.toThrow('connection failed');
  expect(mocks.shutdown).toHaveBeenCalledOnce();
  expect(mocks.disposeIdentity).toHaveBeenCalledOnce();
  expect(mocks.closeLease).toHaveBeenCalledOnce();
  expect(mocks.closeStore).toHaveBeenCalledOnce();
});

test('lease loss during open rejects and closes the late browser', async () => {
  let leaseOptions: GameWriterLeaseOptions | undefined;
  mocks.lease.mockImplementation(
    async (_game: string, _self: string, options: GameWriterLeaseOptions) => {
      leaseOptions = options;
      return { close: mocks.closeLease };
    },
  );
  mocks.open.mockImplementation(async () => {
    // The callback receives a specific storage error in production; its value is not consumed here.
    const error = Object.assign(new Error('lost'), { code: 'lost' as const });
    leaseOptions?.onLost?.(error);
    return { close: mocks.closeBrowser };
  });
  await expect(openDestinationTransfer(invite)).rejects.toThrow('elsewhere');
  expect(mocks.fail).toHaveBeenCalledOnce();
  expect(mocks.closeBrowser).toHaveBeenCalledOnce();
  expect(mocks.shutdown).toHaveBeenCalledOnce();
  expect(mocks.closeLease).toHaveBeenCalledOnce();
  expect(mocks.closeStore).toHaveBeenCalledOnce();
});

test('close is idempotent and cleans up even when browser shutdown rejects', async () => {
  const handle = await openDestinationTransfer(invite);
  mocks.closeBrowser.mockRejectedValue(new Error('browser shutdown failed'));
  const closing = handle.close();
  expect(handle.close()).toBe(closing);
  await expect(closing).rejects.toThrow('browser shutdown failed');
  expect(mocks.shutdown).toHaveBeenCalledOnce();
  expect(mocks.disposeIdentity).toHaveBeenCalledOnce();
  expect(mocks.closeLease).toHaveBeenCalledOnce();
  expect(mocks.closeStore).toHaveBeenCalledOnce();
});
