import { useTranslation } from 'react-i18next';
import { isBaseResource } from '@cp2p/engine';
import type { CommandShape } from '@cp2p/engine';
import {
  getCommodityIconUrl,
  getProgressBackUrl,
  getResourceCardUrl,
  getResourceIconUrl,
} from '@cp2p/renderer';
import { DialogFrame } from '../../dialogs/DialogFrame.js';
import { resourceLabel } from '../../dialogs/resources.js';
import { ResourceCardSummary } from '../../trade/ResourceCard.js';
import type { CommandFormProps } from '../../dialogs/types.js';
import { TRACKS, isCommodity } from '../state.js';
import type { Track } from '../state.js';
import '../knights.css';

function trackOfCommand(command: CommandShape): Track | null {
  return TRACKS.find((track) => track === command.deck) ?? null;
}

/** The card kind an icon button shows. */
export function KindIcon({ kind }: { kind: string }) {
  return (
    <img
      src={
        isBaseResource(kind)
          ? getResourceIconUrl(kind)
          : getCommodityIconUrl(isCommodity(kind) ? kind : 'coin')
      }
      alt=""
      aria-hidden="true"
    />
  );
}

/** The Aqueduct: a roll that gave you nothing pays one resource of your choice. */
export function AqueductDialog({ legal, privateState, onSubmit }: CommandFormProps) {
  const { t } = useTranslation(['knights', 'rules']);
  const choices = legal.commands.filter((command) => command.type === 'CHOOSE_AQUEDUCT');
  if (choices.length === 0) return null;
  return (
    <DialogFrame title={t('knights:aqueduct.title')} variant="trade">
      <p>{t('knights:aqueduct.instruction')}</p>
      <div className="kind-choices" role="group" aria-label={t('knights:aqueduct.title')}>
        {choices.map((command) => {
          const resource = typeof command.resource === 'string' ? command.resource : '';
          return (
            <button
              className="kind-choice"
              type="button"
              key={resource}
              onClick={() => onSubmit(command)}
            >
              <img
                src={isBaseResource(resource) ? getResourceCardUrl(resource) : ''}
                alt=""
                aria-hidden="true"
              />
              <span>{resourceLabel(t, resource)}</span>
            </button>
          );
        })}
      </div>
      {/* The dialog covers the hand on phones, so show what the seat already holds. */}
      <ResourceCardSummary label={t('rules:trade.yourHand')} values={privateState.hand} />
    </DialogFrame>
  );
}

/** A tie at the top of the defenders: draw a progress card from the deck of your choice. */
export function DeckChoiceDialog({ legal, onSubmit }: CommandFormProps) {
  const { t } = useTranslation('knights');
  const choices = legal.commands.filter((command) => command.type === 'CHOOSE_PROGRESS_DECK');
  if (choices.length === 0) return null;
  return (
    <DialogFrame title={t('knights:deck.title')} variant="trade">
      <p>{t('knights:deck.instruction')}</p>
      <div className="kind-choices" role="group" aria-label={t('knights:deck.title')}>
        {choices.map((command) => {
          const track = trackOfCommand(command);
          if (track === null) return null;
          return (
            <button
              className="kind-choice"
              type="button"
              key={track}
              data-track={track}
              onClick={() => onSubmit(command)}
            >
              <img src={getProgressBackUrl(track)} alt="" aria-hidden="true" />
              <span>{t(`knights:track.${track}`)}</span>
            </button>
          );
        })}
      </div>
    </DialogFrame>
  );
}

/** A Commercial Harbor offer face down: answer with a commodity of your own, or return it. */
export function HarborReplyDialog({ legal, state, playerLabel, onSubmit }: CommandFormProps) {
  const { t } = useTranslation(['knights', 'rules']);
  const answers = legal.commands.filter((command) => command.type === 'HARBOR_REPLY');
  if (answers.length === 0) return null;
  const frame = state.turn.phase.at(-1);
  const data: unknown = frame?.data;
  const actor = typeof data === 'object' && data !== null ? Reflect.get(data, 'actor') : undefined;
  const from = state.config.seats.find((seat) => seat === actor);
  return (
    <DialogFrame title={t('knights:harbor.replyTitle')} variant="trade">
      <p>
        {from === undefined
          ? t('knights:harbor.replyAnonymous')
          : t('knights:harbor.replyInstruction', { player: playerLabel(from) })}
      </p>
      <div className="kind-choices" role="group" aria-label={t('knights:harbor.replyTitle')}>
        {answers.map((command) => {
          const commodity = typeof command.commodity === 'string' ? command.commodity : 'none';
          return (
            <button
              className="kind-choice"
              type="button"
              key={commodity}
              onClick={() => onSubmit(command)}
            >
              {commodity === 'none' ? null : (
                <img
                  src={getCommodityIconUrl(isCommodity(commodity) ? commodity : 'coin')}
                  alt=""
                  aria-hidden="true"
                />
              )}
              <span>
                {commodity === 'none'
                  ? t('knights:harbor.returnOffer')
                  : t('knights:harbor.giveBack', { commodity: resourceLabel(t, commodity) })}
              </span>
            </button>
          );
        })}
      </div>
    </DialogFrame>
  );
}

/** Commercial Harbor: offer each rival a resource from your hand, at most once each. */
export function HarborOfferDialog({
  legal,
  state,
  playerLabel,
  onSubmit,
  onCancel,
}: CommandFormProps) {
  const { t } = useTranslation(['knights', 'rules']);
  const offers = legal.commands.filter((command) => command.type === 'HARBOR_OFFER');
  const seats = state.config.seats.filter((seat) => offers.some((offer) => offer.to === seat));
  return (
    <DialogFrame
      title={t('knights:harbor.offerTitle')}
      variant="trade"
      onCancel={onCancel}
      footer={
        <div className="trade-dialog-footer">
          <div className="trade-dialog-buttons">
            <button className="button button-primary" type="button" onClick={onCancel}>
              {t('knights:harbor.done')}
            </button>
          </div>
        </div>
      }
    >
      <p>{t('knights:harbor.offerInstruction')}</p>
      {seats.length === 0 && <p className="muted">{t('knights:harbor.nobody')}</p>}
      <ul className="harbor-offers">
        {seats.map((seat) => (
          <li key={seat}>
            <span className="harbor-offer-name">{playerLabel(seat)}</span>
            <span className="harbor-offer-cards" role="group" aria-label={playerLabel(seat)}>
              {offers
                .filter((offer) => offer.to === seat)
                .map((offer) => {
                  const resource = typeof offer.resource === 'string' ? offer.resource : '';
                  return (
                    <button
                      className="button button-quiet harbor-offer-card"
                      type="button"
                      key={resource}
                      title={t('knights:harbor.offerOne', {
                        resource: resourceLabel(t, resource),
                        player: playerLabel(seat),
                      })}
                      aria-label={t('knights:harbor.offerOne', {
                        resource: resourceLabel(t, resource),
                        player: playerLabel(seat),
                      })}
                      onClick={() => onSubmit(offer)}
                    >
                      <KindIcon kind={resource} />
                    </button>
                  );
                })}
            </span>
          </li>
        ))}
      </ul>
    </DialogFrame>
  );
}
