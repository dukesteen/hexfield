import { useEffect, useRef, useState } from 'react';
import type { PeerId } from '@cp2p/protocol';
import type { ChatEvent, ChatSnapshot } from '../../session/online-chat.js';

const eventKey = ({ packet }: ChatEvent): string => `${packet.body.sender}/${packet.body.eventId}`;

export interface ChatUnread {
  /** Messages from other players that arrived since the panel was last open. */
  readonly count: number;
  /** The newest unread message, for a short on-board preview. */
  readonly latest: ChatEvent | null;
}

/**
 * Counts chat events from other peers that arrived while the panel was closed.
 * History restored with the game counts as read; this is display state only.
 */
export function useChatUnread(
  chat: ChatSnapshot | undefined,
  self: PeerId,
  open: boolean,
): ChatUnread {
  const seen = useRef<Set<string> | null>(null);
  const [, setRevision] = useState(0);
  const events = chat?.ready ? chat.events : null;
  useEffect(() => {
    if (!events) return;
    if (seen.current === null || open) {
      const next = new Set(events.map(eventKey));
      const changed =
        seen.current === null ||
        next.size !== seen.current.size ||
        [...next].some((key) => !seen.current?.has(key));
      seen.current = next;
      if (changed) setRevision((value) => value + 1);
    }
  }, [events, open]);
  if (!events || seen.current === null || open) return { count: 0, latest: null };
  const known = seen.current;
  const unread = events.filter(
    (event) => event.packet.body.sender !== self && !known.has(eventKey(event)),
  );
  return { count: unread.length, latest: unread.at(-1) ?? null };
}
