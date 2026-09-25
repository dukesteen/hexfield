import { RESOURCES } from '@cp2p/engine';
import type { CommandShape } from '@cp2p/engine';
import { useTranslation } from 'react-i18next';
import { resourceLabel } from '../dialogs/resources.js';
import type { CommandFormProps } from '../dialogs/types.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function offerSide(value: unknown, t: ReturnType<typeof useTranslation>['t']): string {
  if (!record(value)) return '';
  return RESOURCES.flatMap((resource) => {
    const count = value[resource];
    return typeof count === 'number' && count > 0 ? [`${count} ${resourceLabel(t, resource)}`] : [];
  }).join(', ');
}

function actionLabel(command: CommandShape, t: ReturnType<typeof useTranslation>['t']): string {
  if (command.type === 'RESPOND_TRADE')
    return command.accept === true ? t('rules:trade.accept') : t('rules:trade.decline');
  if (command.type === 'CONFIRM_TRADE') return t('rules:trade.confirm');
  return t('rules:trade.withdraw');
}

/** Public offer cards with only the supplied concrete response commands. */
export function IncomingOffers({
  legal,
  state,
  validate,
  onSubmit,
  playerLabel,
}: CommandFormProps) {
  const { t } = useTranslation('rules');
  const base = state.ext.base;
  const value = record(base) ? base.offers : null;
  const offers = Array.isArray(value) ? value : [];
  const responses = legal.commands.filter(
    (command) =>
      (command.type === 'RESPOND_TRADE' ||
        command.type === 'CANCEL_TRADE' ||
        command.type === 'CONFIRM_TRADE') &&
      typeof command.offerId === 'number',
  );
  if (!responses.length) return null;
  return (
    <section aria-label={t('rules:trade.offers')}>
      <h3>{t('rules:trade.offers')}</h3>
      {offers.map((offer) => {
        if (!record(offer) || typeof offer.id !== 'number') return null;
        const proposer = state.config.seats.find((seat) => seat === offer.proposer);
        if (proposer === undefined) return null;
        const choices = responses.filter((command) => command.offerId === offer.id);
        if (!choices.length) return null;
        return (
          <article key={offer.id}>
            <p>{t('rules:trade.offerFrom', { player: playerLabel(proposer) })}</p>
            <p>
              {t('rules:trade.offerTerms', {
                give: offerSide(offer.give, t),
                want: offerSide(offer.want, t),
              })}
            </p>
            {choices.map((command, index) => (
              <button
                type="button"
                key={`${command.type}:${index}`}
                disabled={!validate(command).ok}
                onClick={() => {
                  if (validate(command).ok) onSubmit(command);
                }}
              >
                {actionLabel(command, t)}
              </button>
            ))}
          </article>
        );
      })}
    </section>
  );
}
