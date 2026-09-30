import { registerSW } from 'virtual:pwa-register';
import { pwaUpdates } from './update-store.js';

/** Installed apps can stay open for days; look for a new version this often while visible. */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

/**
 * Registers the Workbox service worker in production builds. It never reloads by itself: a
 * waiting version is reported to `pwaUpdates`, which reloads only after the player confirms.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const activate = registerSW({
    immediate: true,
    onNeedRefresh: () => pwaUpdates.needRefresh(() => activate(true)),
    // Replaces the plugin's own unconditional reload when the new worker takes control.
    onNeedReload: () => pwaUpdates.controllerChanged(),
    onOfflineReady: () => pwaUpdates.offlineReady(),
    onRegisteredSW: (_url, registration) => {
      if (!registration) return;
      // A returning visit that finds everything cached is offline-ready too.
      if (registration.active && !registration.installing) pwaUpdates.offlineReady();
      pwaUpdates.setChecker(async () => {
        await registration.update();
        return registration.installing || registration.waiting ? 'found' : 'none';
      });
      setInterval(() => {
        if (document.visibilityState === 'visible' && navigator.onLine)
          void registration.update().catch(() => undefined);
      }, UPDATE_CHECK_MS);
    },
  });
}
