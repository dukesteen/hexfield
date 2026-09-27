import type { Result, Seat } from '@cp2p/engine';
import type {
  RecoveryApprovalCandidate,
  RecoveryApprovalPreview,
  TakeoverPolicy,
} from '@cp2p/protocol';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type BotLevel = 'easy' | 'medium' | 'hard';

export function RecoveryPanel({
  policy,
  candidate,
  missing,
  takeoverAvailable,
  canInitiate,
  onEligibility,
  onApprove,
  onDecline,
  onRequest,
}: {
  policy: TakeoverPolicy;
  candidate: RecoveryApprovalCandidate | null;
  missing: readonly { seat: Seat; name: string }[];
  takeoverAvailable: boolean;
  canInitiate: boolean;
  onEligibility: (seat: Seat) => Promise<Result<void>>;
  onApprove: (
    change: RecoveryApprovalCandidate['change'],
  ) => Promise<Result<RecoveryApprovalPreview>>;
  onDecline: () => void;
  onRequest: (seat: Seat, level: BotLevel) => Promise<Result<void>>;
}) {
  const { t } = useTranslation('lobby');
  const [level, setLevel] = useState<BotLevel>('easy');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<string | null>(null);
  const [declined, setDeclined] = useState<string | null>(null);
  const [eligibility, setEligibility] = useState<{ seat: Seat; code: string | null } | null>(null);
  const eligibilityCheck = useRef(onEligibility);
  eligibilityCheck.current = onEligibility;
  const targetSeat = missing.length === 1 ? (missing[0]?.seat ?? null) : null;
  const candidateIsMissing =
    candidate !== null && missing.some((seat) => seat.seat === candidate.preview.departedSeat);
  useEffect(() => {
    if (
      !canInitiate ||
      policy.mode !== 'vote' ||
      policy.afterSeconds === 'never' ||
      candidateIsMissing ||
      targetSeat === null
    )
      return undefined;
    let active = true;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await eligibilityCheck.current(targetSeat);
        if (active)
          setEligibility({ seat: targetSeat, code: result.ok ? null : result.error.code });
      } catch {
        if (active) setEligibility({ seat: targetSeat, code: 'recovery-unavailable' });
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [canInitiate, policy.mode, policy.afterSeconds, candidateIsMissing, targetSeat]);
  if (policy.afterSeconds === 'never' || (!takeoverAvailable && !candidate) || missing.length === 0)
    return null;

  const choice =
    policy.mode === 'vote' && candidate?.preview.canApprove && candidateIsMissing
      ? candidate
      : null;
  const statement = choice?.preview.statementHash ?? null;
  const candidateName = choice
    ? (missing.find((item) => item.seat === choice.preview.departedSeat)?.name ??
      t('lobby:onlineSeatNumber', { number: choice.preview.departedSeat + 1 }))
    : null;
  const act = async (operation: () => Promise<Result<unknown>>) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (!result.ok) {
        setError(result.error.code);
        return false;
      }
      return true;
    } catch {
      setError('recovery-unavailable');
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="online-recovery-panel" aria-label={t('lobby:onlineTakeoverTitle')}>
      <strong>{t('lobby:onlineTakeoverTitle')}</strong>
      <p>
        {policy.mode === 'auto'
          ? t('lobby:onlineTakeoverAutoWaiting', { count: policy.afterSeconds })
          : t('lobby:onlineTakeoverVoteWaiting', { count: policy.afterSeconds })}
      </p>
      {policy.mode === 'auto' && <p className="muted">{t('lobby:onlineTakeoverDisclosure')}</p>}
      {choice && statement !== declined && (
        <div className="online-recovery-request">
          <p>
            {t('lobby:onlineTakeoverApproval', {
              player: candidateName,
              level: t(`lobby:onlineBotLevel_${choice.preview.botLevel}`),
            })}
          </p>
          <p className="muted">{t('lobby:onlineTakeoverDisclosure')}</p>
          {approved === statement ? (
            <p role="status">{t('lobby:onlineTakeoverApproved')}</p>
          ) : (
            <div className="dialog-actions">
              <button
                className="button button-primary"
                type="button"
                disabled={busy}
                onClick={() => {
                  void act(() => onApprove(choice.change)).then((ok) => {
                    if (ok) setApproved(statement);
                    return undefined;
                  });
                }}
              >
                {t('lobby:onlineTakeoverApprove')}
              </button>
              <button
                className="button button-quiet"
                type="button"
                disabled={busy}
                onClick={() => {
                  onDecline();
                  setDeclined(statement);
                  setApproved(null);
                }}
              >
                {t('lobby:onlineTakeoverDecline')}
              </button>
            </div>
          )}
        </div>
      )}
      {choice && statement === declined && (
        <button className="button button-quiet" type="button" onClick={() => setDeclined(null)}>
          {t('lobby:onlineTakeoverReviewAgain')}
        </button>
      )}
      {policy.mode === 'vote' && canInitiate && targetSeat !== null && !choice && (
        <div className="online-recovery-request">
          {eligibility?.seat !== targetSeat || eligibility.code !== null ? (
            <p className="muted" role="status">
              {eligibility?.code === 'recovery-quorum'
                ? t('lobby:onlineTakeoverQuorum')
                : eligibility?.code === 'recovery-offline-required'
                  ? t('lobby:onlineTakeoverWaitingMarker')
                  : eligibility?.code === 'recovery-too-early'
                    ? t('lobby:onlineTakeoverWaitingDelay')
                    : t('lobby:onlineTakeoverChecking')}
            </p>
          ) : (
            <>
              <label>
                {t('lobby:onlineTakeoverBotLevel')}
                <select
                  value={level}
                  onChange={(event) => {
                    const selected = event.target.value;
                    if (selected === 'easy' || selected === 'medium' || selected === 'hard')
                      setLevel(selected);
                  }}
                >
                  {(['easy', 'medium', 'hard'] as const).map((botLevel) => (
                    <option key={botLevel} value={botLevel}>
                      {t(`lobby:onlineBotLevel_${botLevel}`)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button button-quiet"
                type="button"
                disabled={busy}
                onClick={() => void act(() => onRequest(targetSeat, level))}
              >
                {t('lobby:onlineTakeoverRequest', {
                  player: missing.find((item) => item.seat === targetSeat)?.name,
                })}
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert">
          {error === 'recovery-too-early' || error === 'recovery-offline-required'
            ? t('lobby:onlineTakeoverTooEarly')
            : error === 'recovery-quorum'
              ? t('lobby:onlineTakeoverQuorum')
              : t('lobby:onlineTakeoverFailed')}
        </p>
      )}
    </section>
  );
}
