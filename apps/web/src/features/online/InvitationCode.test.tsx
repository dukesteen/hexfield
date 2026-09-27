// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import lobby from '../../i18n/locales/en/lobby.json';
import { InvitationCode } from './InvitationCode.js';

const i18n = createInstance();

beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { lobby } }, initImmediate: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderInvitation() {
  return render(
    <I18nextProvider i18n={i18n}>
      <InvitationCode value="https://example.test/invite/abc123" label="Game invitation" />
    </I18nextProvider>,
  );
}

test('opens the enlarged QR from its dedicated accessible control and restores focus on close', async () => {
  renderInvitation();
  const trigger = screen.getByRole('button', { name: 'Enlarge QR code for Game invitation' });
  fireEvent.click(trigger);

  const dialog = screen.getByRole('dialog', { name: 'Game invitation QR code' });
  expect(dialog.querySelector('.invitation-qr-large')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close QR code' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test('Escape and backdrop close the enlarged QR, while clicks inside it do not', async () => {
  renderInvitation();
  const trigger = screen.getByRole('button', { name: 'Enlarge QR code for Game invitation' });
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog');
  const enlargedQr = dialog.querySelector('.invitation-qr-large');
  if (!enlargedQr) throw new Error('Expected an enlarged QR image');
  fireEvent.click(enlargedQr);
  expect(screen.getByRole('dialog')).toBeTruthy();

  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('dialog'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('copy and invitation text controls do not open the QR view', () => {
  const writeText = vi.fn<() => Promise<void>>(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  renderInvitation();
  fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
  fireEvent.click(screen.getByLabelText('Game invitation'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(writeText).toHaveBeenCalledWith('https://example.test/invite/abc123');
});

test('closing an enlarged code does not dismiss its surrounding reconnect or transfer dialog', () => {
  const cancelParent = vi.fn<() => void>();
  const closeParent = vi.fn<() => void>();
  render(
    <I18nextProvider i18n={i18n}>
      <dialog open aria-label="Reconnect" onCancel={cancelParent} onClose={closeParent}>
        <InvitationCode value="https://example.test/invite/abc123" label="Game invitation" />
      </dialog>
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Enlarge QR code for Game invitation' }));
  const enlarged = screen.getByRole('dialog', { name: 'Game invitation QR code' });
  fireEvent(enlarged, new Event('cancel', { cancelable: true }));
  expect(cancelParent).not.toHaveBeenCalled();
  expect(closeParent).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'Reconnect' })).toBeTruthy();
});
