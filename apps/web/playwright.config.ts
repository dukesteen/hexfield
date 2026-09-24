import { defineConfig, devices } from '@playwright/test';

const allBrowsers = process.env.CI_BROWSER_SET !== 'chromium';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  use: { baseURL: 'http://127.0.0.1:5187' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(allBrowsers
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5187',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
