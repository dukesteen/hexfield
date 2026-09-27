import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  usePeerConnectionStats,
  useSignalingHealth,
  useTestConnectivity,
} from '../../queries/connection-diagnostics';
import type { ConnectionPeerStats } from '../../queries/connection-diagnostics';
import type { WebRtcPeerStats } from '@cp2p/p2p';
import './connection-diagnostics.css';

export interface ConnectionDiagnosticsProps {
  readonly serverUrl: string;
  readonly peerStats?: readonly ConnectionPeerStats[];
  readonly peerStatsKey?: string;
  readonly loadPeerStats?: () => Promise<readonly WebRtcPeerStats[]>;
  readonly peerLabels?: ReadonlyMap<string, string>;
}

export function ConnectionDiagnostics({
  serverUrl,
  peerStats = [],
  peerStatsKey,
  loadPeerStats,
  peerLabels,
}: ConnectionDiagnosticsProps) {
  const { t } = useTranslation('lobby');
  const [expanded, setExpanded] = useState(false);
  const signaling = useSignalingHealth(serverUrl, expanded);
  const liveStats = usePeerConnectionStats(peerStatsKey ?? serverUrl, loadPeerStats, expanded);
  const connectivity = useTestConnectivity();
  const report = connectivity.data;
  const displayedPeerStats = liveStats.data?.map((peer) => ({
    label: peerLabels?.get(peer.peer) ?? t('lobby:onlineConnected'),
    status:
      peer.state === 'connected'
        ? ('connected' as const)
        : peer.state === 'new' || peer.state === 'connecting'
          ? ('connecting' as const)
          : ('disconnected' as const),
    route: peer.route,
    rttMs: peer.rttMs,
  }));
  const peersToDisplay = displayedPeerStats ?? peerStats;

  return (
    <section className="connection-diagnostics" aria-label={t('lobby:connectionDiagnosticsTitle')}>
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>{t('lobby:connectionDiagnosticsTitle')}</summary>
        <div className="connection-diagnostics-body">
          <div className="connection-diagnostics-row">
            <span>{t('lobby:connectionDiagnosticsSignaling')}</span>
            <span>
              {serverUrl === ''
                ? t('lobby:connectionDiagnosticsNoServer')
                : signaling.isPending
                  ? t('lobby:connectionDiagnosticsChecking')
                  : signaling.isError
                    ? t('lobby:connectionDiagnosticsUnreachable')
                    : t('lobby:connectionDiagnosticsReachable', {
                        ms: Math.round(signaling.data?.elapsedMs ?? 0),
                      })}
            </span>
          </div>
          {signaling.isError && <p role="status">{t('lobby:connectionDiagnosticsHealthHint')}</p>}
          <button
            type="button"
            className="button button-quiet"
            disabled={connectivity.isPending}
            onClick={() => connectivity.mutate()}
          >
            {connectivity.isPending
              ? t('lobby:connectionDiagnosticsTesting')
              : t('lobby:connectionDiagnosticsTest')}
          </button>
          {connectivity.isError && <p role="alert">{t('lobby:connectionDiagnosticsTestFailed')}</p>}
          {report && (
            <div className="connection-diagnostics-report" aria-live="polite">
              {report.gatheringTimedOut && <p>{t('lobby:connectionDiagnosticsGatherTimeout')}</p>}
              <dl>
                <div>
                  <dt>{t('lobby:connectionDiagnosticsHost')}</dt>
                  <dd>{report.hostCandidates}</dd>
                </div>
                <div>
                  <dt>{t('lobby:connectionDiagnosticsStun')}</dt>
                  <dd>{t(`lobby:connectionDiagnostics_${report.stun}`)}</dd>
                </div>
                <div>
                  <dt>{t('lobby:connectionDiagnosticsTurn')}</dt>
                  <dd>{t(`lobby:connectionDiagnostics_${report.turn}`)}</dd>
                </div>
                <div>
                  <dt>{t('lobby:connectionDiagnosticsRelay')}</dt>
                  <dd>{report.relayCandidates}</dd>
                </div>
                <div>
                  <dt>{t('lobby:connectionDiagnosticsElapsed')}</dt>
                  <dd>{t('lobby:connectionDiagnosticsMilliseconds', { ms: report.elapsedMs })}</dd>
                </div>
              </dl>
              {(report.stun === 'not-observed' || report.turn === 'not-observed') && (
                <p>{t('lobby:connectionDiagnosticsTryTurnOrNetwork')}</p>
              )}
            </div>
          )}
          {peersToDisplay.length > 0 && (
            <ul className="connection-diagnostics-peers">
              {peersToDisplay.map((peer) => (
                <li key={peer.label}>
                  <span>{peer.label}</span>
                  <span>{t(`lobby:connectionDiagnosticsPeer_${peer.status}`)}</span>
                  {peer.route && peer.route !== 'unknown' && (
                    <span>{t(`lobby:connectionDiagnosticsRoute_${peer.route}`)}</span>
                  )}
                  {peer.rttMs !== null && peer.rttMs !== undefined && (
                    <span>
                      {t('lobby:connectionDiagnosticsRtt', { ms: Math.round(peer.rttMs) })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </section>
  );
}
