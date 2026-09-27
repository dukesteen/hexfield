import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OnlineRoomSnapshot } from '../../session/online-room';
import type { OnlineRoomHandleValue } from './room-registry';
import { InvitationCode, ScanInvitation } from './InvitationCode';
import { reconnectPlayers } from './use-reconnect-fallback';

export function ManualConnectionPanel({
  room,
  snapshot,
  reconnect = false,
  reconnectFallback = false,
}: {
  room: OnlineRoomHandleValue;
  snapshot: OnlineRoomSnapshot;
  reconnect?: boolean;
  reconnectFallback?: boolean;
}) {
  const { t } = useTranslation('lobby');
  const [input, setInput] = useState('');
  const [target, setTarget] = useState('');
  const manual = snapshot.manual;
  const canInvite = reconnect || snapshot.self === snapshot.invite.hostPeer;
  const members = reconnectPlayers(snapshot);
  const missing = members.filter(({ peer }) => !snapshot.peers.includes(peer));
  const selectedTarget = missing.some((member) => member.peer === target)
    ? target
    : missing.length === 1
      ? (missing[0]?.peer ?? '')
      : '';
  const action = useMutation({
    mutationFn: async (kind: 'invite' | 'answer' | 'accept') => {
      const result =
        kind === 'invite'
          ? await room.startManualInvitation?.(reconnect ? selectedTarget : undefined)
          : kind === 'answer'
            ? await room.answerManualOffer?.(input.trim())
            : await room.acceptManualAnswer?.(input.trim());
      if (!result?.ok) throw new Error('Manual connection could not be completed');
      setInput('');
    },
  });
  const cancelInvitation = () => {
    room.cancelManualInvitation?.();
    action.reset();
    setInput('');
  };
  if (!room.startManualInvitation || !manual || snapshot.closed) return null;
  const receivingAnswer =
    manual.phase === 'offering' || (manual.phase === 'error' && manual.code !== null);
  const connected = manual.peer !== null && snapshot.peers.includes(manual.peer);
  const hasCode = manual.code !== null && !connected;
  const automatic = reconnect && !reconnectFallback && !hasCode && !receivingAnswer;

  return (
    <section
      className="manual-connection"
      aria-label={t(reconnect ? 'lobby:manualReconnectTitle' : 'lobby:manualTitle')}
    >
      <h2>{t(reconnect ? 'lobby:manualReconnectTitle' : 'lobby:manualTitle')}</h2>
      {automatic ? (
        <p role="status" className="online-connection-progress">
          {missing.length > 0 && <span className="online-connection-spinner" aria-hidden="true" />}
          {missing.length > 0
            ? t('lobby:manualAutomaticReconnect', {
                players: missing.map(({ name }) => name).join(', '),
              })
            : t('lobby:manualAllConnected')}
        </p>
      ) : connected ? (
        <p role="status">{reconnect ? t('lobby:manualReconnected') : t('lobby:manualConnected')}</p>
      ) : (
        <p className="muted">
          {reconnect
            ? t('lobby:manualReconnectHint')
            : canInvite
              ? t('lobby:manualInviteHint')
              : t('lobby:manualAnswerHint')}
        </p>
      )}
      {action.isPending && !hasCode && !connected && (
        <div>
          <p role="status">{t('lobby:manualPreparing')}</p>
          {receivingAnswer && (
            <button className="button button-quiet" type="button" onClick={cancelInvitation}>
              {t('lobby:manualCancel')}
            </button>
          )}
        </div>
      )}
      {hasCode && (
        <>
          <p>{t(receivingAnswer ? 'lobby:manualSendOffer' : 'lobby:manualSendAnswer')}</p>
          <InvitationCode
            value={manual.code ?? ''}
            label={t(receivingAnswer ? 'lobby:manualOfferCode' : 'lobby:manualAnswerCode')}
          />
          {manual.gatheringComplete === false && (
            <p className="muted">{t('lobby:manualGatherIncomplete')}</p>
          )}
          {!receivingAnswer && <p role="status">{t('lobby:manualWaitingForAnswer')}</p>}
        </>
      )}
      {receivingAnswer && hasCode && (
        <form
          className="manual-connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            action.mutate('accept');
          }}
        >
          <label>
            {t('lobby:manualPasteAnswer')}
            <textarea
              className="manual-code-input"
              required
              rows={3}
              maxLength={2048}
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
          </label>
          <ScanInvitation onRead={setInput} />
          <div className="invitation-code-actions">
            <button
              className="button button-primary"
              type="submit"
              disabled={action.isPending || !input.trim()}
            >
              {t('lobby:manualConnect')}
            </button>
            <button className="button button-quiet" type="button" onClick={cancelInvitation}>
              {t('lobby:manualCancel')}
            </button>
          </div>
        </form>
      )}
      {canInvite && !automatic && (!hasCode || connected) && !receivingAnswer && (
        <div className="manual-connection-form">
          {reconnect && (
            <label>
              {t('lobby:manualChoosePlayer')}
              <select value={selectedTarget} onChange={(event) => setTarget(event.target.value)}>
                <option value="">{t('lobby:manualChoosePlayer')}</option>
                {missing.map((member) => (
                  <option key={member.peer} value={member.peer}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="button button-quiet"
            type="button"
            disabled={action.isPending || (reconnect && !selectedTarget)}
            onClick={() => action.mutate('invite')}
          >
            {t(
              action.isPending
                ? 'lobby:manualPreparing'
                : connected
                  ? 'lobby:manualNextInvite'
                  : 'lobby:manualCreateCode',
            )}
          </button>
        </div>
      )}
      {reconnect && !hasCode && !receivingAnswer && (
        <details>
          <summary>{t('lobby:manualHaveOffer')}</summary>
          <form
            className="manual-connection-form"
            onSubmit={(event) => {
              event.preventDefault();
              action.mutate('answer');
            }}
          >
            <label>
              {t('lobby:manualOfferCode')}
              <textarea
                className="manual-code-input"
                required
                rows={3}
                maxLength={2048}
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
            </label>
            <ScanInvitation onRead={setInput} />
            <button
              className="button button-primary"
              type="submit"
              disabled={action.isPending || !input.trim()}
            >
              {t('lobby:manualCreateAnswer')}
            </button>
          </form>
        </details>
      )}
      {(action.isError || manual.error) && <p role="alert">{t('lobby:manualFailed')}</p>}
    </section>
  );
}
