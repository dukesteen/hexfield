// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_NETWORK_SETTINGS } from '../../queries/network-config';
import type { NetworkSettings } from '../../queries/network-config';
import { OnlineCreate } from './OnlineCreate';

const fixtures = vi.hoisted(() => ({
  network: null as null | NetworkSettings,
  loading: false,
  begin: vi.fn<() => { promise: Promise<never>; cancel: () => void; keep: () => void }>(() => ({
    promise: new Promise<never>(() => undefined),
    cancel: vi.fn<() => void>(),
    keep: vi.fn<() => void>(),
  })),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  useNavigate: () => vi.fn<() => void>(),
}));
vi.mock('../../queries/hooks', () => ({
  useSettings: () => ({
    data: fixtures.network ? { network: fixtures.network } : undefined,
    isLoading: fixtures.loading,
  }),
}));
vi.mock('./room-registry.js', () => ({
  beginOnlineRoomOpen: fixtures.begin,
  closeOnlineRoom: vi.fn<() => void>(),
}));

afterEach(() => {
  cleanup();
  fixtures.network = null;
  fixtures.loading = false;
  fixtures.begin.mockClear();
});

test('asynchronously loaded signaling chooses server, while an explicit manual choice survives later settings', () => {
  fixtures.loading = true;
  const page = render(<OnlineCreate />);
  const method = page.getByLabelText('lobby:manualConnectionMethod');
  expect(method).toHaveProperty('value', 'manual');
  expect(page.getByRole('button', { name: 'lobby:onlineCreateAction' })).toHaveProperty(
    'disabled',
    true,
  );
  fixtures.network = { ...DEFAULT_NETWORK_SETTINGS, signalingUrl: 'wss://saved.example' };
  fixtures.loading = false;
  page.rerender(<OnlineCreate />);
  expect(method).toHaveProperty('value', 'server');
  expect(page.getByLabelText('lobby:onlineServerOrigin')).toHaveProperty(
    'value',
    'wss://saved.example',
  );
  fireEvent.change(method, { target: { value: 'manual' } });
  fixtures.network = { ...DEFAULT_NETWORK_SETTINGS, signalingUrl: 'wss://later.example' };
  page.rerender(<OnlineCreate />);
  expect(method).toHaveProperty('value', 'manual');
});

test('host create uses the saved custom server and allows a manual override', () => {
  fixtures.network = { ...DEFAULT_NETWORK_SETTINGS, signalingUrl: 'wss://custom.example' };
  const page = render(<OnlineCreate />);
  fireEvent.change(page.getByLabelText('lobby:onlineRoomName'), { target: { value: 'Friends' } });
  fireEvent.change(page.getByLabelText('lobby:onlineHostName'), { target: { value: 'Duke' } });
  const form = page.container.querySelector('form');
  if (!form) throw new Error('Missing host form');
  fireEvent.submit(form);
  expect(fixtures.begin).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ kind: 'host', serverUrl: 'wss://custom.example' }),
  );
});
