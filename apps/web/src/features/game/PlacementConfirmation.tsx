import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardHit, BoardRenderer } from '@cp2p/renderer';
import { placePlacementConfirmation } from './placement-confirmation-layout';

interface Props {
  boardRef: RefObject<HTMLElement | null>;
  renderer: BoardRenderer | null;
  hit: BoardHit;
  piece: 'road' | 'settlement' | 'city';
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A camera-tracked confirmation anchored to a selected building location. */
export function PlacementConfirmation({
  boardRef,
  renderer,
  hit,
  piece,
  label,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useTranslation('game');
  const popupRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!renderer) return () => undefined;
    const place = () => {
      const board = boardRef.current;
      const popup = popupRef.current;
      if (!board || !popup) return;
      try {
        const point = renderer.getPixelPosition(hit);
        const projectedHalfSize =
          hit.kind === 'vertex'
            ? Math.abs(
                renderer.boardToScreen({ x: 25, y: 0 }).x -
                  renderer.boardToScreen({ x: 0, y: 0 }).x,
              )
            : 0;
        const next = placePlacementConfirmation(
          board.getBoundingClientRect(),
          point,
          { width: popup.offsetWidth, height: popup.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight },
          14 + projectedHalfSize,
        );
        setPosition((prior) => (prior?.x === next.x && prior.y === next.y ? prior : next));
      } catch {
        setPosition(null);
      }
    };
    const stopView = renderer.subscribeViewChange(place);
    const resize = new ResizeObserver(place);
    if (boardRef.current) resize.observe(boardRef.current);
    if (popupRef.current) resize.observe(popupRef.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      stopView();
      resize.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [boardRef, hit, renderer]);

  return (
    <div
      ref={popupRef}
      className="placement-confirmation"
      role="group"
      aria-label={t('game:placementPreviewTitle', { piece: t(`game:piece.${piece}`) })}
      style={{
        left: position?.x ?? 8,
        top: position?.y ?? 8,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <strong>{t('game:placementPreviewTitle', { piece: t(`game:piece.${piece}`) })}</strong>
      <p aria-live="polite">{label}</p>
      <div className="action-row">
        <button
          className="button button-primary"
          type="button"
          aria-label={t(`game:confirm.${piece}`)}
          onClick={onConfirm}
        >
          {t('game:confirmPlacement')}
        </button>
        <button className="button button-quiet" type="button" onClick={onCancel}>
          {t('game:cancelPlacement')}
        </button>
      </div>
    </div>
  );
}
