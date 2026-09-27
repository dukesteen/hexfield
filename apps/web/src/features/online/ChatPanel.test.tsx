// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { success } from '@cp2p/engine';
import type { PeerId } from '@cp2p/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import type { ChatContent, ChatSnapshot } from '../../session/online-chat.js';
import { ChatPanel } from './ChatPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

const self = 'A'.repeat(43);
const other = 'B'.repeat(43);
const snapshot: ChatSnapshot = {
  scope: { kind: 'lobby', roomId: 'chatroomaa' },
  events: [],
  muted: [],
  error: null,
  ready: true,
};

test('chat sends text and emotes, blocks overlong drafts, and offers local mute', async () => {
  const sendChat = vi.fn<(content: ChatContent) => Promise<ReturnType<typeof success<void>>>>(
    async () => success(undefined),
  );
  const muteChat = vi.fn<
    (peer: PeerId, muted: boolean) => Promise<ReturnType<typeof success<void>>>
  >(async () => success(undefined));
  const page = render(
    <ChatPanel
      room={{ sendChat, muteChat }}
      chat={snapshot}
      labels={
        new Map([
          [self, 'Alice'],
          [other, 'Bob'],
        ])
      }
      self={self}
    />,
  );
  const input = page.getByLabelText('lobby:chatMessage');
  fireEvent.change(input, { target: { value: 'x'.repeat(301) } });
  expect(page.getByRole('button', { name: 'lobby:chatSend' })).toHaveProperty('disabled', true);
  expect(page.getByRole('alert').textContent).toBe('lobby:chatTooLong');
  fireEvent.change(input, { target: { value: 'Hello' } });
  fireEvent.click(page.getByRole('button', { name: 'lobby:chatSend' }));
  await vi.waitFor(() => expect(sendChat).toHaveBeenCalledWith({ kind: 'text', text: 'Hello' }));
  await vi.waitFor(() =>
    expect(page.getByRole('button', { name: 'lobby:chatEmote.wave' })).toHaveProperty(
      'disabled',
      false,
    ),
  );
  fireEvent.click(page.getByRole('button', { name: 'lobby:chatEmote.wave' }));
  await vi.waitFor(() => expect(sendChat).toHaveBeenCalledWith({ kind: 'emote', emote: 'wave' }));
  fireEvent.click(page.getByRole('button', { name: 'lobby:chatMutePlayer' }));
  await vi.waitFor(() => expect(muteChat).toHaveBeenCalledWith(other, true));
});
