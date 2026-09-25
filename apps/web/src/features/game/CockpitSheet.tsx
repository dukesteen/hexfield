import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

export function CockpitSheet({
  title,
  dialogRef,
  onClosed,
  children,
}: {
  title: string;
  dialogRef: RefObject<HTMLDialogElement | null>;
  onClosed: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation('game');
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
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
      <header className="cockpit-sheet-header">
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
      <div className="cockpit-sheet-body">{children}</div>
    </dialog>
  );
}
