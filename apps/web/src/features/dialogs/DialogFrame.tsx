import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
} from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export const ActionPendingContext = createContext(false);

interface DialogFrameProps {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onCancel?: (() => void) | undefined;
  variant?: 'trade';
  className?: string;
}

/** Native modal supplies focus containment; Escape invokes the optional cancel action. */
export function DialogFrame({
  title,
  children,
  footer,
  onCancel,
  variant,
  className,
}: DialogFrameProps) {
  const { t } = useTranslation('game');
  const pending = useContext(ActionPendingContext);
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.open = true;
    titleRef.current?.focus({ preventScroll: true });
    dialog.scrollTop = 0;
    return () => {
      if (dialog.open) dialog.close?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={
        [variant === 'trade' ? 'trade-dialog' : '', className].filter(Boolean).join(' ') ||
        undefined
      }
      aria-labelledby={titleId}
      aria-busy={pending}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel?.();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (!pending) onCancel?.();
        }
      }}
    >
      <h2 ref={titleRef} id={titleId} tabIndex={-1}>
        {title}
      </h2>
      {pending && (
        <p className="action-pending" role="status">
          <span className="action-spinner" aria-hidden="true" />
          {t('game:submittingAction')}
        </p>
      )}
      {variant === 'trade' ? (
        <div className="trade-dialog-body" inert={pending}>
          {children}
        </div>
      ) : (
        <div className="action-dialog-body" inert={pending}>
          {children}
        </div>
      )}
      {isValidElement<{ inert?: boolean }>(footer)
        ? cloneElement(footer, { inert: pending })
        : footer}
    </dialog>
  );
}
