# 18 — PWA, Polish & Release

## Goal

Ship it: an installable offline-capable PWA with polished UX, accessibility, performance budgets, security hardening, deployment of the static app and the optional signaling service, and a release process.

## Prerequisites

All previous stages (or at least M-D plus the modules chosen for 1.0).

## 1. PWA

- `vite-plugin-pwa` (Workbox): precache the app shell and assets. The app works fully offline for local/hotseat/bot games and for replays/the map editor.
- Web app manifest: name from `APP_NAME`, icons (generate an original icon set with `claude -p` following the style guide; export PNG sizes 192/512 plus maskable), theme colours, `display: standalone`, orientation `any`.
- **Update flow**: detect a new service worker → show "Update available" → reload on confirm. **Never auto-reload during an active game.** Because P2P games require identical engine versions (stage 09), show a clear notice in the lobby if the peers differ, with an "Update now" action.
- **Keep old engine versions?** Out of scope for 1.0. Record the idea (bundle previous engine versions for replay viewing of old games) in DECISIONS.md. For now, replays from older engine versions show "created with an older version" and are viewable only if the hashes still match.
- Screen wake lock during games (`navigator.wakeLock`) to reduce mobile disconnects. Handle `visibilitychange`: warn the user that backgrounding the tab may disconnect them.

## 2. Polish

- **Audio**: original sound effects (dice, build, trade, turn notification, win) plus optional music. Generate or source from CC0 libraries only, and record the licences in `assets/LICENSES.md`. Volume settings; muted by default on first load until the user interacts.
- **Notifications**: a "your turn" tab title flash + sound; optional Notification API when the tab is hidden (permission requested only on an explicit opt-in).
- **Animations**: a review pass for consistency and timing. Respect `prefers-reduced-motion`.
- **Onboarding**: an interactive "How to play" tutorial using a scripted `LocalSession` scenario (reusing the scenario builder from stage 03 tests). A rules reference per module written in original wording (it can be generated from `docs/rules/*.md` and then edited for tone).
- **UI polish pass**: use `claude -p` for design review and refinements of key screens (home, lobby, game HUD, trade, game over), keeping the style guide consistent.
- **i18n** (react-i18next): verify every string is extracted (the CI key check from stage 05); ship English first. Add a Dutch translation (`locales/nl/*.json`) as the second locale to validate the pipeline: plurals, `Intl` number formatting via i18next's formatter, language detection (`i18next-browser-languagedetector`), and a language picker in settings.

## 3. Accessibility (WCAG 2.2 AA target)

- Full keyboard play (already required); visible focus.
- Screen-reader announcements for game events (an ARIA live region fed from the event log formatter).
- A board "list mode": an accessible alternative listing hexes/vertices/edges with legal actions for screen-reader users.
- Colour contrast checks; colour-blind player palettes with patterns; scalable UI text.
- Automated axe checks in Playwright for the main screens.

## 4. Performance budgets

| Metric                      | Budget                                       |
| --------------------------- | -------------------------------------------- |
| Initial JS (gzip) for home  | ≤ 250 KB (lazy-load Pixi, crypto and editor) |
| LCP on mid-range mobile, 4G | ≤ 2.5 s                                      |
| Board FPS during pan        | ≥ 55 fps mid-range phone                     |
| Memory in a 6-player game   | ≤ 250 MB                                     |
| Resume after refresh        | ≤ 3 s                                        |

Add Lighthouse CI to the pipeline with these budgets.

## 5. Security hardening

- A strict CSP: `default-src 'self'`; `connect-src 'self' <signaling origin> <TURN-credential origin>`; no inline scripts; `worker-src 'self' blob:`; `img-src 'self' data: blob:`.
- All peer input is validated with Valibot (verify coverage: every message type has a schema, with a test that enumerates the message union).
- Rate limits per peer on every message type; disconnect abusive peers.
- Chat: text only, rendered as text (never HTML); length limits; basic profanity filter optional.
- A dependency audit in CI (`pnpm audit` or equivalent) and a lockfile policy.
- Security review checklist in `docs/ops/security-review.md`:
  - identity binding,
  - signature domain separation,
  - no secrets in logs,
  - no secrets sent to spectators,
  - escrow thresholds,
  - audit coverage.

  Run a Claude Code `/security-review`-style pass (or the equivalent) before 1.0.

## 6. Deployment

- **Static app**: build to `apps/web/dist` and deploy to a static host (Cloudflare Pages or GitHub Pages). Add a GitHub Action on tag `v*` that builds and deploys. Deploy previews per PR if the host supports it.
- **Signaling**: deploy the Cloudflare Worker/Durable Object via `wrangler` in CI; Docker image for the Node version published to GHCR. Document the configuration in `docs/ops/signaling.md`.
- **TURN**: documented, not provided by default (`docs/ops/turn.md` from stage 08).
- **Versioning**: semver for the app. `protocolVersion` and `engineVersion` bumps are called out in release notes.
- A privacy statement: no accounts, no game servers; the signaling server sees IP addresses and room ids only; TURN (if configured) relays encrypted traffic.

## 7. Release checklist (`docs/ops/release.md`)

- All acceptance criteria in STATUS.md ticked for the included stages.
- Full simulation (100k base, 20k per module/scenario), fuzz (1M), chaos suites (1k seeds each) green on the release commit.
- Playwright cross-browser suite green, including the 6-browser P2P game.
- Manual device matrix: iOS Safari, Android Chrome, desktop Chrome/Firefox/Safari; home Wi-Fi ↔ mobile hotspot; one relay-only (TURN) test.
- Lighthouse budgets met; axe checks pass.
- No trademarked names or official assets anywhere (grep for a banned-terms list in CI: the official game/expansion names, the colonist.io brand).
- Changelog written; tag pushed; deploys verified.

## Acceptance criteria

- [ ] Installable PWA; offline local and bot games work in airplane mode.
- [ ] Performance budgets and accessibility checks pass in CI.
- [ ] Automated deploys for the app and the signaling service.
- [ ] The release checklist is completed for v1.0.0.
