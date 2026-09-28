import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CommandShape } from '@cp2p/engine';
import { DialogFrame } from '../../dialogs/DialogFrame.js';
import type { CommandFormProps } from '../../dialogs/types.js';
import { useCommandValidations } from '../../dialogs/use-command-validation.js';
import { ValidationChecking } from '../../dialogs/ValidationChecking.js';
import { ProgressCardBack, ProgressCardFace } from '../ProgressCardFace.js';
import { heldProgress, progressSurplus } from '../state.js';
import '../knights.css';

/** The slot ids a DISCARD_PROGRESS command names. */
function slotsOf(command: CommandShape): string[] {
  const cards: unknown = command.cards;
  return Array.isArray(cards)
    ? cards.flatMap((item: unknown) =>
        typeof item === 'object' && item !== null && typeof Reflect.get(item, 'slotId') === 'string'
          ? [String(Reflect.get(item, 'slotId'))]
          : [],
      )
    : [];
}

/**
 * Down to four progress cards: pick the surplus. Off turn it is asked before production; on your
 * own turn it may be done any time and is required before the turn can end. `forced` hides the
 * cancel button.
 */
export function DiscardProgressDialog({
  forced,
  ...props
}: CommandFormProps & {
  forced: boolean;
}) {
  const { legal, privateState, state, seat, onSubmit, onCancel } = props;
  const { t } = useTranslation(['knights', 'rules']);
  const held = heldProgress(state, seat, privateState);
  const need = progressSurplus(held);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const options = legal.commands.filter((command) => command.type === 'DISCARD_PROGRESS');
  const command = options.find((option) => {
    const slots = slotsOf(option);
    return slots.length === picked.length && slots.every((slot) => picked.includes(slot));
  });
  const [validation] = useCommandValidations(command ? [command] : [], props);
  if (options.length === 0 && !legal.templates.some((item) => item.type === 'DISCARD_PROGRESS'))
    return null;
  const valid = command !== undefined && validation === 'valid';
  const toggle = (slotId: string) =>
    setPicked((current) =>
      current.includes(slotId)
        ? current.filter((item) => item !== slotId)
        : current.length < need
          ? [...current, slotId]
          : current,
    );
  return (
    <DialogFrame
      title={t('knights:discardProgress.title')}
      variant="trade"
      onCancel={forced ? undefined : onCancel}
      footer={
        <div className="trade-dialog-footer">
          <p aria-live="polite">
            {t('rules:discard.selected', { selected: picked.length, count: need })}
          </p>
          <ValidationChecking checking={command !== undefined && validation === 'checking'} />
          <div className="trade-dialog-buttons">
            {!forced && onCancel && (
              <button className="button button-quiet" type="button" onClick={onCancel}>
                {t('rules:action.cancel')}
              </button>
            )}
            <button
              className="button button-primary"
              type="button"
              disabled={!valid}
              onClick={() => {
                if (valid && command) onSubmit(command);
              }}
            >
              {t('knights:discardProgress.confirm')}
            </button>
          </div>
        </div>
      }
    >
      <p>{t('knights:discardProgress.instruction', { count: need })}</p>
      <ul className="progress-pick" aria-label={t('knights:discardProgress.cards')}>
        {held.map((item) => (
          <li key={item.slotId}>
            <button
              type="button"
              className="progress-pick-card"
              aria-pressed={picked.includes(item.slotId)}
              aria-label={
                item.card
                  ? t(`knights:cards.${item.card}.name`)
                  : t('knights:card.hidden', { track: t(`knights:track.${item.track}`) })
              }
              onClick={() => toggle(item.slotId)}
            >
              {item.card ? (
                <ProgressCardFace card={item.card} size="md" />
              ) : (
                <ProgressCardBack track={item.track} size="md" />
              )}
            </button>
          </li>
        ))}
      </ul>
    </DialogFrame>
  );
}
