import { createFileRoute, Link, notFound, useBlocker, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardRenderer } from '@cp2p/renderer';
import type { ActionAvailability } from '../../features/actions/availability';
import { GameReadOnly } from '../../features/game/GameReadOnly';
import { resetOrdinaryActionRejections } from '../../features/game/action-diagnostics';
import { SaveCoordinator, type SaveStatus } from '../../features/game/save-coordinator';
import { acquireLocalSession, releaseLocalSession } from '../../features/game/session-registry';
import { getWebRepositories, loadSavedGame, useSaveGame, useSettings } from '../../queries/hooks';
import type { SavedGameRecord } from '../../queries/repositories/saved-games';
import {
  attachSession,
  pauseForExternalConflict,
  restoreSessionPause,
  useSessionStore,
} from '../../store/session-store';
import type { LocalSession } from '../../session';
import {
  useCreateRematch,
  useExportGame,
  useExportReplay,
  useImportLocalSave,
} from '../../queries/transfers';

const DevDrawer = import.meta.env.DEV
  ? lazy(() => import('../../features/devtools').then((module) => ({ default: module.DevDrawer })))
  : null;

export const Route = createFileRoute('/local/$gameId')({
  loader: async ({ context, params }) => {
    const record = await loadSavedGame(context.queryClient, params.gameId);
    if (!record) throw notFound();
    return record;
  },
  component: LocalGamePage,
  notFoundComponent: MissingGame,
});

function MissingGame() {
  const { t } = useTranslation('lobby');
  return (
    <main className="app-page message-page">
      <h1>{t('lobby:loadFailed')}</h1>
      <Link to="/" className="button button-primary">
        {t('lobby:backHome')}
      </Link>
    </main>
  );
}

function validPresentation(record: SavedGameRecord, seats: readonly number[]): boolean {
  const players = record.presentation.players;
  return (
    players.length === seats.length &&
    new Set(players.map((player) => player.seat)).size === seats.length &&
    seats.every((seat) => players.some((player) => player.seat === seat))
  );
}

function LeaveDialog({
  blocked,
  onCancel,
  onConfirm,
  error,
}: {
  blocked: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  error: boolean;
}) {
  const { t } = useTranslation('game');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (blocked && !dialog.current?.open) dialog.current?.showModal();
    if (!blocked && dialog.current?.open) dialog.current.close();
  }, [blocked]);
  return (
    <dialog ref={dialog} className="app-dialog" onCancel={onCancel}>
      <h2>{t('game:leaveConfirmTitle')}</h2>
      <p>{t('game:leaveConfirmBody')}</p>
      {error && <p role="alert">{t('game:saveError')}</p>}
      <div className="dialog-actions">
        <button className="button button-quiet" type="button" onClick={onCancel}>
          {t('game:stay')}
        </button>
        <button className="button button-primary" type="button" onClick={onConfirm}>
          {t('game:leave')}
        </button>
      </div>
    </dialog>
  );
}

function ConflictDialog() {
  const { t } = useTranslation(['game', 'lobby']);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="app-dialog conflict-dialog"
      onCancel={(event) => event.preventDefault()}
    >
      <h2>{t('game:saveConflictStopped')}</h2>
      <p>{t('lobby:saveConflict')}</p>
      <button
        className="button button-primary"
        type="button"
        onClick={() => window.location.reload()}
      >
        {t('game:reloadGame')}
      </button>
    </dialog>
  );
}

function LocalGamePage() {
  const record = Route.useLoaderData();
  const { gameId } = Route.useParams();
  return <LocalGameInstance key={gameId} record={record} gameId={gameId} />;
}

function LocalGameInstance({ record, gameId }: { record: SavedGameRecord; gameId: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation(['game', 'lobby']);
  const settings = useSettings();
  const saveMutation = useSaveGame();
  const importMutation = useImportLocalSave((seat) =>
    t('lobby:defaultPlayerName', { number: seat + 1 }),
  );
  const exportGame = useExportGame();
  const exportReplay = useExportReplay();
  const rematchMutation = useCreateRematch();
  const saveAsyncRef = useRef(saveMutation.mutateAsync);
  saveAsyncRef.current = saveMutation.mutateAsync;
  const waitingSeat = useSessionStore((store) => store.waitingSeat);
  const revealedSeat = useSessionStore((store) => store.revealedSeat);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [leaveError, setLeaveError] = useState(false);
  const coordinatorRef = useRef<SaveCoordinator | null>(null);
  const allowNavigationRef = useRef(false);
  const sessionRef = useRef<LocalSession | null>(null);
  const [renderer, setRenderer] = useState<BoardRenderer | null>(null);
  const [actions, setActions] = useState<ActionAvailability | null>(null);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      ready && !allowNavigationRef.current && current.pathname !== next.pathname,
    withResolver: true,
    enableBeforeUnload: () => ready,
  });

  useEffect(() => {
    let live = true;
    let session;
    try {
      session = acquireLocalSession(
        gameId,
        record.save,
        {
          botDelayMs: record.presentation.botDelayMs,
        },
        record.revision,
      );
      if (!validPresentation(record, session.getState().config.seats)) {
        releaseLocalSession(gameId);
        throw new Error('Saved player metadata differs from the game seats');
      }
    } catch {
      setFailed(true);
      return () => undefined;
    }
    sessionRef.current = session;
    resetOrdinaryActionRejections();
    const detach = attachSession(gameId, session);
    const coordinator = new SaveCoordinator(
      gameId,
      session,
      record.presentation,
      getWebRepositories().savedGames,
      (input) => saveAsyncRef.current(input),
      record.revision,
      (status) => {
        if (live) setSaveStatus(status);
      },
    );
    coordinatorRef.current = coordinator;
    const onPagehide = () => {
      try {
        coordinator.flushSync();
      } catch {
        if (live) setSaveStatus('error');
      }
    };
    const stopExternal = getWebRepositories().savedGames.subscribeExternal((id) => {
      if (id !== gameId) return;
      setConflict(true);
      pauseForExternalConflict();
    });
    window.addEventListener('pagehide', onPagehide);
    setReady(true);
    return () => {
      live = false;
      detach();
      session.setPaused(true);
      onPagehide();
      window.removeEventListener('pagehide', onPagehide);
      stopExternal();
      coordinator.dispose();
      coordinatorRef.current = null;
      sessionRef.current = null;
      releaseLocalSession(gameId);
    };
  }, [gameId, record]);

  useEffect(() => {
    if (!import.meta.env.DEV || !ready || !sessionRef.current) return () => undefined;
    const session = sessionRef.current;
    let active = true;
    let remove: () => void = () => undefined;
    void import('../../features/devtools').then(({ installDevHook }) => {
      if (active) remove = installDevHook({ session, renderer, actions });
      return undefined;
    });
    return () => {
      active = false;
      remove();
    };
  }, [gameId, ready, renderer, actions]);

  useEffect(() => {
    if (settings.data?.hotseatCover === false && waitingSeat !== null && revealedSeat === null) {
      useSessionStore.getState().autoReveal(waitingSeat);
    }
  }, [settings.data?.hotseatCover, waitingSeat, revealedSeat]);

  useEffect(() => {
    if (conflict) pauseForExternalConflict();
  }, [conflict]);

  const leave = async () => {
    sessionRef.current?.setPaused(true);
    try {
      await coordinatorRef.current?.flush();
      blocker.proceed?.();
    } catch {
      setLeaveError(true);
      restoreSessionPause();
    }
  };

  const exportCurrentReplay = async () => {
    const session = sessionRef.current;
    if (!session) throw new Error('No live session');
    await exportReplay.mutateAsync({
      name: gameId,
      save: session.exportSave(),
      presentation: record.presentation,
    });
  };

  const rematch = async () => {
    const session = sessionRef.current;
    if (!session) throw new Error('No live session');
    await coordinatorRef.current?.flush();
    const created = await rematchMutation.mutateAsync({
      save: session.exportSave(),
      presentation: record.presentation,
    });
    allowNavigationRef.current = true;
    try {
      await navigate({ to: '/local/$gameId', params: { gameId: created.id } });
    } catch (error) {
      allowNavigationRef.current = false;
      throw error;
    }
  };

  const importSave = async (raw: unknown) => {
    const imported = await importMutation.mutateAsync(raw);
    await coordinatorRef.current?.flush();
    allowNavigationRef.current = true;
    try {
      await navigate({ to: '/local/$gameId', params: { gameId: imported.id } });
    } catch (error) {
      allowNavigationRef.current = false;
      throw error;
    }
  };

  if (failed) {
    return (
      <main className="app-page message-page">
        <h1>{t('game:sessionError')}</h1>
        <Link to="/" className="button button-primary">
          {t('lobby:backHome')}
        </Link>
      </main>
    );
  }

  return (
    <main className="app-page local-game-page">
      <div className="game-utility-bar">
        <span className="app-brand">{t('game:gameTitle')}</span>
        <span className={`save-indicator status-${saveStatus}`} role="status">
          {saveStatus === 'saved'
            ? t('game:saveStatus')
            : saveStatus === 'saving'
              ? t('game:saving')
              : t('game:saveError')}
        </span>
        <Link to="/" className="text-link">
          {t('game:leaveGame')}
        </Link>
      </div>
      {ready ? (
        <GameReadOnly
          presentation={record.presentation}
          onRematch={rematch}
          onExportReplay={exportCurrentReplay}
          onRendererReady={setRenderer}
          onActionsChange={setActions}
        />
      ) : (
        <p role="status">{t('game:loadingGame')}</p>
      )}
      {conflict && <ConflictDialog />}
      <LeaveDialog
        blocked={blocker.status === 'blocked'}
        onCancel={() => blocker.reset?.()}
        onConfirm={() => void leave()}
        error={leaveError}
      />
      {DevDrawer && ready && sessionRef.current && (
        <Suspense fallback={null}>
          <DevDrawer
            session={sessionRef.current}
            renderer={renderer}
            actions={actions}
            onImportSave={async (raw) => {
              await importSave(raw);
            }}
            onExportSave={async (save) => {
              await exportGame.mutateAsync({ name: gameId, save });
            }}
            onExportReplay={async (save) => {
              await exportReplay.mutateAsync({
                name: gameId,
                save,
                presentation: record.presentation,
              });
            }}
          />
        </Suspense>
      )}
    </main>
  );
}
