import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useDestinationTransfer } from '../../queries/online-transfers.js';
import type { DestinationTransferHandle } from '../../queries/online-transfers.js';
import { decodeTransferInvite } from '../../session/online-transfer-link.js';
import { TransferPanel } from './TransferPanel.js';
import './online.css';
import './transfer-panel.css';

/** The invited device opens no keys, storage writer or peer link before Start. */
export function TransferDestinationScreen({ code }: { code: string }) {
  const { t } = useTranslation('lobby');
  const navigate = useNavigate();
  const destinationTransfer = useDestinationTransfer();
  const invite = useMemo(() => {
    try {
      return decodeTransferInvite(code);
    } catch {
      return null;
    }
  }, [code]);
  const [handle, setHandle] = useState<DestinationTransferHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<DestinationTransferHandle | null>(null);
  const generation = useRef(0);
  const opening = useRef(false);
  const leaving = useRef(false);
  const snapshot = useSyncExternalStore(
    (listener) => handle?.browser.subscribe(listener) ?? (() => undefined),
    () => handle?.browser.getSnapshot() ?? null,
    () => null,
  );

  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
      const owned = handleRef.current;
      handleRef.current = null;
      if (owned) void owned.close().catch(() => undefined);
    };
  }, []);

  const start = async () => {
    if (!invite || opening.current || handleRef.current) return;
    opening.current = true;
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      const opened = await destinationTransfer.mutateAsync(invite);
      if (generation.current !== current) {
        await opened.close();
        return;
      }
      handleRef.current = opened;
      setHandle(opened);
    } catch (reason) {
      if (generation.current === current)
        setError(reason instanceof Error ? reason.message : t('lobby:transferOpenFailed'));
    } finally {
      opening.current = false;
      if (generation.current === current) setBusy(false);
    }
  };

  const leave = async (gameId?: string) => {
    if (leaving.current) return;
    leaving.current = true;
    setBusy(true);
    setError(null);
    const owned = handleRef.current;
    generation.current += 1;
    try {
      await owned?.close();
      handleRef.current = null;
      setHandle(null);
      if (gameId) await navigate({ to: '/game/$gameId', params: { gameId } });
      else await navigate({ to: '/' });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('lobby:transferOpenFailed'));
      setBusy(false);
      leaving.current = false;
    }
  };

  if (!invite)
    return (
      <main className="app-page online-page online-transfer-invalid">
        <header className="app-header">
          <Link className="text-link" to="/">
            {t('lobby:backHome')}
          </Link>
          <span className="app-brand">{t('lobby:transferDestinationTitle')}</span>
        </header>
        <div className="online-transfer-destination">
          <section className="online-transfer-panel">
            <h1>{t('lobby:transferInvalidInvite')}</h1>
          </section>
        </div>
      </main>
    );

  return (
    <main className="app-page online-page">
      <header className="app-header">
        <Link
          className="text-link"
          to="/"
          onClick={(event) => {
            if (handleRef.current || opening.current) {
              event.preventDefault();
              void leave();
            }
          }}
        >
          {t('lobby:backHome')}
        </Link>
        <span className="app-brand">{t('lobby:transferDestinationTitle')}</span>
      </header>
      <div className="online-transfer-destination">
        {!snapshot ? (
          <section className="online-transfer-panel">
            <h1>{t('lobby:transferDestinationTitle')}</h1>
            <p>{t('lobby:transferStartHint')}</p>
            <p className="online-transfer-self">
              <strong>{t('lobby:transferSourceDevice')}</strong>
              <code>
                {invite.body.sourceDevice
                  .slice(0, 16)
                  .match(/.{1,4}/g)
                  ?.join(' ')}
              </code>
            </p>
            {error && <p role="alert">{error}</p>}
            <div className="online-transfer-actions">
              <button
                className="button button-primary"
                type="button"
                disabled={busy}
                onClick={() => void start()}
              >
                {t('lobby:transferStart')}
              </button>
            </div>
          </section>
        ) : (
          <>
            <TransferPanel
              role="destination"
              selfDevice={snapshot.selfDevice}
              candidates={[]}
              selectedDevice={snapshot.selectedDevice}
              phase={snapshot.phase}
              busy={busy || snapshot.busy}
              error={error ?? snapshot.error}
              onSelectDevice={() => undefined}
              onConfirm={() => undefined}
              onCancel={() => undefined}
              onRetry={() => {
                if (handle) void handle.browser.retry().catch(() => undefined);
              }}
              onDismiss={() => void leave()}
            />
            {snapshot.promotedGameId && (
              <button
                className="button button-primary"
                type="button"
                disabled={busy}
                onClick={() => void leave(snapshot.promotedGameId ?? undefined)}
              >
                {t('lobby:transferOpenGame')}
              </button>
            )}
          </>
        )}
      </div>
    </main>
  );
}
