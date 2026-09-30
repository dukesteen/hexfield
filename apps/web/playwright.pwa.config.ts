import { defineConfig, devices } from '@playwright/test';

/**
 * Stage 18 PWA acceptance. Service workers need a real build, so this suite builds the app and
 * serves it with `vite preview` (not the dev server the main suite uses). Chromium only.
 */
const port = Number(process.env.PLAYWRIGHT_PWA_PORT ?? 4187);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/pwa',
  testMatch: '**/*.pwa.ts',
  workers: 1,
  use: { baseURL },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list']],
  webServer: {
    command: `pnpm build && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
