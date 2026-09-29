import { useTranslation } from 'react-i18next';
import type { CommandShape } from '@cp2p/engine';
import { DialogFrame } from '../../dialogs/DialogFrame.js';
import type { CommandFormProps } from '../../dialogs/types.js';
import { ImprovementsBoard } from '../ImprovementsBoard.js';
import { improvableTracks } from '../improve.js';
import type { GamePresentation } from '../../../queries/repositories/saved-games.js';
import '../knights.css';

/** The city improvements as a dialog, for phones: the same board as the sidebar's, to buy from. */
export function ImprovementsDialog({
  legal,
  state,
  seat,
  presentation,
  onSubmit,
  onCancel,
}: CommandFormProps & { presentation: GamePresentation; onCancel: () => void }) {
  const { t } = useTranslation('knights');
  const buyable = improvableTracks(legal.commands);
  return (
    <DialogFrame
      title={t('knights:improve.title')}
      variant="trade"
      onCancel={onCancel}
      footer={
        <div className="trade-dialog-footer">
          <div className="trade-dialog-buttons">
            <button className="button button-primary" type="button" onClick={onCancel}>
              {t('knights:close')}
            </button>
          </div>
        </div>
      }
    >
      <p className="muted">{t('knights:improve.intro')}</p>
      <ImprovementsBoard
        state={state}
        seat={seat}
        presentation={presentation}
        buyable={buyable}
        onBuy={(track) => {
          const command: CommandShape | undefined = legal.commands.find(
            (item) => item.type === 'BUILD_IMPROVEMENT' && item.track === track,
          );
          if (command) onSubmit(command);
        }}
      />
    </DialogFrame>
  );
}
