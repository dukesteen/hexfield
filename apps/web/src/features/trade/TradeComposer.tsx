import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Resource, ResourceCounts, Seat } from '@cp2p/engine';
import { DialogFrame } from '../dialogs/DialogFrame.js';
import { emptyCounts } from '../dialogs/resources.js';
import type { CommandFormProps } from '../dialogs/types.js';
import { ResourceCardPicker } from './ResourceCard.js';

function hasOpenOffer(value: unknown, seat: Seat): boolean {
  if (typeof value !== 'object' || value === null || !('offers' in value)) return false;
  return (
    Array.isArray(value.offers) &&
    value.offers.some(
      (offer: unknown) =>
        typeof offer === 'object' &&
        offer !== null &&
        'proposer' in offer &&
        offer.proposer === seat,
    )
  );
}

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
  const [touched, setTouched] = useState(false);
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
    setTouched(true);
    if (field === 'give') {
      if (value <= (privateState.hand[resource] ?? 0))
        setGive((current) => ({ ...current, [resource]: value }));
    } else setWant((current) => ({ ...current, [resource]: value }));
  };
  const footer = (
    <div className="trade-dialog-footer">
      {!result.ok && touched && (
        <p className="trade-dialog-error" role="alert">
          {t('rules:validation.trade')}
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
          {t('rules:trade.send')}
        </button>
      </div>
    </div>
  );
  return (
    <DialogFrame title={t('rules:trade.title')} onCancel={onCancel} variant="trade" footer={footer}>
      <div className="trade-dialog-sides">
        <ResourceCardPicker
          label={t('rules:trade.give')}
          values={give}
          available={privateState.hand}
          onChange={(resource, value) => change('give', resource, value)}
          onClear={() => {
            setTouched(true);
            setGive(emptyCounts());
          }}
        />
        <ResourceCardPicker
          label={t('rules:trade.want')}
          values={want}
          onChange={(resource, value) => change('want', resource, value)}
          onClear={() => {
            setTouched(true);
            setWant(emptyCounts());
          }}
        />
      </div>
      {template.type === 'OFFER_TRADE' ? (
        <fieldset className="trade-recipients">
          <legend>{t('rules:trade.recipients')}</legend>
          <div className="trade-recipient-chips">
            {state.config.seats
              .filter((candidate) => candidate !== seat)
              .map((candidate) => (
                <button
                  className="button button-quiet trade-recipient-chip"
                  type="button"
                  key={candidate}
                  aria-pressed={to.includes(candidate)}
                  onClick={() => {
                    setTouched(true);
                    setTo((current) =>
                      current.includes(candidate)
                        ? current.filter((item) => item !== candidate)
                        : [...current, candidate].toSorted((a, b) => a - b),
                    );
                  }}
                >
                  {playerLabel(candidate)}
                </button>
              ))}
          </div>
        </fieldset>
      ) : (
        <p>{t('rules:trade.toPlayer', { player: playerLabel(state.turn.activeSeat) })}</p>
      )}
      {template.type === 'OFFER_TRADE' && hasOpenOffer(state.ext.base, seat) && (
        <p>{t('rules:trade.replacesOffer')}</p>
      )}
    </DialogFrame>
  );
}
