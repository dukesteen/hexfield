# First Pages release

The local-play app is published at [dukesteen.github.io/hexfield](https://dukesteen.github.io/hexfield/) from [source f9b7559](https://github.com/dukesteen/hexfield/commit/f9b75595021c8e6490a7b1e2aa6a22a159490f70).

The [manual release workflow](https://github.com/dukesteen/hexfield/actions/runs/36163848524) passed on 2026-09-25. The user requested `skip_e2e=true` because the hosted browser run was slow. Repository checks, all 317 unit/component tests, builds, coverage, simulation, and Pages deployment passed. Browser installation and hosted E2E were the only skipped checks. The earlier hosted run was cancelled rather than recorded as passing.

Before publication, the release changes passed ten focused board/keyboard tests, two mobile player-sheet/privacy tests, a complete phone game against three bots, and the landscape Game info touch regression. The [physical Pixel 7 check](physical-phone-performance.md) recorded approximately 90 renderer frames per second while panning.

The complete local browser suite subsequently passed on the same application and test source: 51 tests passed, 69 browser-specific cases were intentionally skipped, and none failed. It ran Chromium, Firefox and WebKit in 18.9 minutes. The [twenty visible-control games](ui-full20-release.json) all reached the default ten-point target, spanning 2,303 turns and 11,083 inputs with zero rejected actions or browser errors. That acceptance test uses Chromium; shared smoke, replay and other browser checks also cover Firefox and WebKit. The complete human-versus-three-bots phone game passed in the same run.

The run started at `7b9266b`. The published commit `f9b7559` only added README instructions, so its application and test source are identical. The source fingerprint was `5e88158fbd25f96b9acefddc85a3bd78ce732ea7e6914483236f9a9cb3f94459` before and after the run. The coordinator independently recomputed that fingerprint and checked all twenty game summaries and totals.

Command, with Node 22.23.3 and pnpm 10.7.1:

```sh
CI=1 CI_BROWSER_SET=all PLAYWRIGHT_TEST_PORT=5441 \
  PLAYWRIGHT_BROWSERS_PATH=/private/tmp/hexfield-playwright \
  PLAYWRIGHT_HTML_REPORT=/private/tmp/hexfield-full-browser-report \
  pnpm --filter @cp2p/web exec playwright test \
  --output=/private/tmp/hexfield-full-browser-results
```

The published site returned HTTP 200. Production browser checks opened the home page, reloaded setup and saved-game URLs, created and restored a game, rendered the board and artwork, and confirmed that development hooks and routes were unavailable. No failed asset requests or browser errors occurred. A separate 844×390 touch check verified the expanded 300px Game info panel, Event log expansion, closing the panel, and the single-human hand without a hide control. The coordinator inspected the published landscape screenshot and opened the live home page in Chrome.

## Milestone acceptance audit

The final read-only audit checked the acceptance criteria in stages 01–05 against source, tests and recorded results. Both milestones meet their criteria. Stages 01–04 now show the completed checklists already supported by [STATUS.md](../../STATUS.md).

| Stage                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01, repository foundation | Clean-clone installation and local CI passed. Negative fixtures reject forbidden engine imports and globals. The release also has a successful GitHub Actions run.                                                                                                                                                                                                                                                                                                                           |
| 02, engine core           | Geometry cross-checks, 10,000 bounds-property sequences, counter-module completion and immutability tests pass. The engine has no runtime dependencies and passes the purity and boundary checks.                                                                                                                                                                                                                                                                                            |
| 03, base rules            | The rule-to-test map resolves the rule questions. A four-seat game reaches ten points through `LocalGame` and replays deterministically. Coverage exceeds the enforced 90% line and 85% branch thresholds.                                                                                                                                                                                                                                                                                   |
| 04, simulation            | [100,000 four-player games](../stage04/games-100k-4p-seed42-acceptance.json) and [10,000 three-player games](../stage04/games-10k-3p-seed42-acceptance.json) finish with invariant checks and no failures. [One million fuzz mutations](../stage04/fuzz-1m-seed42-acceptance.json) pass. The twenty golden replays pass. The combined dice-distribution p-value is 0.1752. The [current-source benchmark](bench-1000-seed42-cockpit.json) measures 28.32 ms per game and 0.037 ms apply p99. |
| 05, local play            | Complete desktop and touch-phone games, three-human privacy handoffs, legal-action checks, keyboard controls, translations, persistence and state ownership pass. The [physical Pixel 7 check](physical-phone-performance.md) meets the 60 FPS criterion. Production checks confirm the published local game works.                                                                                                                                                                          |

The earlier stage reviews and their fixes are recorded in `STATUS.md` and `DECISIONS.md`. The phone measurement used source `ce6bdd1`; subsequent application changes only corrected short-landscape panel layout. They did not change the renderer or portrait layout. P2P networking starts at Milestone C and is outside these two milestones.
