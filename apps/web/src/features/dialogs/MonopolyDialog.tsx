import { useTranslation } from 'react-i18next';
import { DialogFrame } from './DialogFrame.js';
import { resourceLabel } from './resources.js';
import type { CommandFormProps } from './types.js';
import { RESOURCES } from '@cp2p/engine';

interface Props extends CommandFormProps {
  slotId?: string;
}

/** Every choice is a concrete command from the engine, including its card slot. */
export function MonopolyDialog({ legal, validate, onSubmit, onCancel, slotId }: Props) {
  const { t } = useTranslation('rules');
  const choices = legal.commands.filter(
    (command) =>
      command.type === 'PLAY_DEV_CARD' &&
      command.card === 'monopoly' &&
      (slotId === undefined || command.slotId === slotId),
  );
  if (!choices.length) return null;
  return (
    <DialogFrame title={t('rules:monopoly.title')} onCancel={onCancel}>
      <p>{t('rules:monopoly.instruction')}</p>
      {choices.map((command) => {
        const params = command.params;
        const value =
          typeof params === 'object' && params !== null ? Reflect.get(params, 'resource') : null;
        const resource = RESOURCES.find((item) => item === value);
        if (!resource) return null;
        return (
          <button
            key={`${String(command.slotId)}:${resource}`}
            type="button"
            disabled={!validate(command).ok}
            onClick={() => {
              if (validate(command).ok) onSubmit(command);
            }}
          >
            {resourceLabel(t, resource)}
          </button>
        );
      })}
      {onCancel && (
        <button type="button" onClick={onCancel}>
          {t('rules:action.cancel')}
        </button>
      )}
    </DialogFrame>
  );
}
