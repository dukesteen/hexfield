// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useResumableGames } from './online-games.js';

const mocks = vi.hoisted(() => ({
  acquireScope: vi.fn<(close: () => Promise<void>) => Promise<object>>(),
  releaseScope: vi.fn<(scope: object) => Promise<void>>(),
  constructStore: vi.fn<(options: { vault: object }) => void>(),
  closeStore: vi.fn<() => Promise<void>>(),
  list: vi.fn<
    () => Promise<{ games: readonly unknown[]; unavailableGameIds: readonly string[] }>
  >(),
  loadOutcome: vi.fn<() => Promise<unknown>>(),
  loadVoid: vi.fn<() => Promise<unknown>>(),
  loadActivity: vi.fn<() => Promise<unknown>>(),
  deriveStats: vi.fn<() => unknown>(),
}));

vi.mock('../session/online-vault-controller.js', () => ({
  getOnlineVaultController: () => ({
    acquireScope: mocks.acquireScope,
    releaseScope: mocks.releaseScope,
  }),
}));
vi.mock('@cp2p/storage', () => ({
  IndexedDbByteStore: class {
    constructor(options: { vault: object }) {
      mocks.constructStore(options);
    }
    close = mocks.closeStore;
  },
}));
vi.mock('../session/online-game-records.js', () => ({
  listOnlineGameRecords: mocks.list,
}));
vi.mock('../session/online-game-history.js', () => ({
  loadOnlineGameOutcome: mocks.loadOutcome,
  loadOnlineGameVoid: mocks.loadVoid,
  deriveOnlineGameStats: mocks.deriveStats,
}));
vi.mock('../session/online-game-activity.js', () => ({
  loadOnlineGameActivity: mocks.loadActivity,
  isOnlineGameAbandoned: () => false,
}));
vi.mock('../session/online-saved-game-client.js', () => ({
  deleteStoredGame: vi.fn<() => void>(),
  exportStoredGameReplay: vi.fn<() => void>(),
}));
vi.mock('../session/online-public-archive-client.js', () => ({
  importPublicReplay: vi.fn<() => void>(),
}));

const scope = { id: 'vault-scope' };

function makeWrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client, children });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.acquireScope.mockImplementation(async () => scope);
  mocks.releaseScope.mockResolvedValue(undefined);
  mocks.closeStore.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue({
    games: [
      {
        gameId: 'G'.repeat(22),
        genesisDigest: 'D'.repeat(43),
        genesis: { seats: [] },
      },
    ],
    unavailableGameIds: [],
  });
  mocks.loadActivity.mockResolvedValue(null);
  mocks.loadVoid.mockResolvedValue(null);
  mocks.deriveStats.mockReturnValue({ gamesPlayed: 0, wins: 0, averageVictoryPoints: null });
});

afterEach(() => cleanup());

test('a voided game has no winner and contributes no audited statistics', async () => {
  mocks.loadVoid.mockResolvedValue({ head: { seq: 8, hash: 'a'.repeat(64) } });
  mocks.loadOutcome.mockResolvedValue({ audit: { status: 'verified' }, terminal: { winner: 0 } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const query = renderHook(() => useResumableGames(), { wrapper: makeWrapper(client) });
  await waitFor(() => expect(query.result.current.isSuccess).toBe(true));
  expect(query.result.current.data?.games[0]).toMatchObject({ outcome: null, abandoned: false });
  expect(mocks.deriveStats).toHaveBeenCalledWith([]);
});

test('binds protected history reads to vault scope and drains before releasing it on lock', async () => {
  let closeScope!: () => Promise<void>;
  mocks.acquireScope.mockImplementation(async (close) => {
    closeScope = close;
    return scope;
  });

  let finishOutcome!: (value: null) => void;
  mocks.loadOutcome.mockImplementation(() => new Promise((resolve) => (finishOutcome = resolve)));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const query = renderHook(() => useResumableGames(), { wrapper: makeWrapper(client) });
  await waitFor(() => expect(mocks.loadOutcome).toHaveBeenCalledOnce());
  expect(mocks.constructStore).toHaveBeenCalledWith({ vault: scope });

  let lockFinished = false;
  const locking = (async () => {
    await closeScope();
    lockFinished = true;
  })();
  await Promise.resolve();
  expect(lockFinished).toBe(false);
  expect(mocks.releaseScope).not.toHaveBeenCalled();

  await act(async () => {
    finishOutcome(null);
    await locking;
  });
  expect(mocks.closeStore).toHaveBeenCalledOnce();
  expect(mocks.releaseScope).toHaveBeenCalledWith(scope);
  await waitFor(() => expect(query.result.current.isError).toBe(true));
  query.unmount();
  await client.cancelQueries();
  client.clear();
});

test('a locked vault fails the query before opening an unbound byte store', async () => {
  mocks.acquireScope.mockRejectedValue(new Error('Vault is locked'));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const query = renderHook(() => useResumableGames(), { wrapper: makeWrapper(client) });
  await waitFor(() => expect(query.result.current.isError).toBe(true));
  expect(mocks.constructStore).not.toHaveBeenCalled();
  expect(mocks.list).not.toHaveBeenCalled();
  query.unmount();
  client.clear();
});
