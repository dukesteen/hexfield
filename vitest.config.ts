import { defineConfig } from 'vitest/config';
import { defaultClientConditions, defaultExternalConditions, defaultServerConditions } from 'vite';

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
    exclude: ['**/node_modules/**', '**/dist/**', '**/tests/**'],
    coverage: {
      provider: 'v8',
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
