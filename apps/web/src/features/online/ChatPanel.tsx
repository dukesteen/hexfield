import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PeerId } from '@cp2p/protocol';
import type { ChatContent, ChatSnapshot } from '../../session/online-chat.js';
import type { OnlineRoomHandleValue } from './room-registry.js';
import { CHAT_EMOTES as emotes, chatText } from './chat-emotes.js';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function ChatPanel({
  room,
  chat,
  labels,
  self,
  onClose,
}: {
  room: Pick<OnlineRoomHandleValue, 'sendChat' | 'muteChat'>;
  chat: ChatSnapshot | undefined;
  labels: ReadonlyMap<PeerId, string>;
  self: PeerId;
  /** Renders a close control beside the heading when the panel is a dialog. */
  onClose?: () => void;
}) {
  const { t } = useTranslation('lobby');
  const emoteLabels = {
    wave: t('lobby:chatEmote.wave'),
    cheer: t('lobby:chatEmote.cheer'),
    laugh: t('lobby:chatEmote.laugh'),
    wow: t('lobby:chatEmote.wow'),
    thanks: t('lobby:chatEmote.thanks'),
  };
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [muting, setMuting] = useState<PeerId | null>(null);
  const mutingRef = useRef<PeerId | null>(null);
  const [error, setError] = useState(false);
  const history = useRef<HTMLOListElement>(null);
  const shown = chat?.ready ? chat.events.length : 0;
  useEffect(() => {
    // Keep the newest message in view as it arrives.
    const element = history.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [shown]);
  if (!chat) return null;
  const length = [...segmenter.segment(draft)].length;
  const send = async (content: ChatContent) => {
    if (!room.sendChat || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const sent = await room.sendChat(content);
      setError(!sent.ok);
      if (sent.ok && content.kind === 'text')
        setDraft((current) => (current === content.text ? '' : current));
    } catch {
      setError(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const mute = async (peer: PeerId, muted: boolean) => {
    if (!room.muteChat || mutingRef.current) return;
    mutingRef.current = peer;
    setMuting(peer);
    try {
      const saved = await room.muteChat(peer, muted);
      setError(!saved.ok);
    } catch {
      setError(true);
    } finally {
      mutingRef.current = null;
      setMuting(null);
    }
  };
  return (
    <section className="online-chat" aria-label={t('lobby:chatTitle')}>
      <div className="section-heading">
        <h2>{t('lobby:chatTitle')}</h2>
        {onClose && (
          <button className="button button-quiet" type="button" onClick={onClose}>
            {t('lobby:manualClose')}
          </button>
        )}
      </div>
      <ol ref={history} className="online-chat-history" aria-live="polite">
        {shown === 0 && <li className="online-chat-empty muted">{t('lobby:chatEmpty')}</li>}
        {(chat.ready ? chat.events : []).map(({ packet }) => {
          const { sender, eventId, content } = packet.body;
          return (
            <li key={`${sender}/${eventId}`}>
              <strong>
                {sender === self
                  ? t('lobby:onlineYou')
                  : (labels.get(sender) ?? sender.slice(0, 8))}
              </strong>{' '}
              <span className={content.kind === 'emote' ? 'online-chat-emote' : undefined}>
                {chatText(content)}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="online-chat-emotes" aria-label={t('lobby:chatEmotes')}>
        {emotes.map(({ name, symbol }) => (
          <button
            className="button button-quiet"
            key={name}
            type="button"
            disabled={!chat.ready || busy || !room.sendChat}
            aria-label={emoteLabels[name]}
            onClick={() => void send({ kind: 'emote', emote: name })}
          >
            {symbol}
          </button>
        ))}
      </div>
      <form
        className="online-chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send({ kind: 'text', text: draft });
        }}
      >
        <label htmlFor="online-chat-text">{t('lobby:chatMessage')}</label>
        <div className="online-chat-compose">
          <input
            id="online-chat-text"
            value={draft}
            maxLength={4096}
            enterKeyHint="send"
            autoComplete="off"
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('lobby:chatPlaceholder')}
          />
          <button
            className="button button-primary"
            type="submit"
            disabled={!chat.ready || busy || !draft.trim() || length > 300 || !room.sendChat}
          >
            {t('lobby:chatSend')}
          </button>
        </div>
        <small aria-live="polite">{t('lobby:chatLength', { count: length })}</small>
      </form>
      {room.muteChat && labels.size > 1 && (
        <div className="online-chat-mutes">
          {Array.from(labels, ([peer, label]) => ({ peer, label }))
            .filter(({ peer }) => peer !== self)
            .map(({ peer, label }) => (
              <button
                className="button button-quiet"
                key={peer}
                type="button"
                disabled={muting !== null}
                onClick={() => void mute(peer, !chat.muted.includes(peer))}
              >
                {chat.muted.includes(peer)
                  ? t('lobby:chatUnmute', { player: label })
                  : t('lobby:chatMutePlayer', { player: label })}
              </button>
            ))}
        </div>
      )}
      {length > 300 && <p role="alert">{t('lobby:chatTooLong')}</p>}
      {(error || chat.error) && <p role="alert">{t('lobby:chatFailed')}</p>}
    </section>
  );
}
