// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GameScreenGuards, UpdatePrompt } from './PwaNotices.js';
import { createUpdateStore } from './update-store.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

test('the update prompt waits while a game is open and reloads only on confirmation', async () => {
  const reload = vi.fn<() => void>();
  const activate = vi.fn<() => Promise<void>>(async () => undefined);
  const store = createUpdateStore({ reload });
  const page = render(<UpdatePrompt path="/local/game-1" store={store} />);
  act(() => store.needRefresh(activate));
  expect(page.queryByText('common:pwaUpdateAvailable')).toBeNull();
  expect(activate).not.toHaveBeenCalled();

  page.rerender(<UpdatePrompt path="/game/online-1" store={store} />);
  expect(page.queryByText('common:pwaUpdateAvailable')).toBeNull();

  page.rerender(<UpdatePrompt path="/" store={store} />);
  expect(page.getByText('common:pwaUpdateAvailable')).toBeTruthy();
  await act(async () =>
    fireEvent.click(page.getByRole('button', { name: 'common:pwaUpdateReload' })),
  );
  expect(activate).toHaveBeenCalledOnce();
  act(() => store.controllerChanged());
  expect(reload).toHaveBeenCalledOnce();
});

test('"Later" hides the prompt without updating', () => {
  const reload = vi.fn<() => void>();
  const store = createUpdateStore({ reload });
  const page = render(<UpdatePrompt path="/settings" store={store} />);
  act(() => store.needRefresh(async () => undefined));
  fireEvent.click(page.getByRole('button', { name: 'common:pwaUpdateLater' }));
  expect(page.queryByText('common:pwaUpdateAvailable')).toBeNull();
  expect(reload).not.toHaveBeenCalled();
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

test('online games warn after the tab was backgrounded; local games do not', () => {
  vi.useFakeTimers();
  try {
    const local = render(<GameScreenGuards path="/local/game-1" />);
    setVisibility('hidden');
    vi.advanceTimersByTime(5000);
    act(() => setVisibility('visible'));
    expect(local.queryByText('common:pwaBackgroundWarning')).toBeNull();
    local.unmount();

    const online = render(<GameScreenGuards path="/game/online-1" />);
    act(() => setVisibility('hidden'));
    vi.advanceTimersByTime(5000);
    act(() => setVisibility('visible'));
    expect(online.getByText('common:pwaBackgroundWarning')).toBeTruthy();
    fireEvent.click(online.getByRole('button', { name: 'common:pwaDismiss' }));
    expect(online.queryByText('common:pwaBackgroundWarning')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
