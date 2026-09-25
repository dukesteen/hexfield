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

The first hosted run, [36179964504](https://github.com/dukesteen/hexfield/actions/runs/36179964504),
passed build, unit, coverage and simulation checks. Browser tests reported 50
passes and 69 intentional skips, then the twenty-game test tried to read a board
coordinate before asynchronous renderer initialization completed. The placement
helper now waits for the board canvas's ready state before reading coordinates.
It still checks that the target is visible and unobscured before clicking.
`pnpm check` passes after that test correction. The [twenty-game rerun](ui-full20-port-ratios.json)
completed 13,089 inputs across 2,710 turns with zero rejected actions or browser
errors in 15.7 minutes. Source fingerprint
`2aed12e815f05c4ce74f460f4a1854cb1d494b6ee83cf241b41ad1694578f744`
was unchanged throughout the run.

The replacement hosted run, [36181649939](https://github.com/dukesteen/hexfield/actions/runs/36181649939),
passed 50 browser tests with 69 intentional skips. Its twenty-game test completed
18 games without rejected inputs before reaching the 30-minute test timeout.
The same commit, `2dbaefb8fd134b18377df45f7af50b36f308620b`, completed all twenty
games locally as recorded above. Deployment was therefore dispatched with the
user-authorized `skip_e2e` option in
[36186003280](https://github.com/dukesteen/hexfield/actions/runs/36186003280).
That run passed and deployed to GitHub Pages. Both published ratio SVGs returned
HTTP 200 and matched the checked-in assets byte for byte. Manual Chrome inspection
of a new local game on the live site confirmed that the complete `2:1` and `3:1`
labels are visible. The working tree gives the hosted twenty-game test a one-hour
timeout; the game count and assertions are unchanged.
