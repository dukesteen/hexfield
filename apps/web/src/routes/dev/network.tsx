import { createFileRoute, notFound } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

const NetworkSimulation = import.meta.env.DEV
  ? lazy(() => import('../../features/devtools/NetworkSimulation.js'))
  : () => null;

export const Route = createFileRoute('/dev/network')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: import.meta.env.DEV ? NetworkSimulationRoute : () => null,
});

function NetworkSimulationRoute() {
  return (
    <Suspense fallback={<main className="app-page">Loading network simulation…</main>}>
      <NetworkSimulation />
    </Suspense>
  );
}
