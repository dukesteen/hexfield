// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { GameConfig } from '@cp2p/engine';
import { standardFixedBoard } from '@cp2p/maps';
import { LocalSession } from '../session/local-session.js';
import { getWebRepositories } from './hooks.js';
import { MemoryStorage } from './repositories/storage.js';
import { useReplay } from './transfers.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('useReplay reads a persisted save through Query and verifies its full authority', async () => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  const config: GameConfig = {
    modules: [{ id: 'base', version: '1.0.0' }],
    seats: [0, 1],
    options: { base: { mapLayout: 'standard-fixed' } },
    board: standardFixedBoard(),
  };
  const made = LocalSession.create({
    config,
    humanSeats: [0, 1],
    botSeats: [],
    genesisSeed: new Uint8Array(32).fill(5),
  });
  if (!made.ok) throw new Error(made.error.message);
  const save = made.value.exportSave();
  made.value.dispose();
  const repository = getWebRepositories().savedGames;
  const id = crypto.randomUUID();
  const record = await repository.save({
    id,
    revision: save.genesis.length,
    presentation: {
      players: [
        { seat: 0, name: 'Ari', color: 'blue', shape: 'circle' },
        { seat: 1, name: 'Bea', color: 'orange', shape: 'triangle' },
      ],
      botDelayMs: 500,
    },
    save,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  try {
    const query = renderHook(() => useReplay(id), { wrapper });
    await waitFor(() => expect(query.result.current.isSuccess).toBe(true));
    expect(query.result.current.data?.finalHash).toBe(save.finalHash);
    expect(query.result.current.data?.presentation).toEqual(record.presentation);
    expect(query.result.current.data?.inputs).toEqual(save.genesis);
    query.unmount();
  } finally {
    await repository.remove(id, save.genesis.length);
    client.clear();
  }
});
