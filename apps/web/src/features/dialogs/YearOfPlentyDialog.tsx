import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RESOURCES } from '@cp2p/engine';
import type { Resource, ResourceCounts } from '@cp2p/engine';
import { ResourceCardPicker, ResourceCardSummary } from '../trade/ResourceCard.js';
import { DialogFrame } from './DialogFrame.js';
import { emptyCounts } from './resources.js';
import type { CommandFormProps } from './types.js';
import { useCommandValidations } from './use-command-validation.js';
import { ValidationChecking } from './ValidationChecking.js';

interface Props extends CommandFormProps {
  slotId?: string;
}

/** The selected two cards are a request; a short bank may pay fewer cards. */
export function YearOfPlentyDialog(props: Props) {
  const { legal, state, privateState, onSubmit, onCancel, slotId } = props;
  const { t } = useTranslation('rules');
  const [resources, setResources] = useState<ResourceCounts>(emptyCounts);
  const template = legal.templates.find(
    (item) =>
      item.type === 'PLAY_DEV_CARD' &&
      item.card === 'yearOfPlenty' &&
      typeof item.slotId === 'string' &&
      (slotId === undefined || item.slotId === slotId),
  );
  const selected = RESOURCES.reduce((sum, resource) => sum + resources[resource], 0);
  const command = {
    type: 'PLAY_DEV_CARD',
    slotId: template?.slotId,
    card: 'yearOfPlenty',
    params: { resources },
  };
  const [validation] = useCommandValidations(template ? [command] : [], props);
  if (!template || typeof template.slotId !== 'string') return null;
  const valid = selected === 2 && validation === 'valid';
  const base = state.config.options.base;
  const hiddenBank =
    typeof base === 'object' && base !== null && Reflect.get(base, 'hideBankCounts') === true;
  const chosen = RESOURCES.flatMap((resource) =>
    Array<Resource>(resources[resource]).fill(resource),
  );
  const change = (resource: Resource, count: number) => {
    if (count < 0) return;
    setResources((current) => ({ ...current, [resource]: count }));
  };

  return (
    <DialogFrame
      title={t('rules:plenty.title')}
      onCancel={onCancel}
      variant="trade"
      footer={
        <div className="trade-dialog-footer">
          <p aria-live="polite">{t('rules:discard.selected', { selected, count: 2 })}</p>
          <ValidationChecking checking={selected === 2 && validation === 'checking'} />
          <div className="trade-dialog-buttons">
            {onCancel && (
              <button className="button button-quiet" type="button" onClick={onCancel}>
                {t('rules:action.cancel')}
              </button>
            )}
            <button
              className="button button-primary"
              type="button"
              disabled={!valid}
              onClick={() => {
                if (valid) onSubmit(command);
              }}
            >
              {t('rules:action.confirm')}
            </button>
          </div>
        </div>
      }
    >
      <p>{t('rules:plenty.instruction')}</p>
      <ResourceCardPicker
        label={t('rules:plenty.cards')}
        values={resources}
        onChange={change}
        onClear={() => setResources(emptyCounts)}
      />
      {hiddenBank ? (
        <p>{t('rules:plenty.bankHidden')}</p>
      ) : chosen.length === 2 ? (
        <p>
          {t('rules:plenty.bankAvailable', {
            first: state.bank[chosen[0] ?? 'brick'] ?? 0,
            second: state.bank[chosen[1] ?? 'brick'] ?? 0,
          })}
        </p>
      ) : null}
      {selected === 2 && validation === 'invalid' && (
        <p role="alert">{t('rules:validation.plenty')}</p>
      )}
      {/* The dialog covers the hand on phones, so show what the seat already holds. */}
      <ResourceCardSummary label={t('rules:trade.yourHand')} values={privateState.hand} />
    </DialogFrame>
  );
}
