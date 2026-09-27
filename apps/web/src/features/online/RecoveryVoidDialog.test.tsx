// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RecoveryVoidDialog } from './RecoveryVoidDialog.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

test('a void explains the terminal result and lets the player inspect or leave the board', () => {
  const view = vi.fn<() => void>();
  const leave = vi.fn<() => void>();
  render(<RecoveryVoidDialog onViewBoard={view} onLeave={leave} busy={false} leaveError={false} />);
  expect(screen.getByRole('dialog', { name: 'lobby:onlineGameVoidTitle' })).toBeTruthy();
  expect(screen.getByText('lobby:onlineGameVoidBody')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'game:viewBoard' }));
  expect(view).toHaveBeenCalledOnce();
  expect(leave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'game:leave' }));
  expect(leave).toHaveBeenCalledOnce();
});
