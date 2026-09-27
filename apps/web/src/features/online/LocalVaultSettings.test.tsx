// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { VaultError } from '@cp2p/storage';
import { LocalVaultGate } from './LocalVaultGate.js';
import { LocalVaultSettings } from './LocalVaultSettings.js';

const mocks = vi.hoisted(() => {
  type State = {
    mode: 'clear' | 'locked';
    state: 'loading' | 'ready' | 'locked' | 'busy' | 'error';
    generation: number;
  };
  const listeners = new Set<() => void>();
  const state: State = { mode: 'locked', state: 'locked', generation: 1 };
  const publish = () => listeners.forEach((listener) => listener());
  const update = (mode: State['mode'], next: State['state']) => {
    state.mode = mode;
    state.state = next;
    publish();
  };
  const controller = {
    ready: vi.fn<() => Promise<State>>(async () => ({ ...state })),
    snapshot: vi.fn<() => State>(() => ({ ...state })),
    subscribe: vi.fn<(listener: () => void) => () => void>((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    lock: vi.fn<() => Promise<void>>(async () => update('locked', 'locked')),
    unlock: vi.fn<(passphrase: string) => Promise<void>>(async () => update('locked', 'ready')),
    enable: vi.fn<(passphrase: string) => Promise<void>>(async () => update('locked', 'ready')),
    disable: vi.fn<(passphrase: string) => Promise<void>>(async () => update('clear', 'ready')),
    changePassphrase: vi.fn<(oldPassphrase: string, nextPassphrase: string) => Promise<void>>(
      async () => update('locked', 'ready'),
    ),
  };
  return {
    controller,
    setSnapshot: (mode: State['mode'], next: State['state']) => update(mode, next),
    clearListeners: () => listeners.clear(),
  };
});

vi.mock('../../session/online-vault-controller.js', () => ({
  getOnlineVaultController: () => mocks.controller,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/local/new">{children}</a>,
}));

function renderWithClient(child: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  const view = render(<QueryClientProvider client={client}>{child}</QueryClientProvider>);
  return { ...view, client };
}

beforeEach(() => {
  mocks.clearListeners();
  mocks.setSnapshot('locked', 'locked');
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('a locked gate does not mount protected children, then mounts them after unlock', async () => {
  renderWithClient(
    <LocalVaultGate bypass={false}>
      <div>protected signer</div>
    </LocalVaultGate>,
  );
  expect(screen.queryByText('protected signer')).toBeNull();
  fireEvent.change(await screen.findByLabelText('common:vault.passphrase'), {
    target: { value: 'correct vault phrase' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common:vault.unlock' }));
  await waitFor(() => expect(screen.getByText('protected signer')).toBeTruthy());
  expect(mocks.controller.unlock).toHaveBeenCalledWith('correct vault phrase');
});

test('a wrong passphrase keeps the gate closed and clears the password input', async () => {
  mocks.controller.unlock.mockRejectedValueOnce(
    new VaultError('invalid-key', 'Incorrect passphrase'),
  );
  renderWithClient(
    <LocalVaultGate bypass={false}>
      <div>protected signer</div>
    </LocalVaultGate>,
  );
  const input = await screen.findByLabelText('common:vault.passphrase');
  fireEvent.change(input, { target: { value: 'wrong vault phrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'common:vault.unlock' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe('common:vault.wrongPassphrase'),
  );
  expect(input).toHaveProperty('value', '');
  expect(screen.queryByText('protected signer')).toBeNull();
});

test('new passphrase confirmation mismatch blocks enabling the vault', async () => {
  mocks.setSnapshot('clear', 'ready');
  renderWithClient(<LocalVaultSettings />);
  fireEvent.change(await screen.findByLabelText('common:vault.newPassphrase'), {
    target: { value: 'first safe phrase' },
  });
  fireEvent.change(await screen.findByLabelText('common:vault.confirmPassphrase'), {
    target: { value: 'different safe phrase' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common:vault.enable' }));
  expect(screen.getByRole('alert').textContent).toBe('common:vault.mismatch');
  expect(mocks.controller.enable).not.toHaveBeenCalled();
});

test('a controller failure keeps protected children closed and shows an error', async () => {
  mocks.setSnapshot('locked', 'error');
  renderWithClient(
    <LocalVaultGate bypass={false}>
      <div>protected signer</div>
    </LocalVaultGate>,
  );
  expect((await screen.findByRole('alert')).textContent).toBe('common:vault.failed');
  expect(screen.queryByText('protected signer')).toBeNull();
});

test('the enable passphrase stays out of mutation variables and cache while pending and after settle', async () => {
  mocks.setSnapshot('clear', 'ready');
  let finish!: () => void;
  mocks.controller.enable.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { client } = renderWithClient(<LocalVaultSettings />);
  const secret = 'private vault phrase';
  fireEvent.change(await screen.findByLabelText('common:vault.newPassphrase'), {
    target: { value: secret },
  });
  fireEvent.change(await screen.findByLabelText('common:vault.confirmPassphrase'), {
    target: { value: secret },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common:vault.enable' }));
  await waitFor(() => expect(mocks.controller.enable).toHaveBeenCalledWith(secret));

  const pending = client.getMutationCache().getAll();
  expect(pending.length).toBeGreaterThan(0);
  expect(pending.every((mutation) => mutation.options.gcTime === 0)).toBe(true);
  expect(pending.every((mutation) => mutation.state.variables === undefined)).toBe(true);
  expect(JSON.stringify(pending.map((mutation) => mutation.state))).not.toContain(secret);
  expect(screen.getByLabelText('common:vault.newPassphrase')).toHaveProperty('value', '');
  expect(screen.getByLabelText('common:vault.confirmPassphrase')).toHaveProperty('value', '');

  await act(async () => {
    finish();
    mocks.setSnapshot('locked', 'ready');
  });
  await waitFor(() => expect(screen.getByText('common:vault.unlocked')).toBeTruthy());
  expect(
    JSON.stringify(
      client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state),
    ),
  ).not.toContain(secret);
});

test('lock, change-passphrase, and disable controls invoke only their selected operation', async () => {
  mocks.setSnapshot('locked', 'ready');
  const view = renderWithClient(<LocalVaultSettings />);
  fireEvent.click(await screen.findByRole('button', { name: 'common:vault.lock' }));
  await waitFor(() => expect(mocks.controller.lock).toHaveBeenCalledOnce());

  await act(async () => mocks.setSnapshot('locked', 'ready'));
  view.rerender(
    <QueryClientProvider client={view.client}>
      <LocalVaultSettings />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'common:vault.change' }));
  fireEvent.change(await screen.findByLabelText('common:vault.passphrase'), {
    target: { value: 'current safe phrase' },
  });
  fireEvent.change(await screen.findByLabelText('common:vault.newPassphrase'), {
    target: { value: 'next safe phrase' },
  });
  fireEvent.change(await screen.findByLabelText('common:vault.confirmPassphrase'), {
    target: { value: 'next safe phrase' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'common:vault.change' }));
  await waitFor(() =>
    expect(mocks.controller.changePassphrase).toHaveBeenCalledWith(
      'current safe phrase',
      'next safe phrase',
    ),
  );

  await act(async () => mocks.setSnapshot('locked', 'ready'));
  view.rerender(
    <QueryClientProvider client={view.client}>
      <LocalVaultSettings />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'common:vault.disable' }));
  expect(screen.getByText('common:vault.disableHint')).toBeTruthy();
  expect(screen.queryByLabelText('common:vault.confirmPassphrase')).toBeNull();
  fireEvent.change(await screen.findByLabelText('common:vault.passphrase'), {
    target: { value: 'current safe phrase' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'common:vault.disable' }));
  await waitFor(() => expect(mocks.controller.disable).toHaveBeenCalledWith('current safe phrase'));
});
