import { useTranslation } from 'react-i18next';
import type { GameState, PrivateState, Seat } from '@cp2p/engine';
import { cardInfo } from './catalogue';
import type { KnightsController } from './controller';
import { ProgressCardBack, ProgressCardFace } from './ProgressCardFace';
import { heldProgress, progressSurplus } from './state';
import './knights.css';

/**
 * The progress cards a seat holds, as a fan of small faces. A card the engine offers a play for is
 * lit and opens its play; the others wait. Over the limit of four, a button opens the discard.
 */
export function ProgressHand({
  state,
  seat,
  priv,
  controller,
}: {
  state: Readonly<GameState>;
  seat: Seat;
  priv: PrivateState | null;
  controller: KnightsController | null;
}) {
  const { t } = useTranslation('knights');
  const held = heldProgress(state, seat, priv);
  const surplus = progressSurplus(held);
  if (held.length === 0 && !controller?.harborOpen) return null;
  return (
    <div
      className="progress-hand"
      role="group"
      aria-label={t('knights:progress.hand', { count: held.length })}
      data-count={held.length}
    >
      {held.map((item) => {
        const playable = controller?.playable(item.slotId) ?? false;
        const name = item.card
          ? t(`knights:cards.${item.card}.name`)
          : t('knights:card.hidden', { track: t(`knights:track.${item.track}`) });
        const reason = !item.card
          ? name
          : playable
            ? `${name}: ${t(`knights:cards.${item.card}.text`)}`
            : `${name}: ${t('knights:card.waiting')}`;
        return (
          <button
            key={item.slotId}
            type="button"
            className="progress-hand-card"
            data-playable={playable}
            data-card={item.card ?? 'hidden'}
            data-testid={`progress-card-${item.card ?? 'hidden'}`}
            title={reason}
            aria-label={reason}
            disabled={!controller || controller.disabled || !playable}
            onClick={() => {
              if (item.card && controller) controller.playCard(item.slotId, item.card);
            }}
          >
            {item.card ? (
              <ProgressCardFace card={item.card} size="sm" dimmed={!playable} />
            ) : (
              <ProgressCardBack track={item.track} size="sm" />
            )}
            {item.card && cardInfo(item.card).play === 'board' && playable && (
              <i className="progress-hand-aim" aria-hidden="true">
                {t('knights:card.aim')}
              </i>
            )}
          </button>
        );
      })}
      {controller?.harborOpen && (
        <button
          type="button"
          className="button button-quiet progress-hand-harbor"
          onClick={() => controller.openHarbor()}
        >
          {t('knights:harbor.reopen')}
        </button>
      )}
      {surplus > 0 && controller && (
        <button
          type="button"
          className="button button-primary progress-hand-discard"
          onClick={() => controller.openDiscard()}
        >
          {t('knights:discardProgress.button', { count: surplus })}
        </button>
      )}
    </div>
  );
}
