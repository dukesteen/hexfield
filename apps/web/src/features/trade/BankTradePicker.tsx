import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { baseHarborRate, engineForConfig } from '@cp2p/engine';
import { cardKinds } from '../knights/state.js';
import { DialogFrame } from '../dialogs/DialogFrame.js';
import { emptyCounts } from '../dialogs/resources.js';
import type { CommandFormProps } from '../dialogs/types.js';
import { useCommandValidations } from '../dialogs/use-command-validation.js';
import { ValidationChecking } from '../dialogs/ValidationChecking.js';
import { ResourceCardPicker } from './ResourceCard.js';

/** Each give-card tap adds exactly one harbor-rate unit; the live validator remains final. */
export function BankTradePicker(props: CommandFormProps) {
  const { legal, state, seat, privateState, onSubmit, onCancel } = props;
  const { t } = useTranslation('rules');
  const kinds = cardKinds(state);
  const [give, setGive] = useState<Record<string, number>>(() => emptyCounts(kinds));
  const [get, setGet] = useState<Record<string, number>>(() => emptyCounts(kinds));
  const [touched, setTouched] = useState(false);
  const base = state.config.options.base;
  const hideBankCounts =
    typeof base === 'object' && base !== null && Reflect.get(base, 'hideBankCounts') === true;
  const command = { type: 'MARITIME_TRADE', give, get };
  const [validation] = useCommandValidations([command], props);
  if (!legal.templates.some((item) => item.type === 'MARITIME_TRADE')) return null;
  // Harbors set the base rate; modules (the merchant, Trade level 3, a fleet) improve it.
  const { hooks } = engineForConfig(state.config);
  const rates: Record<string, number> = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      hooks.bankRate(state, seat, kind, baseHarborRate(state, seat, kind)),
    ]),
  );
  const cards = kinds.reduce((total, resource) => total + (give[resource] ?? 0), 0);
  const units = kinds.reduce((total, resource) => total + (get[resource] ?? 0), 0);
  const footer = (
    <div className="trade-dialog-footer">
      <ValidationChecking checking={validation === 'checking' && touched} />
      {validation === 'invalid' && touched && (
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
          disabled={validation !== 'valid'}
          onClick={() => {
            if (validation === 'valid') onSubmit(command);
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
          kinds={kinds}
          stock={{ source: 'hand', counts: privateState.hand }}
          steps={rates}
          onChange={(resource, value) => {
            setTouched(true);
            if (value <= (privateState.hand[resource] ?? 0))
              setGive((current) => ({ ...current, [resource]: value }));
          }}
          onClear={() => {
            setTouched(true);
            setGive(emptyCounts(kinds));
          }}
        />
        <ResourceCardPicker
          label={t('rules:bank.get')}
          values={get}
          kinds={kinds}
          {...(hideBankCounts ? {} : { stock: { source: 'bank' as const, counts: state.bank } })}
          onChange={(resource, value) => {
            setTouched(true);
            setGet((current) => ({ ...current, [resource]: value }));
          }}
          onClear={() => {
            setTouched(true);
            setGet(emptyCounts(kinds));
          }}
        />
      </div>
      <p className="trade-card-exchange-total">{t('rules:bank.cardsForUnits', { cards, units })}</p>
    </DialogFrame>
  );
}
