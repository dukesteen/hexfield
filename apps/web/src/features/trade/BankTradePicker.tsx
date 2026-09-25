import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { baseHarborRate, RESOURCES } from '@cp2p/engine';
import type { ResourceCounts } from '@cp2p/engine';
import { DialogFrame } from '../dialogs/DialogFrame.js';
import { emptyCounts } from '../dialogs/resources.js';
import type { CommandFormProps } from '../dialogs/types.js';
import { ResourceCardPicker } from './ResourceCard.js';

/** Each give-card tap adds exactly one harbor-rate unit; the live validator remains final. */
export function BankTradePicker({
  legal,
  state,
  seat,
  privateState,
  validate,
  onSubmit,
  onCancel,
}: CommandFormProps) {
  const { t } = useTranslation('rules');
  const [give, setGive] = useState<ResourceCounts>(emptyCounts);
  const [get, setGet] = useState<ResourceCounts>(emptyCounts);
  const [touched, setTouched] = useState(false);
  if (!legal.templates.some((item) => item.type === 'MARITIME_TRADE')) return null;
  const base = state.config.options.base;
  const hideBankCounts =
    typeof base === 'object' && base !== null && Reflect.get(base, 'hideBankCounts') === true;
  const command = { type: 'MARITIME_TRADE', give, get };
  const result = validate(command);
  const rates: ResourceCounts = {
    brick: baseHarborRate(state, seat, 'brick'),
    lumber: baseHarborRate(state, seat, 'lumber'),
    wool: baseHarborRate(state, seat, 'wool'),
    grain: baseHarborRate(state, seat, 'grain'),
    ore: baseHarborRate(state, seat, 'ore'),
  };
  const cards = RESOURCES.reduce((total, resource) => total + (give[resource] ?? 0), 0);
  const units = RESOURCES.reduce((total, resource) => total + (get[resource] ?? 0), 0);
  const footer = (
    <div className="trade-dialog-footer">
      {!result.ok && touched && (
        <p className="trade-dialog-error" role="alert">
          {t('rules:validation.bank')}
        </p>
      )}
      <div className="trade-dialog-buttons">
        {onCancel && (
          <button className="button button-quiet" type="button" onClick={onCancel}>
            {t('rules:action.cancel')}
          </button>
        )}
        <button
          className="button button-primary"
          type="button"
          disabled={!result.ok}
          onClick={() => {
            if (validate(command).ok) onSubmit(command);
          }}
        >
          {t('rules:action.confirm')}
        </button>
      </div>
    </div>
  );
  return (
    <DialogFrame title={t('rules:bank.title')} onCancel={onCancel} variant="trade" footer={footer}>
      <div className="trade-dialog-sides">
        <ResourceCardPicker
          label={t('rules:trade.give')}
          values={give}
          stock={{ source: 'hand', counts: privateState.hand }}
          steps={rates}
          onChange={(resource, value) => {
            setTouched(true);
            if (value <= (privateState.hand[resource] ?? 0))
              setGive((current) => ({ ...current, [resource]: value }));
          }}
          onClear={() => {
            setTouched(true);
            setGive(emptyCounts());
          }}
        />
        <ResourceCardPicker
          label={t('rules:bank.get')}
          values={get}
          {...(hideBankCounts ? {} : { stock: { source: 'bank' as const, counts: state.bank } })}
          onChange={(resource, value) => {
            setTouched(true);
            setGet((current) => ({ ...current, [resource]: value }));
          }}
          onClear={() => {
            setTouched(true);
            setGet(emptyCounts());
          }}
        />
      </div>
      <p className="trade-card-exchange-total">{t('rules:bank.cardsForUnits', { cards, units })}</p>
    </DialogFrame>
  );
}
