import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
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

const APP_COLOUR = '#29252a';

/**
 * Stage 18 PWA: a Workbox service worker precaches every built file that local, hotseat and
 * bot games need (all lazy chunks, workers, fonts and art), so the app works offline. Share
 * images are the only exclusions. Signaling paths are never served from the cache.
 */
const pwa = VitePWA({
  registerType: 'prompt',
  // src/pwa/register.ts registers it; the plugin's injected script would need a CSP change.
  injectRegister: false,
  manifestFilename: 'manifest.webmanifest',
  // The png glob below already lists the icons; the plugin adds the manifest itself.
  includeManifestIcons: false,
  manifest: {
    id: './',
    name: 'Hexfield',
    short_name: 'Hexfield',
    description:
      'Play the island trading game with friends, in your browser and peer to peer. Local and bot games work offline.',
    lang: 'en',
    // Relative to the manifest, so the apex deploy and the Pages `/hexfield/` base both work.
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'any',
    theme_color: APP_COLOUR,
    background_color: APP_COLOUR,
    categories: ['games', 'entertainment'],
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg,png,ttf,woff2,json}'],
    // Link-preview images are for crawlers, not the app.
    globIgnores: ['og.png', 'og-square.png'],
    // The largest single file is the pre-rendered board preview (~1.8 MB).
    maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
    navigateFallback: 'index.html',
    navigateFallbackDenylist: [/^\/(?:room|api)(?:\/|$)/, /^\/healthz$/],
    cleanupOutdatedCaches: true,
    // The first install controls the open page at once; updates still wait for the player.
    clientsClaim: true,
    skipWaiting: false,
  },
});

export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? '/hexfield/' : '/',
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), pwa],
  resolve: { conditions: ['@cp2p/source', ...defaultClientConditions], alias: workspaceAliases },
  server: {
    host: '127.0.0.1',
    port: 5187,
    strictPort: true,
    watch: {
      ignored: ['**/playwright-report/**', '**/test-results/**'],
      ...(process.env.CHOKIDAR_USEPOLLING === 'true'
        ? { usePolling: true, useFsEvents: false, interval: 250 }
        : {}),
    },
  },
});
