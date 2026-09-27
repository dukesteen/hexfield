// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { TransferDestinationScreen } from './TransferDestinationScreen.js';
import { openDestinationTransfer } from '../../queries/online-transfers.js';
import type { OnlineTransferBrowserSnapshot } from '../../session/online-transfer-browser.js';
import type { DestinationTransferHandle } from '../../queries/online-transfers.js';

const { navigate } = vi.hoisted(() => ({
  navigate: vi.fn<(options: unknown) => Promise<void>>(async () => undefined),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler;
  }) => (
    <a href="/" onClick={onClick}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../session/online-transfer-link.js', () => ({
  decodeTransferInvite: () => ({ body: { sourceDevice: 'source-device' } }),
}));
vi.mock('../../queries/online-transfers.js', () => ({
  openDestinationTransfer: vi.fn<() => Promise<DestinationTransferHandle>>(),
  useDestinationTransfer: () => ({ mutateAsync: openDestinationTransfer }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function destination() {
  let snapshot: Omit<OnlineTransferBrowserSnapshot, 'invite'> = {
    role: 'destination',
    selfDevice: 'destination-device',
    selectedDevice: 'source-device',
    candidates: [],
    phase: 'awaiting-confirmation',
    busy: false,
    error: null,
    promotedGameId: null,
    closed: false,
  };
  const listeners = new Set<() => void>();
  const close = vi.fn<() => Promise<void>>(async () => undefined);
  const retry = vi.fn<() => Promise<void>>(async () => undefined);
  const handle = {
    browser: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      getSnapshot: () => snapshot,
      retry,
    },
    close,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The component uses this handle's public browser subscription methods only.
  } as unknown as DestinationTransferHandle;
  return {
    handle,
    close,
    retry,
    update: (next: Partial<typeof snapshot>) => {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
  };
}

test('starts only on explicit action, then closes importer before opening the promoted game', async () => {
  const opened = destination();
  vi.mocked(openDestinationTransfer).mockResolvedValue(opened.handle);
  const page = render(<TransferDestinationScreen code="signed-code" />);
  expect(openDestinationTransfer).not.toHaveBeenCalled();
  fireEvent.click(page.getByRole('button', { name: 'lobby:transferStart' }));
  await waitFor(() => expect(page.getByRole('status')).toBeTruthy());
  expect(openDestinationTransfer).toHaveBeenCalledOnce();
  expect(page.queryByRole('button', { name: 'lobby:transferCancel' })).toBeNull();

  opened.update({ phase: 'activated', promotedGameId: 'promoted-game' });
  await waitFor(() =>
    expect(page.getByRole('button', { name: 'lobby:transferOpenGame' })).toBeTruthy(),
  );
  fireEvent.click(page.getByRole('button', { name: 'lobby:transferOpenGame' }));
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: '/game/$gameId',
      params: { gameId: 'promoted-game' },
    }),
  );
  expect(opened.close).toHaveBeenCalledOnce();
  expect(opened.close.mock.invocationCallOrder[0]).toBeLessThan(
    navigate.mock.invocationCallOrder[0] ?? 0,
  );
  page.unmount();
});

test('a late importer open closes after unmount without opening a game', async () => {
  const opened = destination();
  let finish!: (value: DestinationTransferHandle) => void;
  vi.mocked(openDestinationTransfer).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const page = render(<TransferDestinationScreen code="signed-code" />);
  fireEvent.click(page.getByRole('button', { name: 'lobby:transferStart' }));
  page.unmount();
  finish(opened.handle);
  await waitFor(() => expect(opened.close).toHaveBeenCalledOnce());
  expect(navigate).not.toHaveBeenCalled();
});

test('leaving during an importer open rejects its late result', async () => {
  const opened = destination();
  let finish!: (value: DestinationTransferHandle) => void;
  vi.mocked(openDestinationTransfer).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const page = render(<TransferDestinationScreen code="signed-code" />);
  fireEvent.click(page.getByRole('button', { name: 'lobby:transferStart' }));
  fireEvent.click(page.getByText('lobby:backHome'));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/' }));
  finish(opened.handle);
  await waitFor(() => expect(opened.close).toHaveBeenCalledOnce());
  expect(navigate).toHaveBeenCalledTimes(1);
});
