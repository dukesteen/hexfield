import type { Seat } from '@cp2p/engine';
import { failure } from '@cp2p/engine';
import type { GameSession, LobbyFreezeAgreement } from '@cp2p/protocol';
import { getGameArtUrl } from '@cp2p/renderer';
import { useBlocker, useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { ChatPanel } from './ChatPanel';
import { TransferPanel } from './TransferPanel';
import { RecoveryPanel } from './RecoveryPanel';
import { useReconnectFallback } from './use-reconnect-fallback';
import { useSourceTransfer } from '../../queries/online-transfers';
import type { OnlineTransferBrowser } from '../../session/online-transfer-browser';
import { createTransferInviteUrl } from '../../session/online-transfer-link';
import { useRequestPersistentStorage } from '../../queries/storage-persistence';
import { queryKeys } from '../../queries/keys';
import { encodePublicReplay } from '../../session/online-public-archive-client.js';
import { FullSaveExportDialog } from './FullSaveExportDialog.js';
import { RecoveryVoidDialog } from './RecoveryVoidDialog.js';
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
  const reconnectFallback = useReconnectFallback(snapshot);
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
      <main
        className="app-page online-page online-resume-page"
        style={{ backgroundImage: `url(${getGameArtUrl('background')})` }}
      >
        <section className="online-resume-panel" aria-labelledby="online-resume-title">
          <h1 id="online-resume-title">{t('lobby:onlineResumeTitle')}</h1>
          {halted ? (
            <p role="alert">{t('lobby:onlineGameHalted')}</p>
          ) : failed ? (
            <p role="alert">
              {unsupportedVersion
                ? t('lobby:onlineResumeUnsupportedVersion', { version: openError.savedVersion })
                : t('lobby:onlineResumeFailed')}
            </p>
          ) : (
            <p className="online-connection-progress" role="status">
              <span className="online-connection-spinner" aria-hidden="true" />
              {t('lobby:onlineResumeProgress')}
            </p>
          )}
          {room && snapshot && !halted && (
            <ManualConnectionPanel
              room={room}
              snapshot={snapshot}
              reconnect
              reconnectFallback={reconnectFallback}
            />
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
        </section>
      </main>
    );
  return (
    <OnlineGameInstance
      room={room}
      game={game}
      agreement={agreement}
      reconnectFallback={reconnectFallback}
    />
  );
}

function OnlineGameInstance({
  room,
  game,
  agreement,
  reconnectFallback,
}: {
  room: OnlineRoomHandleValue;
  game: OnlineGame<GameSession>;
  agreement: LobbyFreezeAgreement;
  reconnectFallback: boolean;
}) {
  const { t } = useTranslation(['game', 'lobby']);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const snapshot = useSyncExternalStore(room.subscribe, room.getSnapshot, room.getSnapshot);
  const audit = useSessionStore((store) => store.audit);
  const status = useSessionStore((store) => store.status);
  const recoveryCandidate = useSessionStore((store) => store.recoveryCandidate);
  const { mutate: requestPersistentStorage } = useRequestPersistentStorage();
  const [attached, setAttached] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [fullSaveOpen, setFullSaveOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const voided = status?.kind === 'void';
  useEffect(() => {
    if (voided) setVoidOpen(true);
  }, [voided]);
  const [transferBrowser, setTransferBrowser] = useState<OnlineTransferBrowser | null>(null);
  const sourceTransfer = useSourceTransfer(room);
  const transfer = useSyncExternalStore(
    (listener) => transferBrowser?.subscribe(listener) ?? (() => undefined),
    () => transferBrowser?.getSnapshot() ?? null,
    () => null,
  );
  const connectionDialog = useRef<HTMLDialogElement>(null);
  const chatDialog = useRef<HTMLDialogElement>(null);
  const transferDialog = useRef<HTMLDialogElement>(null);
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
  useEffect(() => {
    const element = chatDialog.current;
    if (chatOpen && !element?.open) element?.showModal();
    if (!chatOpen && element?.open) element.close();
    return () => {
      if (element?.open) element.close();
    };
  }, [chatOpen]);
  useEffect(() => {
    const element = transferDialog.current;
    if (transferOpen && !element?.open) element?.showModal();
    if (!transferOpen && element?.open) element.close();
    return () => {
      if (element?.open) element.close();
    };
  }, [transferOpen]);
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
    if (status?.kind === 'complete' || status?.kind === 'void')
      void queryClient.invalidateQueries({ queryKey: queryKeys.onlineGames(), exact: true });
  }, [queryClient, status?.kind, audit]);
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
  const frozenDeviceBySeat = new Map(
    agreement.state.seats.flatMap((seat) =>
      seat.kind === 'human' ? [[seat.seat, seat.peer] as const] : [],
    ),
  );
  const currentDeviceBySeat = new Map(
    snapshot.deviceRoutes?.seats.map(({ seat, devicePeer }) => [seat, devicePeer] as const) ??
      frozenDeviceBySeat,
  );
  const currentDeviceForSeat = (seat: Seat): string | null =>
    snapshot.deviceRoutes
      ? (currentDeviceBySeat.get(seat) ?? null)
      : (frozenDeviceBySeat.get(seat) ?? null);
  const peerLabels = new Map(
    agreement.state.seats.flatMap((seat) => {
      if (seat.kind === 'open') return [];
      const devicePeer = currentDeviceForSeat(seat.seat);
      return devicePeer ? [[devicePeer, seat.name] as const] : [];
    }),
  );
  const connections: Partial<Record<Seat, string>> = {};
  const missing = agreement.state.seats.filter((seat) => {
    const devicePeer = currentDeviceForSeat(seat.seat);
    return (
      devicePeer !== null && devicePeer !== snapshot.self && !snapshot.peers.includes(devicePeer)
    );
  });
  const missingHumans = missing.flatMap((seat) =>
    seat.kind === 'human' ? [{ seat: seat.seat, name: seat.name }] : [],
  );
  const currentHumans = snapshot.deviceRoutes
    ? snapshot.deviceRoutes.seats
        .filter((seat) => seat.devicePeer !== null)
        .map((seat) => seat.seat)
    : agreement.state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.seat] : []));
  const canInitiateTakeover =
    currentHumans.length === 4 &&
    missingHumans.length === 1 &&
    game.seat === Math.min(...currentHumans.filter((seat) => seat !== missingHumans[0]?.seat));
  for (const seat of agreement.state.seats) {
    const devicePeer = currentDeviceForSeat(seat.seat);
    if (devicePeer !== null)
      connections[seat.seat] =
        devicePeer === snapshot.self
          ? t('lobby:onlineYou')
          : snapshot.peers.includes(devicePeer)
            ? t('lobby:onlineConnected')
            : t('lobby:onlineReconnecting');
    else connections[seat.seat] = t('lobby:onlineRandomBot');
  }
  const exported = useMutation({
    mutationFn: async () => {
      const history = await Promise.resolve(game.session.exportSave());
      const bytes = await encodePublicReplay(game.gameId, history);
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = `${game.gameId}.hxar`;
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
      await queryClient.invalidateQueries({ queryKey: queryKeys.onlineGames(), exact: true });
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
  const openTransfer = async () => {
    setTransferOpen(true);
    try {
      setTransferBrowser(await sourceTransfer.mutateAsync());
    } catch {
      // The mutation error is shown in the open dialog.
    }
  };
  const withTransfer = (action: (browser: OnlineTransferBrowser) => Promise<void>) => {
    if (transferBrowser) void action(transferBrowser).catch(() => undefined);
  };
  const transferInvite = transfer
    ? createTransferInviteUrl(window.location.href, transfer.invite)
    : null;
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
          onClick={() => {
            void Promise.resolve(game.session.retryAudit?.()).catch(() => undefined);
          }}
        >
          {t('lobby:onlineRetryAudit')}
        </button>
      )}
    </div>
  );
  return (
    <main className="app-page online-game-page">
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
            <>
              <button
                className="button button-quiet"
                type="button"
                onClick={() => setChatOpen(true)}
              >
                {t('lobby:chatTitle')}
              </button>
              <button
                className="button button-quiet"
                type="button"
                onClick={() => setConnectionOpen(true)}
              >
                {t('lobby:connectionDiagnosticsTitle')}
              </button>
              <button
                className="button button-quiet"
                type="button"
                onClick={() => setFullSaveOpen(true)}
              >
                {t('lobby:fullSaveExport')}
              </button>
              {room.startTransfer && !halted && !voided && (
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => void openTransfer()}
                >
                  {t('lobby:transferSourceTitle')}
                </button>
              )}
            </>
          }
          sessionNotice={
            voided ? (
              <div className="online-game-notice" role="status">
                <strong>{t('lobby:onlineGameVoidTitle')}</strong>
                <p>{t('lobby:onlineGameVoidBody')}</p>
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => setVoidOpen(true)}
                >
                  {t('game:results')}
                </button>
              </div>
            ) : missing.length > 0 || recoveryCandidate ? (
              <>
                {missing.length > 0 && (
                  <div className="online-game-notice">
                    <div className="online-game-notice-heading">
                      <span className="online-connection-spinner" aria-hidden="true" />
                      <strong>{t('lobby:onlineReconnecting')}</strong>
                    </div>
                    <p>
                      {t('lobby:onlineGameWaitingPeers', {
                        players: missing
                          .map((seat) => (seat.kind === 'human' ? seat.name : ''))
                          .join(', '),
                      })}
                    </p>
                    <button
                      className="button button-quiet"
                      type="button"
                      onClick={() => setConnectionOpen(true)}
                    >
                      {t('lobby:manualReconnectTitle')}
                    </button>
                  </div>
                )}
                <RecoveryPanel
                  policy={game.genesis.takeover}
                  candidate={recoveryCandidate}
                  missing={missingHumans}
                  takeoverAvailable={currentHumans.length === 4}
                  canInitiate={canInitiateTakeover}
                  onEligibility={(seat) =>
                    game.session.canRequestTakeover?.(seat) ??
                    Promise.resolve(failure('session-unavailable', 'Takeover is unavailable'))
                  }
                  onApprove={(change) =>
                    game.session.approveRecoveryAuthorization?.(change) ??
                    Promise.resolve(
                      failure('session-unavailable', 'Takeover voting is unavailable'),
                    )
                  }
                  onDecline={() => game.session.clearRecoveryApproval?.()}
                  onRequest={(seat, level) =>
                    game.session.requestTakeover?.(seat, level) ??
                    Promise.resolve(failure('session-unavailable', 'Takeover is unavailable'))
                  }
                />
              </>
            ) : undefined
          }
        />
      ) : (
        <div className="online-game-loading online-connection-progress" role="status">
          <span className="online-connection-spinner" aria-hidden="true" />
          {t('game:loadingGame')}
        </div>
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
            <ManualConnectionPanel
              room={room}
              snapshot={snapshot}
              reconnect
              reconnectFallback={reconnectFallback}
            />
          </>
        )}
      </dialog>
      <dialog
        ref={chatDialog}
        className="app-dialog online-chat-dialog"
        aria-label={t('lobby:chatTitle')}
        onCancel={() => setChatOpen(false)}
      >
        <button className="button button-quiet" type="button" onClick={() => setChatOpen(false)}>
          {t('lobby:manualClose')}
        </button>
        <ChatPanel room={room} chat={snapshot.chat} labels={peerLabels} self={snapshot.self} />
      </dialog>
      <dialog
        ref={transferDialog}
        className="app-dialog online-transfer-dialog"
        aria-label={t('lobby:transferSourceTitle')}
        onCancel={() => setTransferOpen(false)}
      >
        {transfer && transferInvite ? (
          <TransferPanel
            role="source"
            invitationUrl={transferInvite}
            selfDevice={transfer.selfDevice}
            candidates={transfer.candidates}
            selectedDevice={transfer.selectedDevice}
            phase={transfer.phase}
            busy={transfer.busy}
            error={transfer.error}
            onSelectDevice={(peer) => withTransfer((browser) => browser.selectDevice(peer))}
            onConfirm={() => withTransfer((browser) => browser.confirm())}
            onCancel={() => withTransfer((browser) => browser.cancel())}
            onRetry={() => withTransfer((browser) => browser.retry())}
            onDismiss={() => setTransferOpen(false)}
          />
        ) : (
          <div className="online-transfer-panel">
            <h2>{t('lobby:transferSourceTitle')}</h2>
            {sourceTransfer.error ? (
              <p role="alert">{sourceTransfer.error.message}</p>
            ) : (
              <p role="status">{t('lobby:transferPhase_connecting')}</p>
            )}
            <button
              className="button button-quiet"
              type="button"
              onClick={() => setTransferOpen(false)}
            >
              {t('lobby:manualClose')}
            </button>
          </div>
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
        {exported.isError && <p role="alert">{t('lobby:publicReplayExportFailed')}</p>}
        <div className="dialog-actions">
          <button
            className="button button-quiet"
            type="button"
            disabled={exported.isPending}
            onClick={() => exported.mutate()}
          >
            {exported.isPending ? t('lobby:publicReplayVerifying') : t('game:exportReplay')}
          </button>
          <button
            className="button button-quiet"
            type="button"
            onClick={() => setFullSaveOpen(true)}
          >
            {t('lobby:fullSaveExport')}
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
      {fullSaveOpen && (
        <FullSaveExportDialog gameId={game.gameId} onClose={() => setFullSaveOpen(false)} />
      )}
      {attached && voided && voidOpen && (
        <RecoveryVoidDialog
          onViewBoard={() => setVoidOpen(false)}
          onLeave={() => void leave()}
          busy={busy}
          leaveError={leaveError}
        />
      )}
    </main>
  );
}
