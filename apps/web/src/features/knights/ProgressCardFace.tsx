import { useTranslation } from 'react-i18next';
import { isBaseResource } from '@cp2p/engine';
import {
  getCommodityIconUrl,
  getGlyphUrl,
  getKnightIconUrl,
  getMerchantIconUrl,
  getPieceIconUrl,
  getProgressBackUrl,
  getRedDieUrl,
  getResourceIconUrl,
  getTrackIconUrl,
  getWallIconUrl,
} from '@cp2p/renderer';
import { cardInfo, isVictoryCardId } from './catalogue';
import type { CardInfo } from './catalogue';
import type { Track } from './state';
import './knights.css';

function emblemUrl(info: CardInfo): string {
  const emblem = info.emblem;
  if ('glyph' in emblem) return getGlyphUrl(emblem.glyph);
  if ('resource' in emblem && isBaseResource(emblem.resource))
    return getResourceIconUrl(emblem.resource);
  if ('commodity' in emblem) return getCommodityIconUrl(emblem.commodity);
  if ('piece' in emblem) return getPieceIconUrl(emblem.piece, 'red');
  if ('die' in emblem) return getRedDieUrl(6);
  if ('knight' in emblem) return getKnightIconUrl('red', emblem.knight, true);
  if ('wall' in emblem) return getWallIconUrl('red');
  if ('merchant' in emblem) return getMerchantIconUrl('red');
  return getTrackIconUrl(info.track);
}

export type CardSize = 'sm' | 'md' | 'lg';

/** The face of a progress card: its deck's colour band, an emblem, its name and what it does. */
export function ProgressCardFace({
  card,
  size = 'md',
  dimmed = false,
}: {
  card: string;
  size?: CardSize;
  dimmed?: boolean;
}) {
  const { t } = useTranslation('knights');
  const info = cardInfo(card);
  const victory = isVictoryCardId(card);
  return (
    <span
      className="progress-face"
      data-size={size}
      data-track={info.track}
      data-card={card}
      data-dimmed={dimmed}
    >
      <span className="progress-face-band">
        <img src={getTrackIconUrl(info.track)} alt="" aria-hidden="true" />
        <small>{t(`knights:track.${info.track}`)}</small>
        {victory && <b className="progress-face-vp">{t('knights:card.vp')}</b>}
      </span>
      <span className="progress-face-emblem">
        <img src={emblemUrl(info)} alt="" aria-hidden="true" draggable={false} />
      </span>
      <strong className="progress-face-name">{t(`knights:cards.${card}.name`)}</strong>
      <span className="progress-face-text">{t(`knights:cards.${card}.text`)}</span>
      {info.preRoll && <em className="progress-face-timing">{t('knights:card.beforeRoll')}</em>}
    </span>
  );
}

/** The back of a card of a deck, for hands and decks that are not shown. */
export function ProgressCardBack({
  track,
  count,
  size = 'sm',
}: {
  track: Track;
  count?: number;
  size?: CardSize;
}) {
  const { t } = useTranslation('knights');
  return (
    <span className="progress-back" data-size={size} data-track={track}>
      <img src={getProgressBackUrl(track)} alt="" aria-hidden="true" draggable={false} />
      {count !== undefined && (
        <b aria-label={t('knights:deckCount', { count, track: t(`knights:track.${track}`) })}>
          {count}
        </b>
      )}
    </span>
  );
}
