import { useEffect, useId, useRef, useState } from 'react';
import { RESOURCES } from '@cp2p/engine';
import type { CommandShape, ResourceCounts, Seat } from '@cp2p/engine';
import { useTranslation } from 'react-i18next';
import type { CommandFormProps } from '../dialogs/types.js';
import { TradeExchange } from './ResourceCard.js';

type ResponseStatus = 'accepted' | 'declined' | 'waiting';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function counts(value: unknown): Partial<ResourceCounts> {
  if (!record(value)) return {};
  const result: Partial<Record<keyof ResourceCounts, number>> = {};
  for (const resource of RESOURCES) {
    const count = value[resource];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0)
      result[resource] = count;
  }
  return result;
}

function responseStatus(offer: Record<string, unknown>, seat: number): ResponseStatus {
  if (Array.isArray(offer.acceptedBy) && offer.acceptedBy.includes(seat)) return 'accepted';
  if (Array.isArray(offer.declinedBy) && offer.declinedBy.includes(seat)) return 'declined';
  return 'waiting';
}

function statusLabel(status: ResponseStatus, t: ReturnType<typeof useTranslation>['t']): string {
  if (status === 'accepted') return t('rules:trade.accepted');
  if (status === 'declined') return t('rules:trade.declined');
  return t('rules:trade.waiting');
}

function actionLabel(
  command: CommandShape,
  t: ReturnType<typeof useTranslation>['t'],
  seats: readonly Seat[],
  playerLabel: (seat: Seat) => string,
): string {
  if (command.type === 'RESPOND_TRADE')
    return command.accept === true ? t('rules:trade.accept') : t('rules:trade.decline');
  const counterparty = seats.find((seat) => seat === command.withSeat);
  if (command.type === 'CONFIRM_TRADE')
    return counterparty === undefined
      ? t('rules:trade.confirm')
      : t('rules:trade.confirmWith', { player: playerLabel(counterparty) });
  return t('rules:trade.withdraw');
}

/** Tone is presentation only; the engine's choice list and order stay untouched. */
function actionTone(command: CommandShape): 'button-primary' | 'button-quiet' {
  if (command.type === 'RESPOND_TRADE')
    return command.accept === true ? 'button-primary' : 'button-quiet';
  return command.type === 'CONFIRM_TRADE' ? 'button-primary' : 'button-quiet';
}

function StatusIcon({ status }: { status: ResponseStatus }) {
  return (
    <svg className="trade-response-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {status === 'accepted' && <path d="m4 8.5 2.5 2.5L12 5.5" />}
      {status === 'declined' && <path d="m5 5 6 6m0-6-6 6" />}
      {status === 'waiting' && <path d="M4 8h.01M8 8h.01M12 8h.01" />}
    </svg>
  );
}

/** Public offers stay visible, while only the viewing seat's concrete actions are clickable. */
export function IncomingOffers({
  legal,
  state,
  seat,
  validate,
  onSubmit,
  playerLabel,
  collapsedWhilePlacing = false,
}: CommandFormProps & { collapsedWhilePlacing?: boolean }) {
  const { t } = useTranslation('rules');
  const base = state.ext.base;
  const value = record(base) ? base.offers : null;
  const offers = Array.isArray(value)
    ? value.filter(
        (offer): offer is Record<string, unknown> => record(offer) && typeof offer.id === 'number',
      )
    : [];
  const offerIds = offers.map((offer) => offer.id).join(',');
  const responses = legal.commands.filter(
    (command) =>
      (command.type === 'RESPOND_TRADE' ||
        command.type === 'CANCEL_TRADE' ||
        command.type === 'CONFIRM_TRADE') &&
      typeof command.offerId === 'number',
  );
  const actionableIds = [...new Set(responses.map((command) => command.offerId))];
  const actionable = actionableIds.length;
  const actionableKey = actionableIds.join(',');
  const [expanded, setExpanded] = useState(actionable > 0);
  const [selectedId, setSelectedId] = useState<number | null>(
    typeof offers[0]?.id === 'number' ? offers[0].id : null,
  );
  const summaryRef = useRef<HTMLElement>(null);
  const noteId = useId();
  useEffect(() => {
    const activeIds = actionableKey.split(',').filter(Boolean).map(Number);
    const allIds = offerIds.split(',').filter(Boolean).map(Number);
    setExpanded(activeIds.length > 0);
    setSelectedId((current) => {
      if (current !== null && activeIds.includes(current)) return current;
      const firstActionable = activeIds[0];
      if (typeof firstActionable === 'number') return firstActionable;
      if (current !== null && allIds.includes(current)) return current;
      return allIds[0] ?? null;
    });
  }, [offerIds, actionableKey]);
  if (!offers.length) return null;
  const selected = offers.find((offer) => offer.id === selectedId) ?? offers[0];
  if (!selected || typeof selected.id !== 'number') return null;
  const proposer = state.config.seats.find((candidate) => candidate === selected.proposer);
  if (proposer === undefined) return null;
  const own = proposer === seat;
  const recipient = Array.isArray(selected.to) && selected.to.includes(seat);
  // Both perspectives read "what leaves the proposer" first, so no side is reordered.
  const giveLabel = own
    ? t('rules:trade.youGive')
    : recipient
      ? t('rules:trade.youGet')
      : t('rules:trade.playerGives', { player: playerLabel(proposer) });
  const wantLabel = own
    ? t('rules:trade.youGet')
    : recipient
      ? t('rules:trade.youGive')
      : t('rules:trade.playerWants', { player: playerLabel(proposer) });
  const choices = responses.filter(
    (command) =>
      command.offerId === selected.id &&
      (selected.valid !== false || command.type === 'CANCEL_TRADE'),
  );
  const acceptBlocked = choices.some(
    (command) =>
      command.type === 'RESPOND_TRADE' && command.accept === true && !validate(command).ok,
  );
  const index = offers.indexOf(selected);
  const step = (delta: number) => {
    const next = offers[index + delta]?.id;
    if (typeof next === 'number') setSelectedId(next);
  };
  return (
    <section
      className="trade-offers"
      aria-label={t('rules:trade.offers')}
      data-placing={collapsedWhilePlacing}
    >
      <details
        className="trade-offer-panel"
        open={expanded && !collapsedWhilePlacing}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setExpanded(false);
            summaryRef.current?.focus();
          }
        }}
      >
        <summary
          ref={summaryRef}
          className="trade-offer-summary"
          onClick={(event) => {
            event.preventDefault();
            if (!collapsedWhilePlacing) setExpanded((current) => !current);
          }}
        >
          <span className="trade-offer-count">
            <span aria-hidden="true">{offers.length}</span>
            <span className="trade-visually-hidden">
              {t('rules:trade.offerCount', { count: offers.length })}
            </span>
          </span>
          <span className="trade-offer-title">
            {own
              ? t('rules:trade.yourOffer')
              : t('rules:trade.offerFrom', { player: playerLabel(proposer) })}
          </span>
        </summary>
        <div className="trade-offer-body">
          {offers.length > 1 && (
            <div className="trade-offer-pager">
              <button
                type="button"
                className="trade-offer-step"
                aria-label={t('rules:trade.previousOffer')}
                disabled={index <= 0}
                onClick={() => step(-1)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M10 3 5 8l5 5" />
                </svg>
              </button>
              <span aria-live="polite">
                {t('rules:trade.offerPosition', { index: index + 1, count: offers.length })}
              </span>
              <button
                type="button"
                className="trade-offer-step"
                aria-label={t('rules:trade.nextOffer')}
                disabled={index >= offers.length - 1}
                onClick={() => step(1)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="m6 3 5 5-5 5" />
                </svg>
              </button>
            </div>
          )}
          <TradeExchange
            first={{ label: giveLabel, values: counts(selected.give) }}
            second={{ label: wantLabel, values: counts(selected.want) }}
          />
          {selected.valid === false && (
            <p className="trade-offer-note" data-tone="error">
              {t('rules:trade.noLongerValid')}
            </p>
          )}
          {acceptBlocked && (
            <p className="trade-offer-note" id={noteId}>
              {t('rules:trade.cannotAccept')}
            </p>
          )}
          {own && Array.isArray(selected.to) && (
            <ul
              className="trade-responses"
              aria-label={t('rules:trade.responses')}
              aria-live="polite"
            >
              {selected.to.flatMap((recipientSeat) => {
                const matched = state.config.seats.find((candidate) => candidate === recipientSeat);
                if (matched === undefined) return [];
                const status = responseStatus(selected, matched);
                return [
                  <li key={matched} data-status={status}>
                    <StatusIcon status={status} />
                    <span className="trade-response-name">{playerLabel(matched)}</span>
                    <span className="trade-visually-hidden">{statusLabel(status, t)}</span>
                  </li>,
                ];
              })}
            </ul>
          )}
        </div>
        {choices.length > 0 && (
          <div className="trade-offer-actions" data-layout={own ? 'stack' : 'row'}>
            {choices.map((command, position) => {
              const ok = validate(command).ok;
              return (
                <button
                  type="button"
                  className={`button ${actionTone(command)}`}
                  key={`${command.type}:${position}`}
                  disabled={!ok}
                  aria-describedby={!ok && acceptBlocked ? noteId : undefined}
                  onClick={() => {
                    if (validate(command).ok) onSubmit(command);
                  }}
                >
                  {actionLabel(command, t, state.config.seats, playerLabel)}
                </button>
              );
            })}
          </div>
        )}
      </details>
    </section>
  );
}
