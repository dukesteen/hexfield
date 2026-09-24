import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { APP_NAME, APP_VERSION } from '../config';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  const { t } = useTranslation('common');
  return (
    <main>
      <h1>{t('common:appTitle', { defaultValue: APP_NAME })}</h1>
      <p>{t('common:welcome')}</p>
      <small>v{APP_VERSION}</small>
    </main>
  );
}
