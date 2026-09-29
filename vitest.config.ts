import { defineConfig } from 'vitest/config';
import { defaultClientConditions, defaultExternalConditions, defaultServerConditions } from 'vite';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { conditions: ['@cp2p/source', ...defaultClientConditions] },
  ssr: {
    resolve: {
      conditions: ['@cp2p/source', ...defaultServerConditions],
      externalConditions: ['@cp2p/source', ...defaultExternalConditions],
    },
  },
  test: {
    environment: 'node',
    // Concurrent curve-proof replicas otherwise compete for CPU and hit their
    // wall-clock deadlines. Preserve the deadlines and bound worker contention.
    maxWorkers: process.env.CI
      ? 1
      : Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
    exclude: ['**/node_modules/**', '**/dist/**', '**/tests/**'],
    // Yields to the event loop between tests, so long synchronous files cannot starve Vitest's RPC.
    setupFiles: [fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))],
    coverage: {
      provider: 'v8',
      // CI runs the full suite uninstrumented and applies its coverage gate to engine tests only.
      reporter: ['text', 'html', 'lcov'],
      include: [
        'packages/*/src/**/*.{ts,tsx}',
        'apps/*/src/**/*.{ts,tsx}',
        'tools/sim/src/**/*.ts',
      ],
      exclude: [
        '**/*.{test,spec}.{ts,tsx}',
        '**/{__tests__,test,tests}/**',
        'apps/web/src/routeTree.gen.ts',
      ],
      thresholds: {
        lines: 0,
        branches: 0,
        functions: 0,
        statements: 0,
        'packages/engine/src/**': { lines: 90, branches: 85 },
      },
    },
  },
});
