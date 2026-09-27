import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { beginOnlineRoomOpen, closeOnlineRoom } from './room-registry.js';
import { parseOnlineInviteUrl, validateOnlineInvite } from '../../session/online-invite.js';
import { ScanInvitation } from './InvitationCode';
import './online.css';

export function OnlineJoinForm() {
  const { t } = useTranslation('lobby');
  const navigate = useNavigate();
  const [inviteUrl, setInviteUrl] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const openHandle = useRef<ReturnType<typeof beginOnlineRoomOpen> | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      openHandle.current?.cancel();
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setInvalid(false);
    try {
      if (inviteUrl.trim().startsWith('HX1.')) {
        const handle = beginOnlineRoomOpen(`manual:${crypto.randomUUID()}`, {
          kind: 'manual-join',
          offerCode: inviteUrl.trim(),
        });
        openHandle.current = handle;
        const room = await handle.promise;
        if (!active.current) return;
        handle.keep();
        try {
          await navigate({ to: '/lobby/$lobbyId', params: { lobbyId: room.invite.roomId } });
        } catch (error) {
          await closeOnlineRoom(room.invite.roomId);
          throw error;
        }
        return;
      }
      const invite = parseOnlineInviteUrl(inviteUrl);
      await navigate({
        to: '/join/$roomId',
        params: { roomId: invite.roomId },
        search: { host: invite.hostPeer, server: invite.serverUrl },
      });
    } catch {
      openHandle.current?.cancel();
      if (active.current) setInvalid(true);
    } finally {
      if (active.current) setBusy(false);
    }
  };

  return (
    <main className="app-page form-page online-page">
      <header className="app-header">
        <Link to="/" className="text-link">
          {t('lobby:backHome')}
        </Link>
        <span className="app-brand">{t('lobby:onlineJoinTitle')}</span>
      </header>
      <div className="form-page-content setup-content online-join-content">
        <h1>{t('lobby:onlineJoinTitle')}</h1>
        <p className="muted">{t('lobby:manualJoinDescription')}</p>
        <form onSubmit={(event) => void submit(event)} className="setup-form online-form">
          <fieldset>
            <legend>{t('lobby:onlineInvitation')}</legend>
            <label>
              {t('lobby:manualLinkOrCode')}
              <textarea
                autoComplete="url"
                required
                rows={3}
                maxLength={4096}
                value={inviteUrl}
                onChange={(event) => setInviteUrl(event.target.value)}
              />
            </label>
            <ScanInvitation onRead={setInviteUrl} />
          </fieldset>
          {invalid && <p role="alert">{t('lobby:onlineInviteInvalid')}</p>}
          <button className="button button-primary" type="submit" disabled={busy}>
            {t(busy ? 'lobby:manualPreparing' : 'lobby:onlineJoinAction')}
          </button>
        </form>
        <p className="online-secondary-link">
          {t('lobby:onlineNeedRoom')} <Link to="/online/create">{t('lobby:onlineCreateLink')}</Link>
        </p>
      </div>
    </main>
  );
}

export function OnlineAutoJoin({
  roomId,
  host,
  server,
}: {
  roomId: string;
  host: string;
  server: string;
}) {
  const { t } = useTranslation('lobby');
  const navigate = useNavigate();
  const [error, setError] = useState(false);
  const [opening, setOpening] = useState(true);
  const handleRef = useRef<ReturnType<typeof beginOnlineRoomOpen> | null>(null);

  useEffect(() => {
    let live = true;
    setOpening(true);
    setError(false);
    let openedRoomId: string | null = null;
    try {
      const invite = validateOnlineInvite({
        roomId,
        hostPeer: host,
        serverUrl: server,
      });
      const handle = beginOnlineRoomOpen(
        `join:${invite.serverUrl}:${invite.roomId}:${invite.hostPeer}`,
        { kind: 'join', invite },
      );
      handleRef.current = handle;
      void handle.promise
        .then(async (room) => {
          if (!live) return undefined;
          openedRoomId = room.invite.roomId;
          handle.keep();
          await navigate({ to: '/lobby/$lobbyId', params: { lobbyId: room.invite.roomId } });
          return undefined;
        })
        .catch(() => {
          if (live) {
            setError(true);
            setOpening(false);
            if (openedRoomId) void closeOnlineRoom(openedRoomId);
          }
          handle.cancel();
        });
    } catch {
      setError(true);
      setOpening(false);
    }
    return () => {
      live = false;
      handleRef.current?.cancel();
      handleRef.current = null;
    };
  }, [host, navigate, roomId, server]);

  return (
    <main className="app-page message-page online-page">
      <h1>{t('lobby:onlineJoinTitle')}</h1>
      {opening && <p role="status">{t('lobby:onlineConnecting')}</p>}
      {error && <p role="alert">{t('lobby:onlineOpenFailed')}</p>}
      {error && (
        <Link to="/join" className="button button-primary">
          {t('lobby:onlineTryAnotherInvite')}
        </Link>
      )}
    </main>
  );
}
