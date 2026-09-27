import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useOnlineVault } from '../../queries/online-vault.js';
import { LocalVaultSettings } from './LocalVaultSettings.js';

/** Protected routes cannot mount identity or game owners until storage is unlocked. */
export function LocalVaultGate({ children, bypass }: { children: ReactNode; bypass: boolean }) {
  const { t } = useTranslation('common');
  const status = useOnlineVault();
  if (bypass || status.data?.state === 'ready') return children;
  return (
    <main className="app-page local-vault-gate">
      <LocalVaultSettings />
      <Link to="/local/new" className="text-link">
        {t('common:vault.playLocal')}
      </Link>
    </main>
  );
}
