import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Seat } from '@cp2p/engine';
import type { SessionFairness } from '@cp2p/protocol';
import type { GamePresentation } from '../../queries/repositories/saved-games.js';
import { useSessionStore } from '../../store/session-store.js';
import './fairness-status.css';

const proofLabels = {
  'command-proof': 'game:fairnessProofCommand',
  'beacon-reveal': 'game:fairnessProofRandomness',
  'deck-pass': 'game:fairnessProofShuffle',
  'deck-unlock': 'game:fairnessProofCard',
  'count-proof': 'game:fairnessProofCount',
  'steal-contribution': 'game:fairnessProofSteal',
  'bad-steal-delivery': 'game:fairnessProofDelivery',
  'false-steal-dispute': 'game:fairnessProofDispute',
} as const satisfies Record<SessionFairness['findings'][number]['kind'], string>;

export function CheatFlag({ seat }: { seat: Seat }) {
  const { t } = useTranslation('game');
  const flagged = useSessionStore((store) =>
    store.fairness?.findings.some((finding) => finding.seat === seat),
  );
  return flagged ? <small className="fairness-flag">{t('game:cheatingDetected')}</small> : null;
}

/** Findings are already verified and certified; untrusted peer accusations never enter here. */
export function FairnessFindings({ presentation }: { presentation: GamePresentation }) {
  const { t } = useTranslation('game');
  const findings = useSessionStore((store) => store.fairness?.findings);
  if (!findings?.length) return null;
  return (
    <section className="fairness-findings" aria-label={t('game:fairnessFindings')}>
      <h3>{t('game:fairnessFindings')}</h3>
      <ul>
        {findings.map((finding) => (
          <li key={finding.evidenceId}>
            <span>
              {t('game:fairnessInvalidProof', {
                player:
                  presentation.players.find((player) => player.seat === finding.seat)?.name ??
                  t('game:playerFallback', { number: finding.seat + 1 }),
                proof: t(proofLabels[finding.kind]),
              })}
            </span>
            <small>{t('game:fairnessEvidenceRecord', { seq: finding.at.seq })}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function FairnessStatus({ presentation }: { presentation: GamePresentation }) {
  const { t } = useTranslation('game');
  const fairness = useSessionStore((store) => store.fairness);
  const available = fairness !== null;
  const status = useSessionStore((store) => store.status);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
    return () => {
      if (element.open) element.close();
    };
  }, [open, available]);
  if (!fairness) return null;
  const flagged = fairness.findings.length > 0;
  const label = flagged
    ? t('game:fairnessProblems', { count: fairness.findings.length })
    : t('game:fairnessMoves', { count: fairness.verifiedMoves });
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`button button-quiet fairness-status ${flagged ? 'has-findings' : ''}`}
        aria-label={t('game:fairnessOpen', { status: label })}
        aria-haspopup="dialog"
        title={label}
        onClick={() => setOpen(true)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M12 3 4 6v6c0 4 4 7 8 9 4-2 8-5 8-9V6Z" />
          {flagged ? <path d="M12 7v6m0 3v1" /> : <path d="m8 12 3 3 5-6" />}
        </svg>
        <span>{label}</span>
      </button>
      {flagged && (
        <span className="fairness-announcement" role="status">
          {label}
        </span>
      )}
      <dialog
        ref={dialog}
        className="app-dialog fairness-dialog"
        aria-labelledby="fairness-title"
        onCancel={() => setOpen(false)}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
      >
        <header className="section-heading">
          <h2 id="fairness-title">{t('game:fairnessTitle')}</h2>
          <button className="button button-quiet" type="button" onClick={() => setOpen(false)}>
            {t('game:fairnessClose')}
          </button>
        </header>
        <p className="fairness-count">
          {t('game:fairnessMoves', { count: fairness.verifiedMoves })}
        </p>
        <p>{t('game:fairnessExplanation')}</p>
        <p className="muted">{t('game:fairnessAuditExplanation')}</p>
        {status?.kind === 'error' && <p role="alert">{t('game:fairnessStopped')}</p>}
        {flagged ? (
          <>
            <p className="fairness-warning">{t('game:fairnessRejected')}</p>
            <FairnessFindings presentation={presentation} />
          </>
        ) : (
          <p>{t('game:fairnessNoFindings')}</p>
        )}
      </dialog>
    </>
  );
}
