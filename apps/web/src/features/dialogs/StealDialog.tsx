import { useTranslation } from 'react-i18next';
import { DialogFrame } from './DialogFrame.js';
import type { CommandFormProps } from './types.js';

/** Victims are only those in the current concrete legal command list. */
export function StealDialog({
  legal,
  state,
  validate,
  onSubmit,
  onCancel,
  playerLabel,
}: CommandFormProps) {
  const { t } = useTranslation('rules');
  const choices = legal.commands.flatMap((command) => {
    if (command.type !== 'STEAL') return [];
    const victim = state.config.seats.find((seat) => seat === command.victim);
    return victim === undefined ? [] : [{ command, victim }];
  });
  if (!choices.length) return null;
  return (
    <DialogFrame title={t('rules:steal.title')} onCancel={onCancel}>
      <p>{t('rules:steal.instruction')}</p>
      {choices.map(({ command, victim }) => (
        <button
          type="button"
          key={victim}
          disabled={!validate(command).ok}
          onClick={() => {
            if (validate(command).ok) onSubmit(command);
          }}
        >
          {t('rules:steal.seat', { player: playerLabel(victim) })}
        </button>
      ))}
      {onCancel && (
        <button type="button" onClick={onCancel}>
          {t('rules:action.cancel')}
        </button>
      )}
    </DialogFrame>
  );
}
