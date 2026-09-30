import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PeerId } from '@cp2p/protocol';
import type { ChatSnapshot } from '../../session/online-chat.js';
import { chatText } from './chat-emotes.js';
import { useChatUnread } from './chat-unread.js';

const PREVIEW_MS = 6_000;

/** On-board chat button with an unread count and a short preview of the newest message. */
export function ChatLauncher({
  chat,
  labels,
  self,
  open,
  onOpen,
}: {
  chat: ChatSnapshot | undefined;
  labels: ReadonlyMap<PeerId, string>;
  self: PeerId;
  open: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation('lobby');
  const unread = useChatUnread(chat, self, open);
  const latest = unread.latest;
  const latestKey = latest ? `${latest.packet.body.sender}/${latest.packet.body.eventId}` : null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!latestKey) return undefined;
    const timer = setTimeout(() => setDismissed(latestKey), PREVIEW_MS);
    return () => clearTimeout(timer);
  }, [latestKey]);
  if (!chat) return null;
  const label =
    unread.count > 0 ? t('lobby:chatOpenUnread', { count: unread.count }) : t('lobby:chatTitle');
  const sender = latest?.packet.body.sender;
  return (
    <div className="online-chat-launcher">
      <button
        className="online-chat-launcher-button"
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        onClick={onOpen}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z" />
        </svg>
        {unread.count > 0 && (
          <span className="online-chat-badge" aria-hidden="true">
            {unread.count > 9 ? '9+' : unread.count}
          </span>
        )}
      </button>
      {latest && sender && latestKey !== dismissed && (
        <button className="online-chat-preview" type="button" onClick={onOpen}>
          <strong>{labels.get(sender) ?? sender.slice(0, 8)}</strong>
          <span>{chatText(latest.packet.body.content)}</span>
        </button>
      )}
    </div>
  );
}
