import type { ChatContent } from '../../session/online-chat.js';

export const CHAT_EMOTES = [
  { name: 'wave', symbol: '👋' },
  { name: 'cheer', symbol: '🎉' },
  { name: 'laugh', symbol: '😄' },
  { name: 'wow', symbol: '😮' },
  { name: 'thanks', symbol: '❤️' },
] as const;

/** The text shown for a signed chat body: its message or its emote's symbol. */
export function chatText(content: ChatContent): string {
  return content.kind === 'text'
    ? content.text
    : (CHAT_EMOTES.find((item) => item.name === content.emote)?.symbol ?? '');
}
