import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RESOURCES } from '@cp2p/engine';
import type { Resource, ResourceCounts } from '@cp2p/engine';
import { getSeafaringIconUrl } from '@cp2p/renderer';
import { goldRequest } from '../game/seafaring';
import { ResourceCardPicker } from '../trade/ResourceCard.js';
import { DialogFrame } from './DialogFrame.js';
import { emptyCounts } from './resources.js';
import type { CommandFormProps } from './types.js';
import { useCommandValidations } from './use-command-validation.js';
import { ValidationChecking } from './ValidationChecking.js';

/**
 * A gold field paid out: take exactly as many cards as the claim, capped at what the bank
 * holds, in any mix the bank can still pay. The count comes from the gold phase, not the client.
 */
export function GoldDialog(props: CommandFormProps) {
  const { state, seat, playerLabel, onSubmit } = props;
  const { t } = useTranslation('rules');
  const [cards, setCards] = useState<ResourceCounts>(emptyCounts);
  const request = goldRequest(state, seat);
  const command = { type: 'CHOOSE_GOLD', resources: cards };
  const [validation] = useCommandValidations([command], props);
  if (!request) return null;
  const selected = RESOURCES.reduce((sum, resource) => sum + cards[resource], 0);
  const valid = selected === request.count && validation === 'valid';
  const base = state.config.options.base;
  const hiddenBank =
    typeof base === 'object' && base !== null && Reflect.get(base, 'hideBankCounts') === true;
  const change = (resource: Resource, value: number) => {
    const others = selected - cards[resource];
    if (value < 0 || others + value > request.count) return;
    if (!hiddenBank && value > (state.bank[resource] ?? 0)) return;
    setCards((current) => ({ ...current, [resource]: value }));
  };

  return (
    <DialogFrame
      title={t('rules:gold.title')}
      variant="trade"
      footer={
        <div className="trade-dialog-footer">
          <p aria-live="polite">
            {t('rules:discard.selected', { selected, count: request.count })}
          </p>
          <ValidationChecking checking={selected === request.count && validation === 'checking'} />
          <div className="trade-dialog-buttons">
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
      <p className="gold-dialog-intro">
        <img src={getSeafaringIconUrl('gold')} alt="" aria-hidden="true" width={40} height={40} />
        <span>{t('rules:gold.instruction', { count: request.count })}</span>
      </p>
      {request.count < request.claim && (
        <p role="status">{t('rules:gold.bankShort', { claim: request.claim })}</p>
      )}
      <ResourceCardPicker
        label={t('rules:gold.cards')}
        values={cards}
        {...(hiddenBank ? {} : { stock: { source: 'bank' as const, counts: state.bank } })}
        onChange={change}
        onClear={() => setCards(emptyCounts)}
      />
      {hiddenBank && <p>{t('rules:gold.bankHidden')}</p>}
      {selected === request.count && validation === 'invalid' && (
        <p role="alert">{t('rules:validation.gold')}</p>
      )}
      {request.waiting.length > 0 && (
        <p className="muted">
          {t('rules:gold.waiting', { players: request.waiting.map(playerLabel).join(', ') })}
        </p>
      )}
    </DialogFrame>
  );
}
