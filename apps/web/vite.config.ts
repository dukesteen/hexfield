import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const workspacePackages = [
  'engine',
  'codec',
  'crypto',
  'protocol',
  'p2p',
  'storage',
  'renderer',
  'bots',
  'maps',
];
const workspaceAliases = Object.fromEntries(
  workspacePackages.map((name) => [
    `@cp2p/${name}`,
    fileURLToPath(new URL(`../../packages/${name}/src`, import.meta.url)),
  ]),
);

export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? '/hexfield/' : '/',
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react()],
  resolve: { conditions: ['@cp2p/source', ...defaultClientConditions], alias: workspaceAliases },
  server: {
    host: '127.0.0.1',
    port: 5187,
    strictPort: true,
    watch: { ignored: ['**/playwright-report/**', '**/test-results/**'] },
  },
});
