import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { InvitationCode } from './InvitationCode.js';
import './transfer-panel.css';

export type TransferPanelPhase =
  | 'connecting'
  | 'awaiting-confirmation'
  | 'awaiting-authorization'
  | 'awaiting-private'
  | 'awaiting-readiness'
  | 'awaiting-certification'
  | 'awaiting-receipt'
  | 'cancelled-awaiting-receipt'
  | 'activated'
  | 'cancelled';

export interface TransferPanelProps {
  readonly role: 'source' | 'destination';
  readonly invitationUrl?: string;
  readonly selfDevice: string;
  readonly candidates: readonly string[];
  readonly selectedDevice: string | null;
  readonly phase: TransferPanelPhase;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSelectDevice: (peer: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}

const phaseKeys: Record<TransferPanelPhase, string> = {
  connecting: 'lobby:transferPhase_connecting',
  'awaiting-confirmation': 'lobby:transferPhase_awaiting-confirmation',
  'awaiting-authorization': 'lobby:transferPhase_awaiting-authorization',
  'awaiting-private': 'lobby:transferPhase_awaiting-private',
  'awaiting-readiness': 'lobby:transferPhase_awaiting-readiness',
  'awaiting-certification': 'lobby:transferPhase_awaiting-certification',
  'awaiting-receipt': 'lobby:transferPhase_awaiting-receipt',
  'cancelled-awaiting-receipt': 'lobby:transferPhase_cancelled-awaiting-receipt',
  activated: 'lobby:transferPhase_activated',
  cancelled: 'lobby:transferPhase_cancelled',
};

function fingerprint(peer: string): string {
  const prefix = peer.slice(0, 16);
  return prefix.match(/.{1,4}/g)?.join(' ') ?? prefix;
}

export function TransferPanel({
  role,
  invitationUrl,
  selfDevice,
  candidates,
  selectedDevice,
  phase,
  busy,
  error,
  onSelectDevice,
  onConfirm,
  onCancel,
  onRetry,
  onDismiss,
}: TransferPanelProps) {
  const { t } = useTranslation('lobby');
  const titleId = useId();
  const completed = phase === 'activated';
  const terminal = completed || phase === 'cancelled' || phase === 'cancelled-awaiting-receipt';
  const title = t(
    role === 'source' ? 'lobby:transferSourceTitle' : 'lobby:transferDestinationTitle',
  );
  const displayCandidates = selectedDevice === null ? candidates : [selectedDevice];
  const phaseKey =
    role === 'destination' && terminal
      ? phase === 'activated'
        ? 'lobby:transferDestinationActivated'
        : 'lobby:transferDestinationCancelled'
      : phaseKeys[phase];

  return (
    <section className="online-transfer-panel" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <p className="online-transfer-explanation">
        {t(role === 'source' ? 'lobby:transferSourceHint' : 'lobby:transferDestinationHint')}
      </p>
      <p className="online-transfer-self">
        <strong>{t('lobby:transferThisDevice')}</strong>
        <code>{fingerprint(selfDevice)}</code>
      </p>
      {role === 'destination' && selectedDevice && (
        <p className="online-transfer-self">
          <strong>{t('lobby:transferSourceDevice')}</strong>
          <code>{fingerprint(selectedDevice)}</code>
        </p>
      )}
      {role === 'source' && invitationUrl && (
        <div className="online-transfer-invitation">
          <InvitationCode value={invitationUrl} label={t('lobby:transferInvitation')} />
        </div>
      )}
      {role === 'source' && displayCandidates.length > 0 && !terminal && (
        <fieldset className="online-transfer-candidates" disabled={busy || selectedDevice !== null}>
          <legend>{t('lobby:transferChooseDevice')}</legend>
          {displayCandidates.map((peer) => (
            <label className="online-transfer-candidate" key={peer}>
              <input
                type="radio"
                name="online-transfer-device"
                value={peer}
                checked={selectedDevice === peer}
                onChange={() => onSelectDevice(peer)}
              />
              <code>{fingerprint(peer)}</code>
            </label>
          ))}
        </fieldset>
      )}
      <p className="online-transfer-phase" role="status">
        {busy && <span className="online-transfer-spinner" aria-hidden="true" />}
        {t(phaseKey)}
      </p>
      <p className="online-transfer-warning">{t('lobby:transferOldDeviceWarning')}</p>
      {error && (
        <p className="online-transfer-error" role="alert">
          {error}
        </p>
      )}
      {error && !busy && !terminal && (
        <button className="button button-quiet" type="button" onClick={onRetry}>
          {t('lobby:transferRetry')}
        </button>
      )}
      <div className="online-transfer-actions">
        {role === 'source' && !terminal && (
          <button
            className="button button-quiet"
            type="button"
            disabled={busy || phase === 'awaiting-receipt'}
            onClick={onCancel}
          >
            {t('lobby:transferCancel')}
          </button>
        )}
        {role === 'source' && phase === 'awaiting-confirmation' && (
          <button
            className="button button-primary"
            type="button"
            disabled={busy || !selectedDevice}
            onClick={onConfirm}
          >
            {t('lobby:transferConfirm')}
          </button>
        )}
        <button className="button button-quiet" type="button" onClick={onDismiss}>
          {t('lobby:manualClose')}
        </button>
      </div>
    </section>
  );
}
