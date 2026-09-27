import { useTranslation } from 'react-i18next';
import { ActionPendingContext, DialogFrame } from '../dialogs/DialogFrame.js';

export function RecoveryVoidDialog({
  onViewBoard,
  onLeave,
  busy,
  leaveError,
}: {
  onViewBoard: () => void;
  onLeave: () => void;
  busy: boolean;
  leaveError: boolean;
}) {
  const { t } = useTranslation(['lobby', 'game']);
  return (
    <ActionPendingContext value={busy}>
      <DialogFrame
        title={t('lobby:onlineGameVoidTitle')}
        className="app-dialog"
        onCancel={onViewBoard}
        footer={
          <div className="dialog-actions">
            <button className="button button-quiet" type="button" onClick={onViewBoard}>
              {t('game:viewBoard')}
            </button>
            <button className="button button-primary" type="button" onClick={onLeave}>
              {t('game:leave')}
            </button>
          </div>
        }
      >
        <p>{t('lobby:onlineGameVoidBody')}</p>
        <p className="muted">{t('lobby:onlineGameVoidHistory')}</p>
        {leaveError && <p role="alert">{t('lobby:onlineLeaveFailed')}</p>}
      </DialogFrame>
    </ActionPendingContext>
  );
}
