// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { afterEach, expect, test, vi } from 'vitest';
import { LobbyNameEditor } from './LobbyNameEditor';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('name changes save once after a pause, without an initial write', () => {
  vi.useFakeTimers();
  const save = vi.fn<(name: string) => Result<void>>(() => success(undefined));
  const pending = vi.fn<(pending: boolean) => void>();
  const page = render(
    <LobbyNameEditor name="Alice" editable onSave={save} onPendingChange={pending} />,
  );
  expect(save).not.toHaveBeenCalled();
  const input = page.getByLabelText('lobby:onlineYourName');
  fireEvent.change(input, { target: { value: 'Ali' } });
  fireEvent.change(input, { target: { value: 'Alice B' } });
  void act(() => vi.advanceTimersByTime(399));
  expect(save).not.toHaveBeenCalled();
  void act(() => vi.advanceTimersByTime(1));
  expect(save).toHaveBeenCalledExactlyOnceWith('Alice B');
  page.rerender(
    <LobbyNameEditor name="Alice B" editable onSave={save} onPendingChange={pending} />,
  );
  expect(pending).toHaveBeenLastCalledWith(false);
});

test('invalid, reverted and disabled name edits do not save', () => {
  vi.useFakeTimers();
  const save = vi.fn<(name: string) => Result<void>>(() => success(undefined));
  const pending = vi.fn<(pending: boolean) => void>();
  const page = render(
    <LobbyNameEditor name="Alice" editable onSave={save} onPendingChange={pending} />,
  );
  const input = page.getByLabelText('lobby:onlineYourName');
  fireEvent.change(input, { target: { value: '   ' } });
  void act(() => vi.advanceTimersByTime(500));
  expect(save).not.toHaveBeenCalled();
  expect(page.getByRole('alert')).toBeTruthy();
  fireEvent.change(input, { target: { value: 'Bob' } });
  fireEvent.change(input, { target: { value: 'Alice' } });
  void act(() => vi.advanceTimersByTime(500));
  expect(save).not.toHaveBeenCalled();
  expect(pending).toHaveBeenLastCalledWith(false);
  fireEvent.change(input, { target: { value: 'Charlie' } });
  page.rerender(
    <LobbyNameEditor name="Alice" editable={false} onSave={save} onPendingChange={pending} />,
  );
  void act(() => vi.advanceTimersByTime(500));
  expect(save).not.toHaveBeenCalled();
});
