import type { Result } from '@cp2p/engine';
import { failure } from '@cp2p/engine';
import type { LobbySeat } from '@cp2p/protocol';
import { LOBBY_COLOURS } from '@cp2p/protocol';
import { Link, useBlocker, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { PlayerMarker } from '../../features/game/PlayerMarker.js';
import { createOnlineInviteUrl } from '../../session/online-invite.js';
import type { OnlineRoomSnapshot } from '../../session/online-room.js';
import { closeOnlineRoom, getOnlineRoom } from './room-registry.js';
import type { OnlineRoomHandleValue } from './room-registry.js';
import { InvitationCode } from './InvitationCode';
import { ManualConnectionPanel } from './ManualConnectionPanel';
import { ConnectionDiagnostics } from './ConnectionDiagnostics';
import { OnlineConfiguration } from './OnlineConfiguration';
import { LobbyNameEditor } from './LobbyNameEditor';
import './online.css';

const SEAT_SHAPES: readonly ('circle' | 'triangle' | 'square' | 'diamond')[] = [
  'circle',
  'triangle',
  'square',
  'diamond',
];

export type OnlineStartHandler = (room: OnlineRoomHandleValue) => void | Promise<void>;

export function OnlineLobby({
  lobbyId,
  onStart,
}: {
  lobbyId: string;
  onStart?: OnlineStartHandler;
}) {
  const { t } = useTranslation('lobby');
  const navigate = useNavigate();
  const room = getOnlineRoom(lobbyId);
  const snapshot = useSyncExternalStore(
    (listener) => room?.subscribe(listener) ?? (() => undefined),
    () => room?.getSnapshot() ?? null,
    () => null,
  );
  const [actionError, setActionError] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveTarget, setLeaveTarget] = useState<'/' | '/online/create' | '/join'>('/');
  const [leaveError, setLeaveError] = useState(false);
  const [startError, setStartError] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [namePending, setNamePending] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const allowNavigation = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      !!room && !snapshot?.closed && !allowNavigation.current && current.pathname !== next.pathname,
    withResolver: true,
    enableBeforeUnload: () => !!room && !snapshot?.closed,
  });
  useEffect(() => {
    const gameId = snapshot?.startup?.phase === 'playing' ? snapshot.startup.gameId : null;
    if (!gameId) return;
    allowNavigation.current = true;
    void navigate({ to: '/game/$gameId', params: { gameId }, replace: true });
  }, [snapshot?.startup?.phase, snapshot?.startup?.gameId, navigate]);

  const state = snapshot?.lobby;
  const isHost = !!snapshot && !!state && snapshot.self === state.hostPeer;
  const ownSeat = state?.seats.find(
    (seat) => seat.kind === 'human' && seat.peer === snapshot?.self,
  );
  const humanSeats = state?.seats.filter((seat) => seat.kind === 'human') ?? [];
  const peerLabels = new Map(
    (state?.seats ?? []).flatMap((seat) =>
      seat.kind === 'human' ? [[seat.peer, seat.name] as const] : [],
    ),
  );
  const connectedHumans = humanSeats.filter(
    (seat) =>
      seat.kind === 'human' &&
      (seat.peer === snapshot?.self || snapshot?.peers.includes(seat.peer)),
  ).length;
  const allHumansConnected =
    !!state &&
    state.seats
      .filter((seat) => seat.kind === 'human')
      .every(
        (seat) =>
          seat.kind === 'human' &&
          (seat.peer === snapshot?.self || snapshot?.peers.includes(seat.peer)),
      );
  const canStart =
    isHost &&
    state?.status === 'open' &&
    !!state &&
    state.seats.every((seat) => seat.kind !== 'open') &&
    state.seats.every((seat) => seat.kind !== 'human' || seat.ready) &&
    allHumansConnected &&
    !namePending &&
    !settingsPending;

  const report = (result: Result<void>) => {
    setActionError(!result.ok);
  };

  const leave = async () => {
    if (leaveBusy) return;
    setLeaveBusy(true);
    setLeaveError(false);
    try {
      await closeOnlineRoom(lobbyId);
      allowNavigation.current = true;
      setLeaving(false);
      if (blocker.status === 'blocked') blocker.proceed?.();
      else await navigate({ to: leaveTarget });
    } catch {
      setLeaveError(true);
    } finally {
      setLeaveBusy(false);
    }
  };

  const start = async () => {
    if (!room) return;
    setStartBusy(true);
    setStartError(false);
    try {
      if (onStart) await onStart(room);
      else {
        const result = room.startGame();
        if (!result.ok) throw new Error(result.error.message);
      }
    } catch {
      setStartError(true);
    } finally {
      setStartBusy(false);
    }
  };

  if (!room || !snapshot) {
    return (
      <main className="app-page message-page online-page">
        <h1>{t('lobby:onlineLobbyMissingTitle')}</h1>
        <p>{t('lobby:onlineLobbyMissingBody')}</p>
        <Link to="/join" className="button button-primary">
          {t('lobby:onlineJoinAction')}
        </Link>
      </main>
    );
  }

  return (
    <main className="app-page online-page online-lobby-page">
      <header className="app-header">
        <Link to="/" className="text-link">
          {t('lobby:backHome')}
        </Link>
        <span className="app-brand">{state?.name ?? t('lobby:onlineLobbyTitle')}</span>
        <button
          className="button button-quiet online-leave-button"
          type="button"
          onClick={() => {
            setLeaveTarget('/');
            setLeaving(true);
          }}
        >
          {t('lobby:onlineLeave')}
        </button>
      </header>
      <div className="online-lobby-content">
        <section className="online-lobby-heading">
          <div>
            <p className="online-kicker">{t('lobby:onlineLobbyKicker')}</p>
            <h1>{state?.name ?? t('lobby:onlineConnecting')}</h1>
            <p className="muted">
              {state
                ? t('lobby:onlinePeerCount', {
                    connected: connectedHumans,
                    total: humanSeats.length,
                  })
                : t('lobby:onlineWaitingForHost')}
            </p>
          </div>
          <div className="online-status" role="status">
            <span className={`online-status-dot online-status-${snapshot.signaling.state}`} />
            {snapshot.invite.serverUrl
              ? t(`onlineSignal_${snapshot.signaling.state}`)
              : t('lobby:manualConnectionCodes')}
          </div>
        </section>

        {snapshot.connectionError && (
          <p className="online-notice" role="alert">
            {t('lobby:onlineConnectionNotice')}
          </p>
        )}
        {snapshot.diagnostic && (
          <p className="online-notice" role="alert">
            {snapshot.diagnostic.kind === 'protocol-version'
              ? t('lobby:onlineProtocolMismatch', { version: snapshot.diagnostic.hostVersion })
              : snapshot.diagnostic.kind === 'engine-version'
                ? t('lobby:onlineEngineMismatch', { version: snapshot.diagnostic.hostVersion })
                : t('lobby:onlineInvalidLobbyMessage')}
          </p>
        )}
        {actionError && (
          <p className="online-notice" role="alert">
            {t('lobby:onlineActionFailed')}
          </p>
        )}
        {startError && (
          <p className="online-notice" role="alert">
            {t('lobby:onlineStartFailed')}
          </p>
        )}
        {snapshot.startup && (
          <section className="online-start-progress" role="status" aria-live="polite">
            <StartupProgress phase={snapshot.startup.phase} />
            {snapshot.startup.awaitingSeats.length > 0 && (
              <p className="muted">
                {t('lobby:onlineStartWaiting', {
                  players: snapshot.startup.awaitingSeats
                    .map((seat) =>
                      state?.seats[seat]?.kind !== 'open'
                        ? state?.seats[seat]?.name
                        : String(seat + 1),
                    )
                    .join(', '),
                })}
              </p>
            )}
            {snapshot.startup.phase === 'error' && (
              <button
                className="button button-quiet"
                type="button"
                onClick={() => void room.retryStart().then(report)}
              >
                {t('lobby:onlineRetryStart')}
              </button>
            )}
            {snapshot.startup.phase === 'retired' && (
              <button
                className="button button-primary"
                type="button"
                onClick={() => {
                  setLeaveTarget(isHost ? '/online/create' : '/join');
                  setLeaving(true);
                }}
              >
                {t(isHost ? 'lobby:onlineNewRoom' : 'lobby:onlineJoinNewRoom')}
              </button>
            )}
          </section>
        )}

        {snapshot.invite.serverUrl ? (
          <section className="online-section" aria-labelledby="online-invite-title">
            <div>
              <h2 id="online-invite-title">{t('lobby:onlineInviteTitle')}</h2>
              <p className="muted">{t('lobby:onlineInviteDescription')}</p>
            </div>
            <InvitationCode
              value={createOnlineInviteUrl(window.location.href, snapshot.invite)}
              label={t('lobby:onlineInvitationUrl')}
            />
            {isHost && state?.status === 'open' && (
              <details className="manual-fallback">
                <summary>{t('lobby:manualUseCodes')}</summary>
                <ManualConnectionPanel room={room} snapshot={snapshot} />
              </details>
            )}
          </section>
        ) : (
          <section className="online-section">
            <ManualConnectionPanel room={room} snapshot={snapshot} />
          </section>
        )}
        <ConnectionDiagnostics
          serverUrl={snapshot.invite.serverUrl}
          peerStatsKey={snapshot.invite.roomId}
          {...(room?.getPeerStats ? { loadPeerStats: room.getPeerStats } : {})}
          peerLabels={peerLabels}
        />

        {state && (
          <>
            <section className="online-section" aria-labelledby="online-seats-title">
              <div className="section-heading">
                <h2 id="online-seats-title">{t('lobby:players')}</h2>
                <span className="muted">
                  {t('lobby:onlineSeatCount', { count: state.seats.length })}
                </span>
              </div>
              <div className="online-seat-list">
                {state.seats.map((seat) => (
                  <LobbySeatRow
                    key={seat.seat}
                    room={room}
                    snapshot={snapshot}
                    seat={seat}
                    isHost={isHost}
                    ownSeat={ownSeat?.seat === seat.seat}
                    editable={state.status === 'open' && !snapshot.startup && !startBusy}
                    namePending={namePending}
                    settingsPending={settingsPending}
                    onNamePendingChange={setNamePending}
                    report={report}
                  />
                ))}
              </div>
            </section>

            <OnlineConfiguration
              config={state.config}
              seedMode={state.seedMode}
              editable={isHost && state.status === 'open' && !snapshot.startup && !startBusy}
              onSave={(config, seed) =>
                room.lobby?.configure(config, seed) ?? failure('lobby-closed', 'The room is closed')
              }
              onPendingChange={setSettingsPending}
            />

            <section className="online-start-panel">
              <div>
                <h2>{t('lobby:onlineStartTitle')}</h2>
                <p className="muted">{t('lobby:onlineStartPreparation')}</p>
                {state.takeover.afterSeconds === 'never' && (
                  <p className="muted">{t('lobby:onlineDisconnectPolicy')}</p>
                )}
              </div>
              <button
                className="button button-primary"
                type="button"
                disabled={!canStart || startBusy}
                onClick={() => void start()}
              >
                {t('lobby:onlineStartAction')}
              </button>
            </section>
          </>
        )}
      </div>

      <LeaveDialog
        open={leaving || blocker.status === 'blocked'}
        busy={leaveBusy}
        error={leaveError}
        onCancel={() => {
          setLeaving(false);
          blocker.reset?.();
        }}
        onConfirm={() => void leave()}
      />
    </main>
  );
}

function StartupProgress({
  phase,
}: {
  phase: NonNullable<OnlineRoomSnapshot['startup']>['phase'];
}) {
  const { t } = useTranslation('lobby');
  const labels = {
    freezing: t('lobby:onlineStartFreezing'),
    frozen: t('lobby:onlineStartPreparing'),
    bindings: t('lobby:onlineStartPreparing'),
    approvals: t('lobby:onlineStartPreparing'),
    escrow: t('lobby:onlineStartPreparing'),
    'beacon-tips': t('lobby:onlineStartPreparing'),
    'seed-commits': t('lobby:onlineStartBoard'),
    'seed-reveals': t('lobby:onlineStartBoard'),
    deck: t('lobby:onlineStartDeck'),
    consent: t('lobby:onlineStartAgreement'),
    waiting: t('lobby:onlineStartWaitingAgreement'),
    ready: t('lobby:onlineStartOpening'),
    opening: t('lobby:onlineStartOpening'),
    playing: t('lobby:onlineStartOpening'),
    retired: t('lobby:onlineStartRetired'),
    halted: t('lobby:onlineGameHalted'),
    error: t('lobby:onlineStartFailed'),
  };
  return <strong>{labels[phase]}</strong>;
}

function LobbySeatRow({
  room,
  snapshot,
  seat,
  isHost,
  ownSeat,
  editable,
  namePending,
  settingsPending,
  onNamePendingChange,
  report,
}: {
  room: OnlineRoomHandleValue;
  snapshot: OnlineRoomSnapshot;
  seat: LobbySeat;
  isHost: boolean;
  ownSeat: boolean;
  editable: boolean;
  namePending: boolean;
  settingsPending: boolean;
  onNamePendingChange: (pending: boolean) => void;
  report: (result: Result<void>) => void;
}) {
  const { t } = useTranslation('lobby');
  const member = seat.kind === 'human' ? seat : null;
  const name = seat.kind === 'open' ? t('lobby:onlineOpenSeat') : seat.name;
  const shape = SEAT_SHAPES[seat.seat] ?? 'circle';
  const lobby = room.lobby;
  if (!lobby) return null;

  const request = (action: Parameters<typeof lobby.request>[0]) => report(lobby.request(action));

  return (
    <article className={`online-seat-row online-seat-${seat.kind}`}>
      <span className={`online-marker color-${seat.colour}`}>
        <PlayerMarker shape={shape} color="blue" />
      </span>
      <div className="online-seat-main">
        <div className="online-seat-title">
          <strong>{name}</strong>
          <span className="online-seat-number">
            {t('lobby:onlineSeatNumber', { number: seat.seat + 1 })}
          </span>
          {seat.kind === 'human' && (
            <span className={seat.ready ? 'online-ready online-is-ready' : 'online-ready'}>
              {seat.ready ? t('lobby:onlineReady') : t('lobby:onlineNotReady')}
            </span>
          )}
        </div>
        {seat.kind === 'bot' && (
          <small className="muted">
            {seat.botHost === snapshot.self
              ? t('lobby:onlineBotHostedHere')
              : t('lobby:onlineBotHostedByPlayer')}
          </small>
        )}
        {ownSeat && member && (
          <div className="online-seat-edit">
            <LobbyNameEditor
              name={member.name}
              editable={editable}
              onSave={(newName) => lobby.request({ kind: 'setName', name: newName })}
              onPendingChange={onNamePendingChange}
            />
            <label>
              {t('lobby:playerColor', { number: seat.seat + 1 })}
              <select
                value={seat.colour}
                onChange={(event) => {
                  const colour = LOBBY_COLOURS.find((item) => item === event.target.value);
                  if (colour) request({ kind: 'setColour', colour });
                }}
              >
                {LOBBY_COLOURS.map((colour) => (
                  <option key={colour} value={colour}>
                    {t(`lobby:${colour}`)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button button-quiet"
              type="button"
              disabled={namePending || (isHost && settingsPending)}
              onClick={() => request({ kind: 'setReady', ready: !seat.ready })}
            >
              {seat.ready ? t('lobby:onlineMarkNotReady') : t('lobby:onlineMarkReady')}
            </button>
            <button
              className="button button-quiet"
              type="button"
              onClick={() => request({ kind: 'leaveSeat' })}
            >
              {t('lobby:onlineLeaveSeat')}
            </button>
          </div>
        )}
      </div>
      <div className="online-seat-actions">
        {seat.kind === 'open' && !ownSeat && (
          <button
            className="button button-quiet"
            type="button"
            onClick={() => request({ kind: 'takeSeat', seat: seat.seat })}
          >
            {t('lobby:onlineTakeSeat')}
          </button>
        )}
        {isHost && (seat.kind === 'open' || seat.kind === 'bot') && (
          <>
            {seat.kind === 'open' && (
              <label className="online-bot-select">
                <span className="sr-only">
                  {t('lobby:onlineAddRandomBot', { number: seat.seat + 1 })}
                </span>
                <select
                  defaultValue=""
                  onChange={(event) => {
                    if (event.target.value === 'easy')
                      report(lobby.setBot(seat.seat, 'easy', snapshot.self));
                    event.currentTarget.value = '';
                  }}
                >
                  <option value="" disabled>
                    {t('lobby:onlineAddRandomBot', { number: seat.seat + 1 })}
                  </option>
                  <option value="easy">{t('lobby:onlineRandomBot')}</option>
                </select>
              </label>
            )}
            {seat.kind === 'bot' && (
              <>
                <label>
                  {t('lobby:onlineBotHost')}
                  <select
                    value={seat.botHost}
                    disabled={snapshot.lobby?.status !== 'open'}
                    onChange={(event) =>
                      report(lobby.setBot(seat.seat, seat.botLevel, event.target.value))
                    }
                  >
                    {snapshot.lobby?.seats.flatMap((player) =>
                      player.kind === 'human'
                        ? [
                            <option key={player.peer} value={player.peer}>
                              {player.name}
                            </option>,
                          ]
                        : [],
                    )}
                  </select>
                </label>
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => report(lobby.openSeat(seat.seat))}
                >
                  {t('lobby:onlineOpenSeatAction')}
                </button>
              </>
            )}
          </>
        )}
        {isHost && member && member.peer !== snapshot.self && (
          <button
            className="button button-quiet"
            type="button"
            onClick={() => report(lobby.kick(member.peer))}
          >
            {t('lobby:onlineKickPlayer')}
          </button>
        )}
      </div>
    </article>
  );
}

function LeaveDialog({
  open,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  error: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('lobby');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) element?.showModal();
    if (!open && element?.open) element.close();
    return () => element?.close();
  }, [open]);
  return (
    <dialog ref={dialog} className="app-dialog" onCancel={onCancel}>
      <h2>{t('lobby:onlineLeaveConfirmTitle')}</h2>
      <p>{t('lobby:onlineLeaveConfirmBody')}</p>
      {error && <p role="alert">{t('lobby:onlineLeaveFailed')}</p>}
      <div className="dialog-actions">
        <button className="button button-quiet" type="button" onClick={onCancel} disabled={busy}>
          {t('lobby:onlineStay')}
        </button>
        <button className="button button-primary" type="button" onClick={onConfirm} disabled={busy}>
          {t('lobby:onlineLeave')}
        </button>
      </div>
    </dialog>
  );
}
