# Stage 18 PWA evidence

Stage: [18 — PWA, Polish & Release](../../18-pwa-release.md), section 1. Acceptance item: "Installable PWA; offline local and bot games work in airplane mode." Date: 2026-09-30. Design decisions: [DECISIONS](../../DECISIONS.md) ("Stage 18 — the PWA").

## What ships

- `vite-plugin-pwa` 1.3 (`generateSW`, Workbox 7) in `apps/web/vite.config.ts`: `dist/sw.js`, `dist/workbox-<hash>.js`, `dist/manifest.webmanifest`, linked from `index.html`.
- Precache: 415 entries, 13.9 MiB on disk (the build reports 14,226 KiB), about 3.8 MiB gzip / 3.1 MiB brotli transferred once. Everything the build emits except `og.png` and `og-square.png`: all route and lazy chunks, the bot, audit and online workers, the Tienne and DM Mono fonts, every board, piece, seafaring and knights SVG, the icons.
- Navigation fallback to `index.html`, never for `/room/*`, `/api/*`, `/healthz`; no runtime caching routes.
- Icons: `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` from `node tools/generate-og-image.mjs --icons-only` (the existing favicons re-render byte-identically).
- Update prompt, lobby "Update now", screen wake lock and the online backgrounding warning: `apps/web/src/pwa/`.
- Replays from another version: "This replay was created with an older version of Hexfield (…)" (`apps/web/src/features/online/replay-failure.ts`).

## Browser acceptance (Chromium, production build)

`pnpm --filter @cp2p/web test:e2e:pwa` (`apps/web/playwright.pwa.config.ts`: `vite build`, then `vite preview`; one worker). Three runs, all green (the last with `--repeat-each=2`):

| Test                                                                                   | Checks                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| manifest valid, icons at their sizes, installable                                      | `/manifest.webmanifest` fields; each icon is a PNG whose IHDR size matches `sizes` (192, 512, maskable 512); `<link rel="manifest">`; CDP `Page.getInstallabilityErrors` returns no errors once the worker is ready; `Page.getAppManifest` reports no manifest errors.                                                                                                                                                        |
| offline after the first visit: reload, bot games of every module, and settings (≈17 s) | Waits for the worker to control the page and store all 415 entries, then `context.setOffline(true)`: reload shows home; four zero-pace bots play a base game until 8 rolls, a seafaring game (`new-horizons`) and a Cities & Knights game (`knights`) until 4 rolls each; Settings; a cold navigation to `/some/deep/link` serves the app shell. No page errors, console errors, failed requests or HTTP errors at any point. |
| a new version waits during a game and reloads only after the player confirms (≈15 s)   | A swappable static server serves the build, then a copy with a changed `index.html` (a new `sw.js` precache revision). The new worker reaches `waiting` mid-game: no prompt, no reload (a window marker survives) and the bots keep playing. On home the "Update available" toast appears and still nothing reloads; "Reload" activates it and the page loads the new `index.html`.                                           |

The first offline run failed: Pixi requests textures as `tile-*.svg?resolution=2.16`, which missed the precache. Fixed by ignoring the `resolution` parameter in precache matching.

## Unit tests

`apps/web/src/pwa/update-store.test.ts` (9), `wake-lock.test.ts` (6, including the backgrounding watch and route classes), `PwaNotices.test.tsx` (3: the prompt waits on local and online game routes, "Later", the online-only warning); the lobby mismatch test checks "Update now"; `online-public-archive.test.ts` covers the version message for import and open. Web suite: 150 files, 743 tests passed (`--maxWorkers=4`).

## Builds

- `pnpm build:cloudflare`: `apps/web/dist` contains `sw.js`, `workbox-9c191d2f.js`, `manifest.webmanifest`, the three icons and `_headers`; `wrangler deploy --dry-run` reads 421 asset files with no `_headers` errors.
- GitHub Pages (`GITHUB_PAGES=true vite build`): the worker registers as `/hexfield/sw.js` with scope `/hexfield/`, the manifest link is `/hexfield/manifest.webmanifest`, and `start_url`/`scope` `./` resolve to `/hexfield/`.

## Static checks

`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm deps:check` (Node 22), `pnpm i18n:check`: all pass.

## Not yet verified (after deploy, on a real phone)

The offline run is Chromium's emulated offline mode on a desktop, not airplane mode on a device. After the next deploy:

1. Android Chrome: open https://playhexfield.com, wait a minute on Wi-Fi, "Install app"; the icon uses the maskable tile. Open it standalone.
2. Airplane mode on: cold-start the installed app; start a local game against three bots, then a seafaring and a knights game; open Settings. The board art must render.
3. iOS Safari: "Add to Home Screen" (uses `apple-touch-icon.png`), then the same airplane-mode check. iOS may evict the cache after weeks without use.
4. With the phone online during a game, deploy a change: no reload mid-game; the "Update available" toast appears on the home screen.
5. Online game: background the app for a few seconds and return: the backgrounding notice appears. The screen does not dim during a game.
