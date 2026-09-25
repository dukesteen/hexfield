import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';
import { useRouterState } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../queries/hooks';

function ThemePreference() {
  const { data } = useSettings();
  useEffect(() => {
    document.documentElement.dataset.theme = data?.theme ?? 'system';
    document.documentElement.dataset.motion = data?.reducedMotion ?? 'system';
  }, [data?.theme, data?.reducedMotion]);
  return null;
}

function RouteMessage({ kind }: { kind: 'missing' | 'error' }) {
  const { t } = useTranslation('common');
  return (
    <main className="app-page message-page">
      <h1>{t(kind === 'missing' ? 'common:pageMissing' : 'common:pageError')}</h1>
      <Link to="/" className="button button-primary">
        {t('common:backHome')}
      </Link>
    </main>
  );
}

function RootContent() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const localGame = path.startsWith('/local/');
  return (
    <>
      <ThemePreference />
      <Outlet />
      {import.meta.env.DEV && !localGame && (
        <>
          <TanStackRouterDevtools />
          <ReactQueryDevtools initialIsOpen={false} />
        </>
      )}
    </>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootContent,
  notFoundComponent: () => <RouteMessage kind="missing" />,
  errorComponent: () => <RouteMessage kind="error" />,
});
