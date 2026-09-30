import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { isBaseResource } from '@cp2p/engine';
import { getCommodityCardUrl, getGameArtUrl, getResourceCardUrl } from '@cp2p/renderer';
import { ActionPendingContext, DialogFrame } from '../dialogs/DialogFrame.js';
import { resourceLabel } from '../dialogs/resources.js';
import { STEAL_FAN_MAX, type ScreenPoint, type StealReveal } from './steal-reveal';
import './steal-sheet.css';

/** The card turns over, then stays face up this long before the sheet closes and it flies. */
export const STEAL_FLIP_MS = 420;
export const STEAL_REVEAL_HOLD_MS = 650;
/** With reduced motion the face shows at once, for this long, with no flip and no flight. */
export const STEAL_REDUCED_HOLD_MS = 700;

function faceUrl(kind: string): string {
  if (isBaseResource(kind)) return getResourceCardUrl(kind);
  return getCommodityCardUrl(kind === 'paper' || kind === 'cloth' ? kind : 'coin');
}

function fanStyle(count: number) {
  return { position: 'relative', '--fan-count': count } satisfies CSSProperties & {
    '--fan-count': number;
  };
}

function cardStyle(angle: number) {
  // Every card turns about a point below the fan, so the backs spread like a held hand.
  return { transformOrigin: '50% 140%', '--card-angle': `${angle}deg` } satisfies CSSProperties & {
    '--card-angle': string;
  };
}

interface StealSheetProps {
  reveal: StealReveal;
  victimName: string;
  victimColor: string;
  reducedMotion: boolean;
  /** Tap a face-down card. Cosmetic: the stolen card is the fair draw, whichever is tapped. */
  onPick: (index: number) => void;
  /** The reveal is over; fly the card on from `from`, or null for no flight. */
  onDone: (from: ScreenPoint | null) => void;
  /** Back to the victim choice, before anything is submitted. */
  onCancel?: (() => void) | undefined;
}

/**
 * The victim's hand as a fan of face-down cards. The thief taps one; once the fair steal result is
 * in, that card turns over to show it, the sheet closes and the card flies into the hand.
 */
export function StealSheet({
  reveal,
  victimName,
  victimColor,
  reducedMotion,
  onPick,
  onDone,
  onCancel,
}: StealSheetProps) {
  const { t } = useTranslation('rules');
  const shown = Math.min(reveal.handSize, STEAL_FAN_MAX);
  const extra = reveal.handSize - shown;
  const [focused, setFocused] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const cards = useRef<(HTMLButtonElement | null)[]>([]);
  const done = useRef(false);
  const { picked, face } = reveal;
  const revealed = picked !== null && face !== null;
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!revealed || done.current) return undefined;
    const finish = (from: ScreenPoint | null) => {
      if (done.current) return;
      done.current = true;
      doneRef.current(from);
    };
    if (reducedMotion) {
      setFlipped(true);
      const timer = window.setTimeout(() => finish(null), STEAL_REDUCED_HOLD_MS);
      return () => window.clearTimeout(timer);
    }
    const frame = window.requestAnimationFrame(() => setFlipped(true));
    const timer = window.setTimeout(() => {
      const card = cards.current[picked];
      const rect = card?.getBoundingClientRect();
      finish(
        rect && rect.width > 0
          ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          : null,
      );
    }, STEAL_FLIP_MS + STEAL_REVEAL_HOLD_MS);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [picked, reducedMotion, revealed]);

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (index + 1) % shown
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (index - 1 + shown) % shown
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? shown - 1
              : null;
    if (target === null) return;
    event.preventDefault();
    setFocused(target);
    cards.current[target]?.focus();
  };

  const status = revealed
    ? t('rules:steal.stole', { resource: resourceLabel(t, face), player: victimName })
    : picked !== null
      ? t('rules:steal.drawing')
      : t('rules:steal.pickInstruction', { player: victimName });
  const spread = shown > 1 ? Math.min(5, 36 / (shown - 1)) : 0;

  return (
    <ActionPendingContext.Provider value={false}>
      <DialogFrame
        title={t('rules:steal.title')}
        className={`steal-sheet${reducedMotion ? ' steal-sheet-still' : ''}`}
        onCancel={picked === null && face === null ? onCancel : undefined}
      >
        <p className={`steal-sheet-victim color-${victimColor}`}>
          <span className="steal-sheet-swatch" aria-hidden="true" />
          <strong>{victimName}</strong>
          <span className="muted">{t('rules:steal.handCount', { count: reveal.handSize })}</span>
        </p>
        <div
          className="steal-fan"
          role="group"
          aria-label={t('rules:steal.fanLabel', { player: victimName })}
          style={fanStyle(shown)}
        >
          {Array.from({ length: shown }, (_, index) => {
            const isPicked = picked === index;
            const turned = isPicked && flipped && face !== null;
            const angle = (index - (shown - 1) / 2) * spread;
            return (
              <button
                key={index}
                ref={(element) => {
                  cards.current[index] = element;
                }}
                type="button"
                className={[
                  'steal-card',
                  isPicked ? 'is-picked' : '',
                  isPicked && face === null ? 'is-pending' : '',
                  turned ? 'is-turned' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={cardStyle(angle)}
                data-index={index}
                tabIndex={index === (picked ?? focused) ? 0 : -1}
                aria-disabled={picked !== null}
                aria-label={
                  turned
                    ? t('rules:steal.cardFaceUp', {
                        index: index + 1,
                        count: shown,
                        resource: resourceLabel(t, face),
                      })
                    : t('rules:steal.cardFaceDown', { index: index + 1, count: shown })
                }
                onFocus={() => setFocused(index)}
                onKeyDown={(event) => move(event, index)}
                onClick={() => {
                  if (picked === null) onPick(index);
                }}
              >
                <span className="steal-card-inner">
                  <img className="steal-card-back" src={getGameArtUrl('cardBack')} alt="" />
                  {isPicked && face !== null && (
                    <img className="steal-card-face" src={faceUrl(face)} alt="" />
                  )}
                </span>
              </button>
            );
          })}
          {extra > 0 && (
            <span
              className="steal-fan-more"
              aria-label={t('rules:steal.moreCards', { count: extra })}
            >
              +{extra}
            </span>
          )}
        </div>
        <p className="steal-sheet-status" role="status">
          {status}
        </p>
        {onCancel && picked === null && face === null && (
          <button type="button" onClick={onCancel}>
            {t('rules:steal.back')}
          </button>
        )}
      </DialogFrame>
    </ActionPendingContext.Provider>
  );
}
