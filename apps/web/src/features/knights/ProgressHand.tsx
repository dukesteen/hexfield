import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GameState, PrivateState, Seat } from '@cp2p/engine';
import { DialogFrame } from '../dialogs/DialogFrame';
import { cardInfo } from './catalogue';
import type { KnightsController } from './controller';
import { ProgressCardBack, ProgressCardFace } from './ProgressCardFace';
import { notPlayableReason } from './progress-reason';
import type { NotPlayableReason } from './progress-reason';
import { heldProgress, progressSurplus } from './state';
import './knights.css';

/**
 * The progress cards a seat holds, as a fan of small faces. A card the engine offers a play for is
 * lit and opens its play; tapping any other card shows it large with why it cannot be played now.
 * Over the limit of four, a button opens the discard.
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
  const [viewing, setViewing] = useState<{ card: string; reason: NotPlayableReason } | null>(null);
  const held = heldProgress(state, seat, priv);
  const surplus = progressSurplus(held);
  if (held.length === 0 && !controller?.harborOpen) return null;
  return (
    <>
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
              disabled={!item.card}
              onClick={() => {
                if (!item.card) return;
                if (playable && controller && !controller.disabled)
                  controller.playCard(item.slotId, item.card);
                else
                  setViewing({
                    card: item.card,
                    reason: notPlayableReason(
                      state,
                      seat,
                      item.card,
                      playable && controller?.disabled === true,
                    ),
                  });
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
      {viewing && (
        // The game's dialog styles hang off the action forms container (display: contents).
        <div className="action-forms">
          <CardView card={viewing.card} reason={viewing.reason} onClose={() => setViewing(null)} />
        </div>
      )}
    </>
  );
}

/** A held card shown large, read-only, with why it cannot be played now. */
function CardView({
  card,
  reason,
  onClose,
}: {
  card: string;
  reason: NotPlayableReason;
  onClose: () => void;
}) {
  const { t } = useTranslation('knights');
  return (
    <DialogFrame
      title={t(`knights:cards.${card}.name`)}
      variant="trade"
      className="progress-view-dialog"
      onCancel={onClose}
      footer={
        <div className="trade-dialog-footer">
          <div className="trade-dialog-buttons">
            <button className="button button-primary" type="button" onClick={onClose}>
              {t('knights:close')}
            </button>
          </div>
        </div>
      }
    >
      <div className="play-card-body">
        <ProgressCardFace card={card} size="lg" />
        <p className="progress-view-reason" role="status" data-reason={reason}>
          {t(`knights:card.reason.${reason}`)}
        </p>
      </div>
    </DialogFrame>
  );
}
