import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RESOURCES } from '@cp2p/engine';
import type { Resource, ResourceCounts } from '@cp2p/engine';
import { ResourceCardPicker } from '../trade/ResourceCard.js';
import { DialogFrame } from './DialogFrame.js';
import { emptyCounts } from './resources.js';
import type { CommandFormProps } from './types.js';
import { useCommandValidations } from './use-command-validation.js';
import { ValidationChecking } from './ValidationChecking.js';

interface Props extends CommandFormProps {
  slotId?: string;
}

/** Card selection resolves to an exact engine-provided Monopoly command. */
export function MonopolyDialog(props: Props) {
  const { legal, onSubmit, onCancel, slotId } = props;
  const { t } = useTranslation('rules');
  const [selected, setSelected] = useState<Resource | null>(null);
  const choices = legal.commands.filter(
    (command) =>
      command.type === 'PLAY_DEV_CARD' &&
      command.card === 'monopoly' &&
      (slotId === undefined || command.slotId === slotId),
  );
  const selectable = RESOURCES.filter((resource) =>
    choices.some((choice) => {
      const params = choice.params;
      return (
        typeof params === 'object' &&
        params !== null &&
        Reflect.get(params, 'resource') === resource
      );
    }),
  );
  const values: ResourceCounts = selected ? { ...emptyCounts(), [selected]: 1 } : emptyCounts();
  const command = choices.find((choice) => {
    const params = choice.params;
    return (
      typeof params === 'object' && params !== null && Reflect.get(params, 'resource') === selected
    );
  });
  const [validation] = useCommandValidations(command ? [command] : [], props);
  if (!choices.length) return null;
  return (
    <DialogFrame
      title={t('rules:monopoly.title')}
      onCancel={onCancel}
      variant="trade"
      footer={
        <div className="trade-dialog-footer">
          <ValidationChecking checking={!!command && validation === 'checking'} />
          <div className="trade-dialog-buttons">
            {onCancel && (
              <button className="button button-quiet" type="button" onClick={onCancel}>
                {t('rules:action.cancel')}
              </button>
            )}
            <button
              className="button button-primary"
              type="button"
              disabled={!command || validation !== 'valid'}
              onClick={() => {
                if (command && validation === 'valid') onSubmit(command);
              }}
            >
              {t('rules:action.confirm')}
            </button>
          </div>
        </div>
      }
    >
      <p>{t('rules:monopoly.instruction')}</p>
      <ResourceCardPicker
        label={t('rules:monopoly.cards')}
        values={values}
        selectable={selectable}
        onChange={(resource: Resource, count) => setSelected(count > 0 ? resource : null)}
        onClear={() => setSelected(null)}
      />
    </DialogFrame>
  );
}
