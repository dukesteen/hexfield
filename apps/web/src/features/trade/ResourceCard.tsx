import { useId, useRef } from 'react';
import { RESOURCES } from '@cp2p/engine';
import type { Resource, ResourceCounts } from '@cp2p/engine';
import { getResourceCardUrl } from '@cp2p/renderer';
import { useTranslation } from 'react-i18next';
import { resourceLabel } from '../dialogs/resources.js';
import './trade.css';

interface CardPickerProps {
  label: string;
  values: ResourceCounts;
  stock?: { source: 'hand' | 'bank'; counts: Partial<ResourceCounts> };
  selectable?: readonly Resource[];
  steps?: Partial<ResourceCounts>;
  onChange: (resource: Resource, count: number) => void;
  onClear: () => void;
}

/** The card face is decorative; nearby text and controls carry the accessible meaning. */
export function ResourceCard({
  resource,
  count,
  stock,
  size = 'md',
}: {
  resource: Resource;
  count?: number;
  stock?: number;
  size?: 'sm' | 'md';
}) {
  const { t } = useTranslation('rules');
  return (
    <span className="resource-card" data-resource={resource} data-size={size}>
      <img src={getResourceCardUrl(resource)} alt="" aria-hidden="true" draggable={false} />
      {count !== undefined && <b className="resource-card-count">{count}</b>}
      {stock !== undefined && (
        <span className="resource-card-stock" aria-hidden="true">
          {stock}
        </span>
      )}
      <span className="resource-card-name">{resourceLabel(t, resource)}</span>
    </span>
  );
}

/** Card taps add a configured unit; separate remove controls keep touch and keyboard use explicit. */
export function ResourceCardPicker({
  label,
  values,
  stock,
  selectable,
  steps,
  onChange,
  onClear,
}: CardPickerProps) {
  const { t } = useTranslation('rules');
  const id = useId();
  const addButtons = useRef(new Map<Resource, HTMLButtonElement>());
  const selected = RESOURCES.reduce((total, resource) => total + (values[resource] ?? 0), 0);
  const stockTotal = stock
    ? RESOURCES.reduce((total, resource) => total + (stock.counts[resource] ?? 0), 0)
    : 0;
  return (
    <fieldset className="trade-card-picker">
      <legend>{label}</legend>
      <div className="trade-card-picker-head">
        <p className="trade-card-picker-total">
          {t('rules:trade.cardSelected', { count: selected })}
        </p>
        {stock && (
          <p className="trade-card-stock-key">
            <span className="resource-card-stock" aria-hidden="true">
              {stockTotal}
            </span>
            <span aria-hidden="true">
              {stock.source === 'bank' ? t('rules:trade.inBank') : t('rules:trade.inHand')}
            </span>
            <span className="trade-visually-hidden">
              {stock.source === 'bank'
                ? t('rules:trade.stockBank', { count: stockTotal })
                : t('rules:trade.stockHand', { count: stockTotal })}
            </span>
          </p>
        )}
        <button
          className="button button-quiet trade-card-clear"
          type="button"
          aria-label={t('rules:trade.clearSide', { side: label })}
          disabled={selected === 0}
          onClick={() => {
            onClear();
            for (const resource of RESOURCES) {
              const button = addButtons.current.get(resource);
              if (button) {
                button.focus();
                break;
              }
            }
          }}
        >
          {t('rules:trade.clear')}
        </button>
      </div>
      <div className="trade-card-grid">
        {RESOURCES.map((resource) => {
          const count = values[resource] ?? 0;
          const stockCount = stock?.counts[resource];
          const step = steps?.[resource] ?? 1;
          const atCap = stockCount !== undefined && count + step > stockCount;
          const unavailable = selectable !== undefined && !selectable.includes(resource);
          const name = resourceLabel(t, resource);
          const rateId = `${id}-${resource}-rate`;
          const stockId = `${id}-${resource}-stock`;
          const describedBy = [
            step > 1 ? rateId : undefined,
            stockCount !== undefined ? stockId : undefined,
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div className="trade-card-choice" data-selected={count > 0} key={resource}>
              <button
                className="trade-card-add"
                type="button"
                ref={(button) => {
                  if (button) addButtons.current.set(resource, button);
                  else addButtons.current.delete(resource);
                }}
                aria-label={t('rules:trade.addCard', { resource: name, side: label })}
                {...(describedBy ? { 'aria-describedby': describedBy } : {})}
                aria-disabled={atCap || unavailable}
                onClick={() => {
                  if (!atCap && !unavailable) onChange(resource, count + step);
                }}
              >
                <ResourceCard
                  resource={resource}
                  {...(count > 0 ? { count } : {})}
                  {...(stockCount !== undefined ? { stock: stockCount } : {})}
                />
                {step > 1 && (
                  <small className="trade-card-rate" id={rateId}>
                    {t('rules:bank.rateBadge', { rate: step })}
                  </small>
                )}
                {stockCount !== undefined && (
                  <span className="trade-visually-hidden" id={stockId}>
                    {stock?.source === 'bank'
                      ? t('rules:trade.stockBank', { count: stockCount })
                      : t('rules:trade.stockHand', { count: stockCount })}
                  </span>
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
                onClick={() => {
                  const nextCount = Math.max(0, count - step);
                  onChange(resource, nextCount);
                  if (nextCount === 0) addButtons.current.get(resource)?.focus();
                }}
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
