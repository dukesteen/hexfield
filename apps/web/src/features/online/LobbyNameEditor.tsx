import type { Result } from '@cp2p/engine';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const SAVE_DELAY_MS = 400;

export function LobbyNameEditor({
  name,
  editable,
  onSave,
  onPendingChange,
}: {
  name: string;
  editable: boolean;
  onSave: (name: string) => Result<void>;
  onPendingChange: (pending: boolean) => void;
}) {
  const { t } = useTranslation('lobby');
  const [draft, setDraft] = useState(name);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState(false);
  const save = useRef(onSave);
  const pendingChange = useRef(onPendingChange);
  const submitted = useRef<string | null>(null);
  save.current = onSave;
  pendingChange.current = onPendingChange;

  useEffect(() => () => pendingChange.current(false), []);

  useEffect(() => {
    if (!dirty || (draft.trim() === name && (!submitted.current || submitted.current === name))) {
      setDraft(name);
      setDirty(false);
      setError(false);
      submitted.current = null;
      pendingChange.current(false);
    }
  }, [name, dirty, draft]);

  useEffect(() => {
    if (!dirty || !editable) return undefined;
    const next = draft.trim();
    if (next === name) return undefined;
    if (next.length === 0 || next.length > 40) {
      setError(true);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      const result = save.current(next);
      submitted.current = result.ok ? next : null;
      setError(!result.ok);
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, editable, name]);

  return (
    <label>
      {t('lobby:onlineYourName')}
      <input
        maxLength={40}
        required
        disabled={!editable}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setDirty(true);
          setError(false);
          pendingChange.current(true);
        }}
      />
      {error && <small role="alert">{t('lobby:onlineActionFailed')}</small>}
      {dirty && !error && editable && <small role="status">{t('lobby:onlineSaving')}</small>}
    </label>
  );
}
