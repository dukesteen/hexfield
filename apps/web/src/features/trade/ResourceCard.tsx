import { useId } from 'react';
import { RESOURCES } from '@cp2p/engine';
import type { Resource, ResourceCounts } from '@cp2p/engine';
import { getResourceCardUrl } from '@cp2p/renderer';
import { useTranslation } from 'react-i18next';
import { resourceLabel } from '../dialogs/resources.js';
import './trade.css';

interface CardPickerProps {
  label: string;
  values: ResourceCounts;
  available?: Partial<ResourceCounts>;
  steps?: Partial<ResourceCounts>;
  onChange: (resource: Resource, count: number) => void;
  onClear: () => void;
}

/** The card face is decorative; nearby text and controls carry the accessible meaning. */
export function ResourceCard({
  resource,
  count,
  size = 'md',
}: {
  resource: Resource;
  count?: number;
  size?: 'sm' | 'md';
}) {
  const { t } = useTranslation('rules');
  return (
    <span className="resource-card" data-resource={resource} data-size={size}>
      <img src={getResourceCardUrl(resource)} alt="" aria-hidden="true" draggable={false} />
      {count !== undefined && <b className="resource-card-count">{count}</b>}
      <span className="resource-card-name">{resourceLabel(t, resource)}</span>
    </span>
  );
}

/** Card taps add a configured unit; separate remove controls keep touch and keyboard use explicit. */
export function ResourceCardPicker({
  label,
  values,
  available,
  steps,
  onChange,
  onClear,
}: CardPickerProps) {
  const { t } = useTranslation('rules');
  const selected = RESOURCES.reduce((total, resource) => total + (values[resource] ?? 0), 0);
  return (
    <fieldset className="trade-card-picker">
      <legend>{label}</legend>
      <div className="trade-card-picker-head">
        <p className="trade-card-picker-total">
          {t('rules:trade.cardSelected', { count: selected })}
        </p>
        <button
          className="button button-quiet trade-card-clear"
          type="button"
          aria-label={t('rules:trade.clearSide', { side: label })}
          disabled={selected === 0}
          onClick={onClear}
        >
          {t('rules:trade.clear')}
        </button>
      </div>
      <div className="trade-card-grid">
        {RESOURCES.map((resource) => {
          const count = values[resource] ?? 0;
          const stock = available?.[resource];
          const step = steps?.[resource] ?? 1;
          const atCap = stock !== undefined && count + step > stock;
          const name = resourceLabel(t, resource);
          return (
            <div className="trade-card-choice" data-selected={count > 0} key={resource}>
              <button
                className="trade-card-add"
                type="button"
                aria-label={t('rules:trade.addCard', { resource: name, side: label })}
                aria-disabled={atCap}
                onClick={() => {
                  if (!atCap) onChange(resource, count + step);
                }}
              >
                <ResourceCard resource={resource} {...(count > 0 ? { count } : {})} />
                {step > 1 && (
                  <small className="trade-card-rate">
                    {t('rules:bank.rateBadge', { rate: step })}
                  </small>
                )}
                {stock !== undefined && (
                  <small className="trade-card-stock">
                    {t('rules:trade.cardAvailable', { count: stock })}
                  </small>
                )}
              </button>
              <output className="trade-visually-hidden" aria-live="polite">
                {t('rules:trade.cardCount', { count })}
              </output>
              <button
                className="trade-card-remove"
                type="button"
                aria-label={t('rules:trade.removeCard', { resource: name, side: label })}
                hidden={count === 0}
                onClick={() => onChange(resource, Math.max(0, count - step))}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M3.5 8h9" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

interface CardSummaryProps {
  label: string;
  values: Partial<ResourceCounts>;
}

/** Offer terms are already public; this component never reads a private hand. */
export function ResourceCardSummary({ label, values }: CardSummaryProps) {
  const { t } = useTranslation('rules');
  const labelId = useId();
  const shown = RESOURCES.filter((resource) => (values[resource] ?? 0) > 0);
  return (
    <div className="trade-card-summary" role="group" aria-labelledby={labelId}>
      <span className="trade-card-summary-label" id={labelId}>
        {label}
      </span>
      {shown.length > 0 ? (
        <ul className="trade-card-row">
          {shown.map((resource) => (
            <li key={resource}>
              <ResourceCard resource={resource} count={values[resource] ?? 0} size="sm" />
            </li>
          ))}
        </ul>
      ) : (
        <p className="trade-card-empty">{t('rules:trade.nothing')}</p>
      )}
    </div>
  );
}

/** Two public card groups with a decorative exchange mark between them. */
export function TradeExchange({
  first,
  second,
}: {
  first: CardSummaryProps;
  second: CardSummaryProps;
}) {
  return (
    <div className="trade-exchange">
      <ResourceCardSummary {...first} />
      <svg
        className="trade-exchange-arrow"
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4" />
      </svg>
      <ResourceCardSummary {...second} />
    </div>
  );
}
