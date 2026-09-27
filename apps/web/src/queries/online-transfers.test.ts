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
  storeOptions: vi.fn<(options: { vault: object }) => void>(),
  workerOptions: vi.fn<(options: { vaultHandoff: object }) => void>(),
  closeStore: vi.fn<() => Promise<void>>(),
  disposeIdentity: vi.fn<() => void>(),
  closeLease: vi.fn<() => Promise<void>>(),
  closeBrowser: vi.fn<() => Promise<void>>(),
  releaseVault: vi.fn<() => Promise<void>>(),
  acquireVault: vi.fn<(close: () => Promise<void>) => Promise<{ handoff: () => object }>>(),
  vaultHandoff: vi.fn<() => object>(),
  vaultScope: { handoff: vi.fn<() => object>() },
  vault: {} as object,
  shutdown: vi.fn<() => Promise<void>>(),
  fail: vi.fn<(error: Error) => void>(),
}));

vi.mock('./network.js', () => ({ loadOnlineConnectionSettings: mocks.network }));
vi.mock('../session/online-credentials.js', () => ({ loadOrCreateOnlineIdentity: mocks.identity }));
vi.mock('../session/online-vault-controller.js', () => ({
  getOnlineVaultController: () => ({
    acquireScope: mocks.acquireVault,
    releaseScope: mocks.releaseVault,
  }),
}));
vi.mock('@cp2p/storage', () => ({
  IndexedDbByteStore: class {
    constructor(options: { vault: object }) {
      mocks.storeOptions(options);
    }
    close = mocks.closeStore;
  },
  acquireGameWriterLease: mocks.lease,
}));
vi.mock('../session/online-worker-client.js', () => ({
  OnlineWorkerClient: class {
    constructor(options: { vaultHandoff: object }) {
      mocks.workerOptions(options);
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
    protocol: 'cp2p/online-transfer-invite/v6' as const,
    roomId: 'transferaa',
    attemptId: 'A'.repeat(43),
    gameId: 'g'.repeat(22),
    genesisDigest: 'B'.repeat(43),
    seat: 0 as const,
    mode: 'live' as const,
    sourceDevice: 'C'.repeat(43),
    serverUrl: 'wss://example.com',
  },
  sig: 'D'.repeat(86),
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.network.mockResolvedValue({ iceServers: [], iceTransportPolicy: 'all' });
  mocks.identity.mockResolvedValue({ peerId: 'destination', dispose: mocks.disposeIdentity });
  mocks.vaultHandoff.mockReturnValue(mocks.vault);
  mocks.vaultScope.handoff.mockReturnValue(mocks.vault);
  mocks.acquireVault.mockImplementation(async () => mocks.vaultScope);
  mocks.lease.mockResolvedValue({ close: mocks.closeLease });
  mocks.open.mockResolvedValue({ close: mocks.closeBrowser });
  for (const close of [mocks.closeStore, mocks.closeLease, mocks.closeBrowser, mocks.shutdown])
    close.mockResolvedValue(undefined);
});

test('identity failure closes the store before any worker is created', async () => {
  mocks.identity.mockRejectedValue(new Error('identity unavailable'));
  await expect(openDestinationTransfer(invite)).rejects.toThrow('identity unavailable');
  expect(mocks.closeStore).toHaveBeenCalledOnce();
  expect(mocks.releaseVault).toHaveBeenCalledOnce();
  expect(mocks.constructWorker).not.toHaveBeenCalled();
});

test('writer contention releases identity and store without creating an importer', async () => {
  mocks.lease.mockResolvedValue(null);
  await expect(openDestinationTransfer(invite)).rejects.toThrow('another tab');
  expect(mocks.disposeIdentity).toHaveBeenCalledOnce();
  expect(mocks.closeStore).toHaveBeenCalledOnce();
  expect(mocks.releaseVault).toHaveBeenCalledOnce();
  expect(mocks.constructWorker).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
});

test('vault lock during identity loading disposes the late identity and prevents transfer startup', async () => {
  let identityReady!: (identity: { peerId: string; dispose: () => void }) => void;
  mocks.identity.mockImplementation(
    () =>
      new Promise((resolve) => {
        identityReady = resolve;
      }),
  );
  let closeScope!: () => Promise<void>;
  mocks.acquireVault.mockImplementation(async (close) => {
    closeScope = close;
    return { handoff: mocks.vaultHandoff };
  });

  const opening = openDestinationTransfer(invite);
  await vi.waitFor(() => expect(identityReady).toBeTypeOf('function'));
  await closeScope();
  identityReady({ peerId: 'destination', dispose: mocks.disposeIdentity });

  await expect(opening).rejects.toThrow('Transfer storage was closed');
  expect(mocks.disposeIdentity).toHaveBeenCalledOnce();
  expect(mocks.lease).not.toHaveBeenCalled();
  expect(mocks.constructWorker).not.toHaveBeenCalled();
  expect(mocks.closeStore).toHaveBeenCalledOnce();
  expect(mocks.releaseVault).toHaveBeenCalledOnce();
});

test('opens the imported checkpoint transfer with its immutable archive identifier', async () => {
  const archiveId = 'e'.repeat(64);
  const handle = await openDestinationTransfer(invite, archiveId);
  expect(mocks.storeOptions).toHaveBeenCalledWith({ vault: mocks.vaultScope });
  expect(mocks.workerOptions).toHaveBeenCalledWith({ vaultHandoff: mocks.vault });
  expect(mocks.open).toHaveBeenCalledWith(
    expect.objectContaining({ importedArchiveId: archiveId }),
  );
  await handle.close();
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
