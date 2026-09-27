import type { Seat } from '@cp2p/engine';
import type { LobbyFreezeAgreement } from '@cp2p/protocol';
import { useBlocker, useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { GameReadOnly } from '../game/GameReadOnly.js';
import type { GamePresentation } from '../../queries/repositories/saved-games.js';
import { attachSession, useSessionStore } from '../../store/session-store.js';
import { beginOnlineRoomOpen, closeOnlineRoom, getOnlineGameRoom } from './room-registry.js';
import type { OnlineRoomHandleValue } from './room-registry.js';
import type { OnlineGame } from '../../session/online-game.js';
import { UnsupportedOnlineGameVersionError } from '../../session/online-game-records.js';
import { ManualConnectionPanel } from './ManualConnectionPanel';
import { ConnectionDiagnostics } from './ConnectionDiagnostics';
import { useRequestPersistentStorage } from '../../queries/storage-persistence';
import './online.css';

const SHAPES = ['circle', 'triangle', 'square', 'diamond'] as const;

export function OnlineGameScreen({ gameId }: { gameId: string }) {
  const { t } = useTranslation('lobby');
  const navigate = useNavigate();
  const [room, setRoom] = useState(() => getOnlineGameRoom(gameId));
  const [openError, setOpenError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const lifetime = useRef(0);
  const snapshot = useSyncExternalStore(
    (listener) => room?.subscribe(listener) ?? (() => undefined),
    () => room?.getSnapshot() ?? null,
    () => null,
  );
  useEffect(() => {
    const generation = ++lifetime.current;
    let live = true;
    setOpenError(null);
    const handle = beginOnlineRoomOpen(`resume:${gameId}`, { kind: 'resume', gameId });
    void handle.promise.then(
      (opened) => {
        if (!live) return undefined;
        setRoom(opened);
        return undefined;
      },
      (error: unknown) => {
        if (live) setOpenError(error instanceof Error ? error : new Error('Could not open game'));
      },
    );
    return () => {
      live = false;
      handle.cancel();
      // A kept lobby may hand its room to this route. The route owns it until
      // unmount, while the deferred check preserves React's StrictMode remount.
      queueMicrotask(() => {
        // oxlint-disable-next-line react-hooks/exhaustive-deps -- This generation counter deliberately detects a newer effect, rather than capturing a DOM ref.
        if (lifetime.current !== generation) return;
        const opened = getOnlineGameRoom(gameId);
        if (opened) void closeOnlineRoom(opened.invite.roomId).catch(() => undefined);
      });
    };
  }, [gameId, attempt]);
  const game = room?.getGame();
  const agreement = snapshot?.agreement;
  const halted = snapshot?.startup?.phase === 'halted';
  const failed = openError !== null || snapshot?.startup?.phase === 'error';
  const unsupportedVersion = openError instanceof UnsupportedOnlineGameVersionError;
  const exitLoading = async (retry: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (room) await closeOnlineRoom(room.invite.roomId);
      setRoom(null);
      if (retry) setAttempt((value) => value + 1);
      else await navigate({ to: '/' });
    } catch (error) {
      setOpenError(error instanceof Error ? error : new Error('Could not close game'));
    } finally {
      setBusy(false);
    }
  };
  if (!room || !game || !agreement)
    return (
      <main className="app-page message-page">
        <h1>{t('lobby:onlineResumeTitle')}</h1>
        {halted ? (
          <p role="alert">{t('lobby:onlineGameHalted')}</p>
        ) : failed ? (
          <p role="alert">
            {unsupportedVersion
              ? t('lobby:onlineResumeUnsupportedVersion', { version: openError.savedVersion })
              : t('lobby:onlineResumeFailed')}
          </p>
        ) : (
          <p role="status">{t('lobby:onlineResumeProgress')}</p>
        )}
        {room && snapshot && !halted && (
          <ManualConnectionPanel room={room} snapshot={snapshot} reconnect />
        )}
        <div className="dialog-actions">
          {failed && !halted && !unsupportedVersion && (
            <button
              className="button button-primary"
              type="button"
              disabled={busy}
              onClick={() => void exitLoading(true)}
            >
              {t('lobby:onlineResumeRetry')}
            </button>
          )}
          <button
            className="button button-quiet"
            type="button"
            disabled={busy}
            onClick={() => void exitLoading(false)}
          >
            {t('lobby:backHome')}
          </button>
        </div>
      </main>
    );
  return <OnlineGameInstance room={room} game={game} agreement={agreement} />;
}

function OnlineGameInstance({
  room,
  game,
  agreement,
}: {
  room: OnlineRoomHandleValue;
  game: OnlineGame;
  agreement: LobbyFreezeAgreement;
}) {
  const { t } = useTranslation(['game', 'lobby']);
  const navigate = useNavigate();
  const snapshot = useSyncExternalStore(room.subscribe, room.getSnapshot, room.getSnapshot);
  const audit = useSessionStore((store) => store.audit);
  const status = useSessionStore((store) => store.status);
  const { mutate: requestPersistentStorage } = useRequestPersistentStorage();
  const [attached, setAttached] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const connectionDialog = useRef<HTMLDialogElement>(null);
  const allowNavigation = useRef(false);
  const leaveDialog = useRef<HTMLDialogElement>(null);
  const haltedDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = connectionDialog.current;
    if (connectionOpen && !element?.open) element?.showModal();
    if (!connectionOpen && element?.open) element.close();
    return () => {
      if (element?.open) element.close();
    };
  }, [connectionOpen]);
  const halted = snapshot.startup?.phase === 'halted';
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      !allowNavigation.current && !snapshot.closed && current.pathname !== next.pathname,
    withResolver: true,
    enableBeforeUnload: () => !snapshot.closed,
  });
  useEffect(() => {
    const detach = attachSession(game.gameId, game.session);
    setAttached(true);
    return detach;
  }, [game]);
  useEffect(() => {
    requestPersistentStorage();
  }, [requestPersistentStorage]);
  useEffect(() => {
    const element = haltedDialog.current;
    if (halted && !element?.open) element?.showModal();
    return () => {
      if (element?.open) element.close();
    };
  }, [halted]);
  useEffect(() => {
    const element = leaveDialog.current;
    if ((leaving || blocker.status === 'blocked') && !element?.open) element?.showModal();
    if (!leaving && blocker.status !== 'blocked' && element?.open) element.close();
    return () => {
      if (element?.open) element.close();
    };
  }, [leaving, blocker.status]);

  const presentation = useMemo<GamePresentation>(
    () => ({
      players: agreement.state.seats.map((seat) => {
        if (
          seat.kind === 'open' ||
          (seat.seat !== 0 && seat.seat !== 1 && seat.seat !== 2 && seat.seat !== 3)
        )
          throw new Error('Online presentation has an unfilled or unsupported seat');
        const index = seat.seat;
        return { seat: index, name: seat.name, color: seat.colour, shape: SHAPES[index] };
      }),
      botDelayMs: 800,
    }),
    [agreement],
  );
  const peerLabels = new Map(
    agreement.state.seats.flatMap((seat) =>
      seat.kind === 'human' ? [[seat.peer, seat.name] as const] : [],
    ),
  );
  const connections: Partial<Record<Seat, string>> = {};
  const missing = agreement.state.seats.filter(
    (seat) =>
      seat.kind === 'human' && seat.peer !== snapshot.self && !snapshot.peers.includes(seat.peer),
  );
  for (const seat of agreement.state.seats) {
    if (seat.kind === 'human')
      connections[seat.seat] =
        seat.peer === snapshot.self
          ? t('lobby:onlineYou')
          : snapshot.peers.includes(seat.peer)
            ? t('lobby:onlineConnected')
            : t('lobby:onlineReconnecting');
    else if (seat.kind === 'bot') connections[seat.seat] = t('lobby:onlineRandomBot');
  }
  const exported = useMutation({
    mutationFn: async () => {
      const blob = new Blob(
        [
          JSON.stringify(
            {
              format: 'hexfield-certified-history-v1',
              history: game.session.exportSave(),
              presentation,
              audit: game.session.getAudit(),
            },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      );
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = `${game.gameId}.peer-history.json`;
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    },
  });
  const leave = async () => {
    if (busy) return;
    setBusy(true);
    setLeaveError(false);
    try {
      await closeOnlineRoom(room.invite.roomId);
      allowNavigation.current = true;
      setLeaving(false);
      if (blocker.status === 'blocked') blocker.proceed?.();
      else await navigate({ to: '/' });
    } catch {
      setLeaveError(true);
    } finally {
      setBusy(false);
    }
  };
  const auditText =
    audit?.kind === 'complete'
      ? audit.report.ok
        ? t('lobby:onlineAuditPassed')
        : t('lobby:onlineAuditFailed')
      : audit?.kind === 'awaiting-reveals'
        ? t('lobby:onlineAuditWaiting')
        : audit?.kind === 'verifying'
          ? t('lobby:onlineAuditVerifying')
          : audit?.kind === 'error' || audit?.kind === 'unavailable'
            ? t('lobby:onlineAuditUnavailable')
            : t('lobby:onlineAuditPending');
  const resultNotice = (
    <div role="status" className="online-audit-status">
      <strong>{auditText}</strong>
      {audit?.kind === 'error' && (
        <button
          className="button button-quiet"
          type="button"
          onClick={() => game.session.retryAudit()}
        >
          {t('lobby:onlineRetryAudit')}
        </button>
      )}
    </div>
  );
  return (
    <>
      {attached ? (
        <GameReadOnly
          presentation={presentation}
          gameTitle={t('lobby:onlineGameTitle')}
          connectionLabels={connections}
          saveStatus={status?.kind === 'error' ? 'error' : 'saved'}
          onLeave={() => setLeaving(true)}
          onExportReplay={() => exported.mutateAsync()}
          resultNotice={resultNotice}
          menuActions={
            <button
              className="button button-quiet"
              type="button"
              onClick={() => setConnectionOpen(true)}
            >
              {t('lobby:connectionDiagnosticsTitle')}
            </button>
          }
          sessionNotice={
            missing.length > 0 ? (
              <p className="online-game-notice" role="status">
                {t('lobby:onlineGameWaitingPeers', {
                  players: missing
                    .map((seat) => (seat.kind === 'human' ? seat.name : ''))
                    .join(', '),
                })}
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => setConnectionOpen(true)}
                >
                  {t('lobby:manualReconnectTitle')}
                </button>
              </p>
            ) : null
          }
        />
      ) : (
        <p role="status">{t('game:loadingGame')}</p>
      )}
      <dialog
        ref={connectionDialog}
        className="app-dialog connection-dialog"
        aria-labelledby="online-connection-title"
        onCancel={() => setConnectionOpen(false)}
      >
        <div className="section-heading">
          <h2 id="online-connection-title">{t('lobby:connectionDiagnosticsTitle')}</h2>
          <button
            className="button button-quiet"
            type="button"
            onClick={() => setConnectionOpen(false)}
          >
            {t('lobby:manualClose')}
          </button>
        </div>
        {connectionOpen && (
          <>
            <ConnectionDiagnostics
              serverUrl={snapshot.invite.serverUrl}
              peerStatsKey={game.gameId}
              {...(room.getPeerStats ? { loadPeerStats: room.getPeerStats } : {})}
              peerLabels={peerLabels}
            />
            <ManualConnectionPanel room={room} snapshot={snapshot} reconnect />
          </>
        )}
      </dialog>
      <dialog
        ref={haltedDialog}
        className="app-dialog"
        aria-labelledby="online-game-halted-title"
        onCancel={(event) => event.preventDefault()}
      >
        <h2 id="online-game-halted-title">{t('lobby:onlineGameHalted')}</h2>
        <p>{t('lobby:onlineGameHaltedBody')}</p>
        {leaveError && <p role="alert">{t('lobby:onlineLeaveFailed')}</p>}
        <div className="dialog-actions">
          <button
            className="button button-quiet"
            type="button"
            disabled={exported.isPending}
            onClick={() => exported.mutate()}
          >
            {t('game:exportReplay')}
          </button>
          <button
            className="button button-primary"
            type="button"
            disabled={busy}
            onClick={() => void leave()}
          >
            {t('game:leave')}
          </button>
        </div>
      </dialog>
      <dialog
        ref={leaveDialog}
        className="app-dialog"
        onCancel={() => {
          setLeaving(false);
          blocker.reset?.();
        }}
      >
        <h2>{t('game:leaveConfirmTitle')}</h2>
        <p>{t('lobby:onlineGameLeaveBody')}</p>
        {leaveError && <p role="alert">{t('lobby:onlineLeaveFailed')}</p>}
        <div className="dialog-actions">
          <button
            className="button button-quiet"
            type="button"
            disabled={busy}
            onClick={() => {
              setLeaving(false);
              blocker.reset?.();
            }}
          >
            {t('game:stay')}
          </button>
          <button
            className="button button-primary"
            type="button"
            disabled={busy}
            onClick={() => void leave()}
          >
            {t('game:leave')}
          </button>
        </div>
      </dialog>
    </>
  );
}
