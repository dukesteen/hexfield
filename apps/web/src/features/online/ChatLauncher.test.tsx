// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { PeerId } from '@cp2p/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import type { ChatContent, ChatEvent, ChatSnapshot } from '../../session/online-chat.js';
import { ChatLauncher } from './ChatLauncher';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const self = 'A'.repeat(43);
const other = 'B'.repeat(43);
const labels = new Map<PeerId, string>([
  [self, 'Alice'],
  [other, 'Bob'],
]);

function event(sender: PeerId, eventId: string, content: ChatContent): ChatEvent {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Display test needs only the signed body fields the launcher reads.
  return { packet: { body: { sender, eventId, content } }, receivedAt: 0 } as unknown as ChatEvent;
}

function chat(events: readonly ChatEvent[]): ChatSnapshot {
  return {
    scope: { kind: 'lobby', roomId: 'chatroomaa' },
    events,
    muted: [],
    error: null,
    ready: true,
  };
}

test('restored history is read; new messages from others count until the panel opens', () => {
  vi.useFakeTimers();
  const onOpen = vi.fn<() => void>();
  const restored = [event(other, 'e1', { kind: 'text', text: 'Old' })];
  const view = (events: readonly ChatEvent[], open: boolean) => (
    <ChatLauncher chat={chat(events)} labels={labels} self={self} open={open} onOpen={onOpen} />
  );
  const page = render(view(restored, false));
  expect(page.getByRole('button', { name: 'lobby:chatTitle' })).toBeTruthy();

  const own = [...restored, event(self, 'e2', { kind: 'text', text: 'Mine' })];
  page.rerender(view(own, false));
  expect(page.getByRole('button', { name: 'lobby:chatTitle' })).toBeTruthy();

  const incoming = [
    ...own,
    event(other, 'e3', { kind: 'text', text: 'Hi' }),
    event(other, 'e4', { kind: 'emote', emote: 'cheer' }),
  ];
  page.rerender(view(incoming, false));
  expect(page.getByRole('button', { name: 'lobby:chatOpenUnread:2' })).toBeTruthy();
  const preview = page.getByRole('button', { name: 'Bob 🎉' });
  fireEvent.click(preview);
  expect(onOpen).toHaveBeenCalledTimes(1);
  act(() => {
    vi.advanceTimersByTime(6_000);
  });
  expect(page.queryByRole('button', { name: 'Bob 🎉' })).toBeNull();
  expect(page.getByRole('button', { name: 'lobby:chatOpenUnread:2' })).toBeTruthy();

  page.rerender(view(incoming, true));
  expect(page.getByRole('button', { name: 'lobby:chatTitle' })).toBeTruthy();
  page.rerender(view(incoming, false));
  expect(page.getByRole('button', { name: 'lobby:chatTitle' })).toBeTruthy();
});

test('no chat renders nothing', () => {
  const page = render(
    <ChatLauncher chat={undefined} labels={labels} self={self} open={false} onOpen={() => {}} />,
  );
  expect(page.container.childElementCount).toBe(0);
});
