# Port ratio labels

The fixed `2:1` and `3:1` harbor ratios now use dedicated outlined SVG glyphs
(`40 × 24` viewBox) instead of browser-rendered text. The renderer loads both
through the existing resolution-aware texture cache and scales them relative to
`hexSize`, preserving their proportions across zoom and device-pixel ratios.
Other harbor types retain their localized text labels.

Validation in the isolated `fix/port-ratio-glyphs` worktree:

- `pnpm install --frozen-lockfile` on Node 22.23.3.
- `pnpm check`: typecheck, lint, format, dependency boundaries, engine purity,
  i18n, and 317 tests passed.
- `pnpm build` and `pnpm test:coverage` passed.
- `renderer-effects.e2e.ts` passed in Chromium on port 5431, one worker.
- `GITHUB_PAGES=true pnpm --filter @cp2p/web build` passed. A local static
  preview mounted at `/hexfield/` returned HTTP 200 for the HTML, production JS
  bundle, and both ratio SVGs. The generated HTML references `/hexfield/assets/`.
- Manual Chrome inspection confirmed complete digits at board-fit scale and high zoom.

Firefox and WebKit remain for the normal Linux CI browser matrix; they were not
run locally on macOS.
