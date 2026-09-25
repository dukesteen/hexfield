import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Resource, ResourceCounts, Seat } from '@cp2p/engine';
import { DialogFrame } from '../dialogs/DialogFrame.js';
import { emptyCounts, ResourceFields } from '../dialogs/resources.js';
import type { CommandFormProps } from '../dialogs/types.js';

/** Offer or counter-offer composer; the live validator decides whether its terms can be sent. */
export function TradeComposer({
  legal,
  state,
  seat,
  privateState,
  validate,
  onSubmit,
  onCancel,
  playerLabel,
}: CommandFormProps) {
  const { t } = useTranslation('rules');
  const [give, setGive] = useState<ResourceCounts>(emptyCounts);
  const [want, setWant] = useState<ResourceCounts>(emptyCounts);
  const [to, setTo] = useState<Seat[]>(() =>
    state.config.seats.filter((candidate) => candidate !== seat),
  );
  const template = legal.templates.find(
    (item) => item.type === 'OFFER_TRADE' || item.type === 'PROPOSE_TRADE',
  );
  if (!template) return null;
  const command =
    template.type === 'OFFER_TRADE'
      ? { type: template.type, give, want, to }
      : { type: template.type, give, want };
  const result = validate(command);
  const change = (field: 'give' | 'want', resource: Resource, value: number) => {
    if (field === 'give') {
      if (value <= (privateState.hand[resource] ?? 0))
        setGive((current) => ({ ...current, [resource]: value }));
    } else setWant((current) => ({ ...current, [resource]: value }));
  };
  return (
    <DialogFrame title={t('rules:trade.title')} onCancel={onCancel} variant="trade">
      <ResourceFields
        label={t('rules:trade.give')}
        values={give}
        maximum={privateState.hand}
        onChange={(resource, value) => change('give', resource, value)}
      />
      <ResourceFields
        label={t('rules:trade.want')}
        values={want}
        onChange={(resource, value) => change('want', resource, value)}
      />
      {template.type === 'OFFER_TRADE' && (
        <fieldset>
          <legend>{t('rules:trade.recipients')}</legend>
          {state.config.seats
            .filter((candidate) => candidate !== seat)
            .map((candidate) => (
              <label key={candidate}>
                <input
                  type="checkbox"
                  checked={to.includes(candidate)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setTo((current) =>
                      checked
                        ? [...current, candidate].toSorted((a, b) => a - b)
                        : current.filter((item) => item !== candidate),
                    );
                  }}
                />
                {playerLabel(candidate)}
              </label>
            ))}
        </fieldset>
      )}
      <button
        type="button"
        disabled={!result.ok}
        onClick={() => {
          if (validate(command).ok) onSubmit(command);
        }}
      >
        {t('rules:trade.send')}
      </button>
      {!result.ok && <p role="alert">{t('rules:validation.trade')}</p>}
      {onCancel && (
        <button type="button" onClick={onCancel}>
          {t('rules:action.cancel')}
        </button>
      )}
    </DialogFrame>
  );
}
