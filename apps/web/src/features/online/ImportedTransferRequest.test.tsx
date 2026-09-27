// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ImportedTransferRequest } from './ImportedTransferRequest.js';
import type { OnlineFullSaveDisplay } from '../../session/online-full-save-client.js';

const { navigate } = vi.hoisted(() => ({
  navigate: vi.fn<(options: unknown) => Promise<void>>(async () => undefined),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../session/online-transfer-link.js', () => ({
  parseTransferInviteUrl: (url: string) => {
    if (url === 'invalid') throw new TypeError('Bad invitation');
    return {
      body: {
        gameId: url === 'wrong-game' ? 'x'.repeat(22) : 'g'.repeat(22),
        seat: url === 'wrong-seat' ? 5 : 1,
      },
    };
  },
  encodeTransferInvite: () => 'canonical-signed-code',
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const save = {
  id: 'a'.repeat(64),
  gameId: 'g'.repeat(22),
  players: [
    { seat: 0, name: 'Avery', color: 'blue' },
    { seat: 1, name: 'Blair', color: 'orange' },
  ],
} satisfies Pick<OnlineFullSaveDisplay, 'id' | 'gameId' | 'players'>;

test('binds a matching signed invite to the imported checkpoint before opening transfer', async () => {
  render(<ImportedTransferRequest save={save} />);
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'https://example.test/#/transfer/signed' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'lobby:importTransferContinue' }));
  await vi.waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: '/transfer/$code',
      params: { code: 'canonical-signed-code' },
      search: { archiveId: save.id },
    }),
  );
});

test('rejects malformed invitations, another game and a seat outside the imported roster', () => {
  render(<ImportedTransferRequest save={save} />);
  const input = screen.getByRole('textbox');
  const continueButton = screen.getByRole('button', { name: 'lobby:importTransferContinue' });
  for (const [url, error] of [
    ['invalid', 'lobby:importTransferInvalidInvite'],
    ['wrong-game', 'lobby:importTransferWrongGame'],
    ['wrong-seat', 'lobby:importTransferWrongSeat'],
  ]) {
    fireEvent.change(input, { target: { value: url } });
    fireEvent.click(continueButton);
    expect(screen.getByRole('alert').textContent).toBe(error);
  }
  expect(navigate).not.toHaveBeenCalled();
});
