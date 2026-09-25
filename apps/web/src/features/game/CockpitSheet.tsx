import {
  useEffect,
  useId,
  useRef,
  type TouchEvent as ReactTouchEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

export function CockpitSheet({
  title,
  dialogRef,
  onClosed,
  swipeToDismiss = false,
  children,
}: {
  title: string;
  dialogRef: RefObject<HTMLDialogElement | null>;
  onClosed: () => void;
  swipeToDismiss?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation('game');
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const swipeStart = useRef<{
    identifier: number;
    x: number;
    y: number;
    dismissEligible: boolean;
  } | null>(null);
  const beginSwipe = (event: ReactTouchEvent<HTMLElement>, dismissEligible: boolean) => {
    if (!swipeToDismiss || event.touches.length !== 1) {
      swipeStart.current = null;
      return;
    }
    if (event.target instanceof Element && event.target.closest('button')) {
      swipeStart.current = null;
      return;
    }
    const touch = event.touches.item(0);
    if (!touch) return;
    swipeStart.current = {
      identifier: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      dismissEligible,
    };
  };
  const finishSwipe = (event: ReactTouchEvent<HTMLElement>) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;
    const touch = Array.from(event.changedTouches).find(
      (item) => item.identifier === start.identifier,
    );
    if (!touch) return;
    const movedX = Math.abs(touch.clientX - start.x);
    const movedY = touch.clientY - start.y;
    if (start.dismissEligible && movedY >= 72 && movedX < 60) dialogRef.current?.close();
  };
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.open = true;
    heading.current?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close?.();
    };
  }, [dialogRef]);
  return (
    <dialog
      ref={dialogRef}
      className="cockpit-sheet"
      aria-labelledby={titleId}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
      onClose={(event) => {
        // StrictMode may queue a close event from its effect replay after reopening.
        if (!event.currentTarget.open) onClosed();
      }}
    >
      <header
        className="cockpit-sheet-header"
        onTouchStart={(event) => beginSwipe(event, true)}
        onTouchEnd={finishSwipe}
        onTouchCancel={() => {
          swipeStart.current = null;
        }}
      >
        <h2 ref={heading} id={titleId} tabIndex={-1}>
          {title}
        </h2>
        <button
          className="button button-quiet cockpit-sheet-close"
          type="button"
          onClick={() => dialogRef.current?.close()}
        >
          {t('game:cockpit.close')}
        </button>
      </header>
      <div
        className="cockpit-sheet-body"
        onTouchStart={(event) => beginSwipe(event, event.currentTarget.scrollTop <= 0)}
        onTouchEnd={finishSwipe}
        onTouchCancel={() => {
          swipeStart.current = null;
        }}
      >
        {children}
      </div>
    </dialog>
  );
}
