import { createHashHistory, createRouter } from '@tanstack/react-router';
import { queryClient } from './queryClient';
import { routeTree } from './routeTree.gen';

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  context: { queryClient },
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
