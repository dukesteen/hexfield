import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { getFactionUrl, getGameArtUrl, getPieceIconUrl } from '@cp2p/renderer';
import type { NextStep } from './GameActions';

export type MobileTab = 'build' | 'trade' | 'players' | 'log';

export function MobileGameControls({
  step,
  hasOptional,
  playerColor,
  onOpenTab,
  onReturnToBoard,
  onResults,
  resultsButton,
  actionsButton,
}: {
  step: NextStep | null;
  hasOptional: boolean;
  playerColor: string;
  onOpenTab: (tab: MobileTab, trigger: HTMLButtonElement) => void;
  onReturnToBoard?: () => void;
  onResults: () => void;
  resultsButton: RefObject<HTMLButtonElement | null>;
  actionsButton: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation('game');
  const tabs = [
    {
      kind: 'build',
      label: t('game:buildPanel'),
      icon: getPieceIconUrl('settlement', playerColor),
    },
    { kind: 'trade', label: t('game:tradePanel'), icon: getGameArtUrl('bankTrade') },
    { kind: 'players', label: t('game:players'), icon: getFactionUrl(playerColor) },
    { kind: 'log', label: t('game:mobileLog'), icon: getGameArtUrl('cardBack') },
  ] as const;
  const busy = step?.kind === 'pending';
  const showInstruction = step && step.kind !== 'command' && step.kind !== 'pending';
  return (
    <>
      {showInstruction && (
        <div
          className={`mobile-next-step ${step.kind === 'text' && step.tone === 'alert' ? 'action-error' : ''}`}
          role={step.kind === 'text' && step.tone === 'alert' ? 'alert' : 'status'}
          aria-live="polite"
        >
          <span>{step.text}</span>
          {step.kind === 'board' && step.cancel && (
            <button className="button button-quiet" type="button" onClick={step.cancel}>
              {t('game:cancelAction')}
            </button>
          )}
        </div>
      )}
      <div className="mobile-control-row" aria-busy={busy}>
        <nav className="mobile-tabs" aria-label={t('game:actions')}>
          {tabs.map((tab) => (
            <button
              key={tab.kind}
              ref={tab.kind === 'build' ? actionsButton : undefined}
              className="mobile-tab"
              type="button"
              disabled={busy || (step === null && (tab.kind === 'build' || tab.kind === 'trade'))}
              aria-haspopup="dialog"
              aria-label={tab.label}
              onClick={(event) => onOpenTab(tab.kind, event.currentTarget)}
            >
              <img src={tab.icon} alt="" aria-hidden="true" />
              <span>{tab.label}</span>
              {tab.kind === 'build' && hasOptional && <i aria-hidden="true" />}
            </button>
          ))}
        </nav>
        <div className="mobile-step">
          {step === null ? (
            <button
              ref={resultsButton}
              className="button button-primary mobile-turn-button"
              type="button"
              onClick={onResults}
            >
              {t('game:results')}
            </button>
          ) : step.kind === 'pending' ? (
            <button
              className={`button button-primary mobile-turn-button ${step.turnAction?.rollDice ? 'action-roll-dice' : ''}`}
              type="button"
              aria-label={step.text}
              disabled
            >
              {step.turnAction?.label}
              <span className="mobile-turn-spinner action-spinner" aria-hidden="true" />
            </button>
          ) : onReturnToBoard ? (
            <button
              className="button button-primary mobile-turn-button"
              type="button"
              onClick={onReturnToBoard}
            >
              {t('game:returnToBoard')}
            </button>
          ) : step.kind === 'command' ? (
            <button
              className={`button button-primary mobile-turn-button ${step.rollDice ? 'action-roll-dice' : ''}`}
              type="button"
              onClick={step.run}
            >
              {step.label}
            </button>
          ) : (
            <button
              className="button button-primary mobile-turn-button"
              type="button"
              onClick={(event) => onOpenTab('build', event.currentTarget)}
            >
              {t('game:cockpit.actions')}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
