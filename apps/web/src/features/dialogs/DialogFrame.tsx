import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

interface DialogFrameProps {
  title: string;
  children: ReactNode;
  onCancel?: (() => void) | undefined;
}

/** Native modal supplies focus containment; Escape invokes the optional cancel action. */
export function DialogFrame({ title, children, onCancel }: DialogFrameProps) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.open = true;
    dialog.querySelector<HTMLElement>('input, select, button')?.focus();
    return () => {
      if (dialog.open) dialog.close?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel?.();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel?.();
        }
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}
