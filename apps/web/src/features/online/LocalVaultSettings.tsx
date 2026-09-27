import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { VaultError } from '@cp2p/storage';
import { useChangeOnlineVault, useOnlineVault } from '../../queries/online-vault.js';
import type { VaultCommand } from '../../queries/online-vault.js';
import './local-vault.css';

function errorKey(error: unknown) {
  if (error instanceof VaultError) {
    switch (error.code) {
      case 'invalid-key':
        return 'common:vault.wrongPassphrase';
      case 'busy':
        return 'common:vault.otherTab';
      case 'weak-passphrase':
        return 'common:vault.passphraseLength';
      case 'unsupported':
        return 'common:vault.unsupported';
      case 'corrupt':
      case 'identity-missing':
      case 'identity-mismatch':
        return 'common:vault.damaged';
      case 'changed':
      case 'closed':
      case 'locked':
      case 'stale-generation':
        return 'common:vault.failed';
    }
  }
  return 'common:vault.failed';
}

export function LocalVaultSettings() {
  const { t } = useTranslation('common');
  const status = useOnlineVault();
  const operation = useChangeOnlineVault();
  const [editing, setEditing] = useState<'change' | 'disable' | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [nextPassphrase, setNextPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const snapshot = status.data;
  const busy = operation.isPending || snapshot?.state === 'busy';
  const locked = snapshot?.mode === 'locked' && snapshot.state !== 'ready';
  const action = snapshot?.mode === 'clear' ? 'enable' : locked ? 'unlock' : editing;
  const choosing = action === 'enable' || action === 'change';

  const run = async (command: VaultCommand) => {
    setPassphrase('');
    setNextPassphrase('');
    setConfirmation('');
    setMismatch(false);
    try {
      await operation.run(command);
      setEditing(null);
    } catch {
      // The mutation retains only the typed failure, never the passphrase.
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!action || busy) return;
    const chosen = action === 'change' ? nextPassphrase : passphrase;
    if (choosing && chosen !== confirmation) {
      setMismatch(true);
      return;
    }
    void run(
      action === 'change'
        ? { kind: 'change', passphrase, nextPassphrase }
        : { kind: action, passphrase },
    );
  };
  const label =
    action === 'enable'
      ? t('common:vault.enable')
      : action === 'change'
        ? t('common:vault.change')
        : action === 'disable'
          ? t('common:vault.disable')
          : t('common:vault.unlock');
  return (
    <section className="local-vault settings-form" aria-labelledby="local-vault-title">
      <h2 id="local-vault-title">{t('common:vault.title')}</h2>
      <p className="muted">{t('common:vault.description')}</p>
      {status.isPending && <p role="status">{t('common:vault.loading')}</p>}
      {(status.isError || snapshot?.state === 'error') && (
        <p role="alert">{t('common:vault.failed')}</p>
      )}
      {snapshot && snapshot.state !== 'loading' && snapshot.state !== 'error' && (
        <>
          <p className="local-vault-status">
            {snapshot.mode === 'clear'
              ? t('common:vault.off')
              : locked
                ? t('common:vault.locked')
                : t('common:vault.unlocked')}
          </p>
          {action ? (
            <form onSubmit={submit}>
              {choosing && <p>{t('common:vault.keepPassphrase')}</p>}
              {action === 'disable' && <p>{t('common:vault.disableHint')}</p>}
              <label htmlFor="vault-passphrase">
                {action === 'enable'
                  ? t('common:vault.newPassphrase')
                  : t('common:vault.passphrase')}
              </label>
              <input
                id="vault-passphrase"
                type="password"
                autoComplete={action === 'enable' ? 'new-password' : 'current-password'}
                minLength={12}
                maxLength={1024}
                required
                disabled={busy}
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
              {action === 'change' && (
                <>
                  <label htmlFor="vault-next-passphrase">{t('common:vault.newPassphrase')}</label>
                  <input
                    id="vault-next-passphrase"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={1024}
                    required
                    disabled={busy}
                    value={nextPassphrase}
                    onChange={(event) => setNextPassphrase(event.target.value)}
                  />
                </>
              )}
              {choosing && (
                <>
                  <label htmlFor="vault-confirmation">{t('common:vault.confirmPassphrase')}</label>
                  <input
                    id="vault-confirmation"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={1024}
                    required
                    disabled={busy}
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </>
              )}
              {mismatch && <p role="alert">{t('common:vault.mismatch')}</p>}
              <div className="local-vault-actions">
                <button className="button button-primary" type="submit" disabled={busy}>
                  {label}
                </button>
                {editing && (
                  <button
                    className="button button-quiet"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditing(null);
                      setPassphrase('');
                      setNextPassphrase('');
                      setConfirmation('');
                      setMismatch(false);
                    }}
                  >
                    {t('common:vault.cancel')}
                  </button>
                )}
              </div>
            </form>
          ) : (
            <div className="local-vault-actions">
              <button
                className="button button-primary"
                type="button"
                disabled={busy}
                onClick={() => void run({ kind: 'lock' })}
              >
                {t('common:vault.lock')}
              </button>
              <button
                className="button button-quiet"
                type="button"
                disabled={busy}
                onClick={() => setEditing('change')}
              >
                {t('common:vault.change')}
              </button>
              <button
                className="button button-quiet"
                type="button"
                disabled={busy}
                onClick={() => setEditing('disable')}
              >
                {t('common:vault.disable')}
              </button>
            </div>
          )}
        </>
      )}
      {busy && <p role="status">{t('common:vault.working')}</p>}
      {operation.error && <p role="alert">{t(errorKey(operation.error))}</p>}
    </section>
  );
}
