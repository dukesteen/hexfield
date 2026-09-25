import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RESOURCES } from '@cp2p/engine';
import type { Resource, ResourceCounts } from '@cp2p/engine';
import { ResourceCardPicker } from '../trade/ResourceCard.js';
import { DialogFrame } from './DialogFrame.js';
import { emptyCounts } from './resources.js';
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
    if (value < 0 || value > (privateState.hand[resource] ?? 0)) return;
    setCards((current) => ({ ...current, [resource]: value }));
  };

  return (
    <DialogFrame
      title={t('rules:discard.title')}
      onCancel={onCancel}
      variant="trade"
      footer={
        <div className="trade-dialog-footer">
          <p aria-live="polite">{t('rules:discard.selected', { selected, count })}</p>
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
                if (selected === count && validate(command).ok) onSubmit(command);
              }}
            >
              {t('rules:action.confirm')}
            </button>
          </div>
        </div>
      }
    >
      <ResourceCardPicker
        label={t('rules:discard.cards')}
        values={cards}
        stock={{ source: 'hand', counts: privateState.hand }}
        onChange={change}
        onClear={() => setCards(emptyCounts)}
      />
    </DialogFrame>
  );
}
