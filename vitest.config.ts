import { defineConfig } from 'vitest/config';

export default defineConfig({
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
      exclude: ['**/*.test.ts', 'apps/web/src/routeTree.gen.ts'],
      thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 },
    },
  },
});
