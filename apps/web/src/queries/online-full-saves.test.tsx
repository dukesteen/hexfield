// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useExportOnlineFullSave, useImportOnlineFullSave } from './online-full-saves.js';

const mocks = vi.hoisted(() => ({
  exportSave: vi.fn<(...args: unknown[]) => Promise<Uint8Array>>(),
  importSave: vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(),
}));
vi.mock('../session/online-full-save-client.js', () => ({
  exportStoredOnlineFullSave: mocks.exportSave,
  importOnlineFullSaveFile: mocks.importSave,
  listImportedOnlineFullSaves: vi.fn<() => void>(),
  openImportedOnlineFullSave: vi.fn<() => void>(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test.each(['export', 'import'] as const)(
  '%s keeps its passphrase outside the mutation cache during and after work',
  async (operation) => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mocks.exportSave.mockImplementation(async () => {
      await waiting;
      return Uint8Array.of(1);
    });
    mocks.importSave.mockImplementation(async () => {
      await waiting;
      return { id: 'verified-import' };
    });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(
      () => ({ exported: useExportOnlineFullSave(), imported: useImportOnlineFullSave() }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    const passphrase = 'private capsule test phrase';
    const task =
      operation === 'export'
        ? result.current.exported.mutateAsync({
            gameId: 'test-game',
            includePrivate: true,
            passphrase,
          })
        : result.current.imported.mutateAsync({ bytes: Uint8Array.of(2), passphrase });
    await waitFor(() =>
      expect(client.getMutationCache().getAll()[0]?.state.status).toBe('pending'),
    );
    const cache = client.getMutationCache().getAll();
    expect(cache).toHaveLength(1);
    expect(cache[0]?.options.gcTime).toBe(0);
    expect(cache[0]?.state.variables).toBeUndefined();
    expect(JSON.stringify(cache.map((mutation) => mutation.state))).not.toContain(passphrase);
    await act(async () => {
      finish();
      await task;
    });
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state),
      ),
    ).not.toContain(passphrase);
  },
);
