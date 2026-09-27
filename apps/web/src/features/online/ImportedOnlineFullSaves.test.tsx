// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { OnlineFullSaveClientError } from '../../session/online-full-save-client.js';
import { MAX_ONLINE_FULL_SAVE_BYTES } from '../../session/online-full-save.js';
import { ImportedOnlineFullSaves } from './ImportedOnlineFullSaves.js';

const mocks = vi.hoisted(() => ({
  import: vi.fn<() => Promise<{ id: string; gameId: string }>>(async () => ({
    id: 'a'.repeat(64),
    gameId: 'b'.repeat(22),
  })),
  navigate: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
  useNavigate: () => mocks.navigate,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../queries/online-full-saves.js', () => ({
  useImportedOnlineFullSaves: () => ({ data: [] }),
  useImportOnlineFullSave: () => ({ isPending: false, mutateAsync: mocks.import }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('rejects oversized full-save files before reading them or invoking the worker', () => {
  const read = vi.fn<() => Promise<ArrayBuffer>>(async () => new ArrayBuffer(1));
  render(<ImportedOnlineFullSaves />);
  fireEvent.change(screen.getByLabelText('lobby:fullSaveChoose'), {
    target: { files: [{ size: MAX_ONLINE_FULL_SAVE_BYTES + 1, arrayBuffer: read }] },
  });
  expect(read).not.toHaveBeenCalled();
  expect(mocks.import).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('lobby:fullSaveImportFailed');
});

test('imports a bounded file with the locally entered passphrase and opens its paused view', async () => {
  const read = vi.fn<() => Promise<ArrayBuffer>>(async () => new Uint8Array([1, 2, 3]).buffer);
  render(<ImportedOnlineFullSaves />);
  fireEvent.change(screen.getByLabelText('lobby:fullSaveImportPassphrase'), {
    target: { value: 'safe-example-passphrase' },
  });
  fireEvent.change(screen.getByLabelText('lobby:fullSaveChoose'), {
    target: { files: [{ size: 3, arrayBuffer: read }] },
  });
  expect(await screen.findByText('lobby:fullSaveDescription')).toBeTruthy();
  await vi.waitFor(() =>
    expect(mocks.import).toHaveBeenCalledWith({
      bytes: new Uint8Array([1, 2, 3]),
      passphrase: 'safe-example-passphrase',
    }),
  );
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: '/full-save/$saveId',
    params: { saveId: 'a'.repeat(64) },
  });
});

test('shows distinct messages for a required passphrase and a wrong passphrase', async () => {
  const file = { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  mocks.import
    .mockRejectedValueOnce(new OnlineFullSaveClientError('full-save-passphrase', 'required'))
    .mockRejectedValueOnce(new OnlineFullSaveClientError('full-save-decrypt', 'wrong'));
  render(<ImportedOnlineFullSaves />);
  fireEvent.change(screen.getByLabelText('lobby:fullSaveChoose'), {
    target: { files: [file] },
  });
  expect((await screen.findByRole('alert')).textContent).toContain(
    'lobby:fullSavePassphraseRequired',
  );

  fireEvent.change(screen.getByLabelText('lobby:fullSaveImportPassphrase'), {
    target: { value: 'a-long-safe-passphrase' },
  });
  fireEvent.change(screen.getByLabelText('lobby:fullSaveChoose'), {
    target: { files: [file] },
  });
  expect((await screen.findByRole('alert')).textContent).toContain('lobby:fullSaveWrongPassphrase');
});
