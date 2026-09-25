import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { NextStep } from './GameActions';

/** Keeps the next required decision visible while secondary actions live in a sheet. */
export function NextStepBar({
  step,
  actionCount,
  hasOptional,
  onOpenActions,
  onReturnToBoard,
  onResults,
  resultsButton,
  actionsButton,
}: {
  step: NextStep | null;
  actionCount: number;
  hasOptional: boolean;
  onOpenActions: (trigger: HTMLButtonElement) => void;
  onReturnToBoard?: (() => void) | undefined;
  onResults: () => void;
  resultsButton: RefObject<HTMLButtonElement | null>;
  actionsButton: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation('game');
  return (
    <div className="next-step-bar">
      {step === null ? (
        <button
          ref={resultsButton}
          className="button button-primary next-step-primary"
          type="button"
          onClick={onResults}
        >
          {t('game:results')}
        </button>
      ) : onReturnToBoard ? (
        <button
          className="button button-quiet next-step-primary"
          type="button"
          onClick={onReturnToBoard}
        >
          {t('game:returnToBoard')}
        </button>
      ) : step.kind === 'command' ? (
        <button
          className="button button-primary next-step-primary"
          type="button"
          onClick={step.run}
        >
          {step.label}
        </button>
      ) : (
        <div
          className={`next-step-message ${step.kind === 'text' && step.tone === 'alert' ? 'action-error' : ''}`}
          role={step.kind === 'text' && step.tone === 'alert' ? 'alert' : 'status'}
        >
          <span>{step.text}</span>
          {step.kind === 'board' && step.cancel && (
            <button className="button button-quiet" type="button" onClick={step.cancel}>
              {t('game:cancelAction')}
            </button>
          )}
        </div>
      )}
      {step !== null && (
        <button
          ref={actionsButton}
          className="button button-quiet next-step-actions"
          type="button"
          aria-haspopup="dialog"
          aria-label={t('game:cockpit.actionsAvailable', { count: actionCount })}
          onClick={(event) => onOpenActions(event.currentTarget)}
        >
          <span aria-hidden="true">⋯</span>
          <span>{t('game:cockpit.actions')}</span>
          {actionCount > 0 && <b aria-hidden="true">{actionCount}</b>}
          {hasOptional && <i aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}
