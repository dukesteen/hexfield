import { useTranslation } from 'react-i18next';

/** Short, nonblocking status while an online command is checked in the protocol worker. */
export function ValidationChecking({ checking }: { checking: boolean }) {
  const { t } = useTranslation('rules');
  return checking ? <p role="status">{t('rules:validation.checking')}</p> : null;
}
