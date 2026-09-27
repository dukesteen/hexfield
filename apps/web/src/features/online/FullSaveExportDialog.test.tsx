// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { FullSaveExportDialog } from './FullSaveExportDialog.js';

const mocks = vi.hoisted(() => ({
  export: vi.fn<() => Promise<Uint8Array>>(async () => new Uint8Array([1, 2, 3])),
  close: vi.fn<() => void>(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../queries/online-full-saves.js', () => ({
  useExportOnlineFullSave: () => ({ isPending: false, mutateAsync: mocks.export }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function mockDownloadUrl() {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
}

test('exports public history by default without requesting private material', async () => {
  mockDownloadUrl();
  render(<FullSaveExportDialog gameId={'g'.repeat(22)} onClose={mocks.close} />);
  fireEvent.click(screen.getByRole('button', { name: 'lobby:fullSaveExport' }));
  await waitFor(() =>
    expect(mocks.export).toHaveBeenCalledWith({ gameId: 'g'.repeat(22), includePrivate: false }),
  );
  expect(mocks.close).toHaveBeenCalledOnce();
});

test('private material requires an explicit choice and a passphrase before export', async () => {
  mockDownloadUrl();
  render(<FullSaveExportDialog gameId={'g'.repeat(22)} onClose={mocks.close} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'lobby:fullSaveIncludePrivate' }));
  const submit = screen.getByRole('button', { name: 'lobby:fullSaveExport' });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('lobby:fullSavePassphrase'), {
    target: { value: 'a-long-safe-passphrase' },
  });
  expect((submit as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(submit);
  await waitFor(() =>
    expect(mocks.export).toHaveBeenCalledWith({
      gameId: 'g'.repeat(22),
      includePrivate: true,
      passphrase: 'a-long-safe-passphrase',
    }),
  );
});
