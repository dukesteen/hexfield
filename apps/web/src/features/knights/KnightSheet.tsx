import { useTranslation } from 'react-i18next';
import type { CommandShape } from '@cp2p/engine';
import { getKnightIconUrl } from '@cp2p/renderer';
import { DialogFrame } from '../dialogs/DialogFrame';
import type { KnightStatus } from './knight-status';
import './knights.css';

/**
 * What a tap on a knight shows: its strength and readiness, the actions it has now (a move or a
 * displacement goes on to the board with its targets marked), or why it has none.
 */
export function KnightSheet({
  status,
  owner,
  color,
  disabled = false,
  onChoose,
  onSubmit,
  onClose,
}: {
  status: KnightStatus;
  owner: string;
  color: string;
  disabled?: boolean;
  onChoose: (kind: 'moveKnight' | 'displaceKnight') => void;
  onSubmit: (command: CommandShape) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('knights');
  const actions: { key: string; label: string; run: () => void }[] = [];
  if (status.moves.length > 0)
    actions.push({
      key: 'move',
      label: t('knights:knightSheet.move', { count: status.moves.length }),
      run: () => onChoose('moveKnight'),
    });
  if (status.displaces.length > 0)
    actions.push({
      key: 'displace',
      label: t('knights:knightSheet.displace', { count: status.displaces.length }),
      run: () => onChoose('displaceKnight'),
    });
  for (const [key, command] of [
    ['chase', status.chase],
    ['activate', status.activate],
    ['promote', status.promote],
  ] as const)
    if (command)
      actions.push({ key, label: t(`knights:action.${key}`), run: () => onSubmit(command) });
  return (
    <DialogFrame
      title={t(`knights:knightSheet.level${status.level}`)}
      variant="trade"
      className="knight-sheet"
      onCancel={onClose}
      footer={
        <div className="trade-dialog-footer">
          <div className="trade-dialog-buttons">
            <button className="button button-quiet" type="button" onClick={onClose}>
              {t('knights:close')}
            </button>
          </div>
        </div>
      }
    >
      <div className="knight-sheet-head">
        <img
          src={getKnightIconUrl(color, status.level, status.readiness !== 'inactive')}
          alt=""
          aria-hidden="true"
        />
        <div>
          <p className="knight-sheet-owner">{owner}</p>
          <p className="knight-sheet-state" data-readiness={status.readiness}>
            {t(`knights:knightSheet.readiness.${status.readiness}`)}
          </p>
        </div>
      </div>
      {status.idle && (
        <p className="knight-sheet-reason" role="status" data-reason={status.idle}>
          {t(`knights:knightSheet.idle.${status.idle}`)}
        </p>
      )}
      {actions.length > 0 && (
        <div className="knight-sheet-actions">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              className="button button-primary"
              data-action={action.key}
              disabled={disabled}
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </DialogFrame>
  );
}
