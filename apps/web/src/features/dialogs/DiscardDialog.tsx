import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RESOURCES } from '@cp2p/engine';
import type { Resource, ResourceCounts } from '@cp2p/engine';
import { DialogFrame } from './DialogFrame.js';
import { emptyCounts, ResourceFields } from './resources.js';
import type { CommandFormProps } from './types.js';

/** The exact count comes from the engine's discard template. */
export function DiscardDialog({
  legal,
  privateState,
  validate,
  onSubmit,
  onCancel,
}: CommandFormProps) {
  const { t } = useTranslation('rules');
  const [cards, setCards] = useState<ResourceCounts>(emptyCounts);
  const template = legal.templates.find((item) => item.type === 'DISCARD');
  if (typeof template?.count !== 'number') return null;
  const count = template.count;
  const selected = RESOURCES.reduce((sum, resource) => sum + cards[resource], 0);
  const command = { type: 'DISCARD', cards };
  const valid = selected === count && validate(command).ok;
  const change = (resource: Resource, value: number) => {
    if (value <= (privateState.hand[resource] ?? 0))
      setCards((current) => ({ ...current, [resource]: value }));
  };

  return (
    <DialogFrame title={t('rules:discard.title')} onCancel={onCancel}>
      <p>{t('rules:discard.selected', { selected, count })}</p>
      <ResourceFields
        label={t('rules:discard.cards')}
        values={cards}
        maximum={privateState.hand}
        onChange={change}
      />
      <button
        type="button"
        disabled={!valid}
        onClick={() => {
          if (valid) onSubmit(command);
        }}
      >
        {t('rules:action.confirm')}
      </button>
      {onCancel && (
        <button type="button" onClick={onCancel}>
          {t('rules:action.cancel')}
        </button>
      )}
    </DialogFrame>
  );
}
