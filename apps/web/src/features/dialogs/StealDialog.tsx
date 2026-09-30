import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { Seat } from '@cp2p/engine';
import { DialogFrame } from './DialogFrame.js';
import type { CommandFormProps } from './types.js';
import { useCommandValidations } from './use-command-validation.js';
import { ValidationChecking } from './ValidationChecking.js';

interface StealDialogProps extends CommandFormProps {
  /**
   * Open the steal sheet for this victim instead of stealing at once (the "pick the card"
   * setting). The sheet submits the same STEAL command; the tapped card never reaches it.
   */
  onPickCard?: ((victim: Seat, handSize: number) => void) | undefined;
}

/** Victims are only those in the current concrete legal command list. */
export function StealDialog(props: StealDialogProps) {
  const { legal, state, onSubmit, onCancel, playerLabel, onPickCard } = props;
  const { t } = useTranslation('rules');
  const choices = legal.commands.flatMap((command) => {
    if (command.type !== 'STEAL') return [];
    const victim = state.config.seats.find((seat) => seat === command.victim);
    return victim === undefined
      ? []
      : [
          {
            command,
            victim,
            count: state.seats.find((item) => item.seat === victim)?.resources.total ?? 0,
          },
        ];
  });
  const validations = useCommandValidations(
    choices.map(({ command }) => command),
    props,
  );
  const only = choices.length === 1 ? choices[0] : undefined;
  // With one victim there is nothing to choose: its cards show straight away.
  const openOnly = only && onPickCard && only.count > 0 ? only : undefined;
  const openVictim = openOnly?.victim;
  const openCount = openOnly?.count ?? 0;
  useEffect(() => {
    if (openVictim !== undefined) onPickCard?.(openVictim, openCount);
  }, [onPickCard, openVictim, openCount]);
  if (!choices.length || openOnly) return null;
  return (
    <DialogFrame title={t('rules:steal.title')} onCancel={onCancel}>
      <p>{t('rules:steal.instruction')}</p>
      <ValidationChecking checking={validations.includes('checking')} />
      {choices.map(({ command, victim, count }, index) => (
        <button
          type="button"
          key={victim}
          disabled={validations[index] !== 'valid'}
          onClick={() => {
            if (validations[index] !== 'valid') return;
            if (onPickCard && count > 0) onPickCard(victim, count);
            else onSubmit(command);
          }}
        >
          {t('rules:steal.seat', { player: playerLabel(victim), count })}
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
