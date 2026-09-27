import { useTranslation } from 'react-i18next';
import { DialogFrame } from './DialogFrame.js';
import type { CommandFormProps } from './types.js';
import { useCommandValidations } from './use-command-validation.js';
import { ValidationChecking } from './ValidationChecking.js';

/** Victims are only those in the current concrete legal command list. */
export function StealDialog(props: CommandFormProps) {
  const { legal, state, onSubmit, onCancel, playerLabel } = props;
  const { t } = useTranslation('rules');
  const choices = legal.commands.flatMap((command) => {
    if (command.type !== 'STEAL') return [];
    const victim = state.config.seats.find((seat) => seat === command.victim);
    return victim === undefined ? [] : [{ command, victim }];
  });
  const validations = useCommandValidations(
    choices.map(({ command }) => command),
    props,
  );
  if (!choices.length) return null;
  return (
    <DialogFrame title={t('rules:steal.title')} onCancel={onCancel}>
      <p>{t('rules:steal.instruction')}</p>
      <ValidationChecking checking={validations.includes('checking')} />
      {choices.map(({ command, victim }, index) => (
        <button
          type="button"
          key={victim}
          disabled={validations[index] !== 'valid'}
          onClick={() => {
            if (validations[index] === 'valid') onSubmit(command);
          }}
        >
          {t('rules:steal.seat', {
            player: playerLabel(victim),
            count: state.seats.find((item) => item.seat === victim)?.resources.total ?? 0,
          })}
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
