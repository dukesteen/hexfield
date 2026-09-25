# Status

Check each item only after its acceptance evidence is recorded. Stage 01 uses the user-authorized local CI equivalent.

## 01 — Repository Foundation

Source: [01-repo-foundation.md](01-repo-foundation.md)

- [x] `pnpm install && pnpm check && pnpm build` passes on a clean clone.
- [x] `pnpm dev` serves the placeholder page. The Playwright smoke test passes in Chromium, Firefox and WebKit.
- [x] Adding `import 'react'` to the engine fails `pnpm deps:check`.
- [x] Using `Math.random()` or `document` in the engine fails `pnpm check`.
- [x] CI runs green on GitHub Actions, or the same checks pass locally under the user-authorized local verification path in `README.md`.
- [x] `docs/STATUS.md` and `docs/DECISIONS.md` exist.

Verified 2026-09-24 from a fresh local clone of commit `ec4f04f`, with no installed dependencies or build outputs copied from the workspace. Node `22.23.3`, pnpm `10.7.1`. `pnpm install --frozen-lockfile --offline` and `CI=1 pnpm run ci` passed. The CI script ran production and test typechecks, the engine ambient-global guard, lint with warnings denied, format verification, seven dependency-boundary fixtures, the filesystem purity tests, 12 unit tests, all package/app builds, coverage, and all three browser smoke tests. Chromium, Firefox and WebKit reported no console or page errors. The clone remained clean after generation and build.

For local browser checks, install the browsers with `pnpm exec playwright install chromium firefox webkit`. This host used `PLAYWRIGHT_BROWSERS_PATH=/private/tmp/hexfield-playwright` and an escalated browser launch. `pnpm run ci` is the script invocation; `pnpm ci` is a reserved pnpm command. The GitHub workflow runs the equivalent checks when a remote is available.

## 02 — Engine Core

Source: [02-engine-core.md](02-engine-core.md)

- [x] Geometry counts and cross-check tests pass for radius 2, radius 3 and random shapes.
- [x] `ResourceBounds` soundness property test passes 10k runs.
- [x] `test-counter` module plays to completion through `LocalGame` with injected randomness.
- [x] Engine has zero dependencies and passes the purity check.
- [x] Deep-freeze tests prove `apply` is non-mutating.
- [x] Public API documented; `geometry.ts` entry importable by the renderer without pulling in the pipeline.

Verified 2026-09-24 with Node `22.23.3`, pnpm `10.7.1`, and `CI=1 pnpm run ci`. All 55 tests, production/test typechecks, lint, formatting, purity, 15 boundary fixtures, builds, coverage, and Chromium/Firefox/WebKit smoke tests passed. Geometry includes pixel cross-checks on 300 random connected shapes. Resource tests include 10,000 operation sequences and 2,000 comparisons against brute-force feasible hands. RNG tests pin ten outputs and check 600,000 six-sided draws. The counter module completes through random and reveal interrupts, and protocol tests prove deterministic replay hashes. The protocol test also passed with engine and codec build directories absent, confirming source resolution before a build. Public methods have TSDoc; boundary fixtures prove renderer geometry imports cannot reach the rules pipeline and handlers cannot import RNG through setup reexports.

A read-only `claude -p` stage review preceded the gate. Regressions cover its confirmed input-encoding, automatic-source failure, invariant-reporting and registration findings. Local submissions retain atomic rollback and become terminal on automatic failure, as recorded in `DECISIONS.md`.

## 03 — Base Rules Module (`base`)

Source: [03-base-rules.md](03-base-rules.md)

- [x] Every rule in this document has at least one test. `docs/rules/base.md` is complete, with every `[VERIFY]` resolved.
- [x] A full 4-player game can be scripted and completed through `LocalGame`.
- [x] Engine coverage ≥ 90% lines, ≥ 85% branches.
- [x] All option variants are covered by tests.
- [x] `getPending` is never empty until `result` is set (checked here after every input in the full-game replay; stage 04 adds the fuzzer).

Verified 2026-09-24 with Node `22.23.3`, pnpm `10.7.1`, and `CI=1 pnpm run ci`. All 151 tests, production/test typechecks, lint, formatting, 15 dependency-boundary fixtures, engine purity, builds, coverage, and Chromium/Firefox/WebKit smoke tests passed. Engine coverage is 4,436/4,520 lines (98.14%) and 1,699/1,997 branches (85.08%); CI now enforces the engine's 90%/85% thresholds.

Board tests cover 10,000 seeds in each balanced mode, original fixed-map genesis, placement constraints, and the required road/army award fixtures, including the 15-road performance case. The full four-seat scenario starts from genesis, completes snake setup, and reaches the default 10-point target using legal production, maritime trades and builds without hand gifts. Its entire log replays to the same final state, checking public invariants and nonempty pending inputs after every input. `LocalGame` checks exact-hand bounds and private resource conservation throughout. Tests also cover every option, public/private card effects, hidden-steal audit necessity, private trade transfers, and timeout discards. [The implemented rules](rules/base.md) include the rule-to-test map and source attribution.

A read-only `claude -p` stage review and a separate review of longest-road logic preceded the gate. Confirmed findings were reproduced and fixed: timeout actions must answer the relevant pending choice, balanced-dice production uses the same public/private hook state, victory claims appear in every turn interruption, and trade replacement/withdrawal and response deadlines are explicit. The decisions and follow-up tests are recorded in `DECISIONS.md`.

## 04 — Simulation & Rule Testing

Source: [04-simulation-testing.md](04-simulation-testing.md)

- [x] 100,000 random 4-player games (and 10,000 3-player games) complete with zero invariant violations and zero dead games.
- [x] 1,000,000 fuzz mutations, zero throws, zero accepted-invalid inputs.
- [x] The dice distribution over all simulated rolls matches 2d6 within statistical tolerance (chi-square p > 0.001).
- [x] Golden replays pass. CI runs sim + fuzz on each PR.
- [x] Performance budget met.

Implementation checks passed on 2026-09-24 with Node `22.23.3`, pnpm `10.7.1`, and `CI=1 pnpm run ci`. All 225 tests across 45 files, production/test typechecks, lint, formatting, dependency boundaries, engine purity, builds, coverage and Chromium/Firefox/WebKit smoke tests passed. Engine coverage is 4,869/4,932 lines (98.72%) and 2,102/2,372 branches (88.62%). All 20 golden replays match their checkpoints and compare batch private updates against per-seat updates after every input. The end-stage read-only review found no blocking issue; its confirmed fuzz-coverage and failure-reporting findings have regression coverage.

The implementation checkpoint is `2012b269b39f26f0448b00c81915e6e0db6d31f5`. Its [final fuzz run](verification/stage04/fuzz-1m-seed42-acceptance.json) passed 1,000,000 invalid mutations across 18 families and checked 62,595 accepted alternative inputs, with zero throws, accepted-invalid inputs or dead prefixes. The [PR-sized checks](verification/stage04/pr-gate-seed42-acceptance.json) completed 2,000 verified four-player games and 50,000 mutations in approximately 42.7 seconds, below the three-minute budget. The workflow runs these checks on pushes and pull requests and 100,000 games nightly. The user-authorized equivalent was run locally.

The [single-worker benchmark](verification/stage04/bench-1000-seed42-acceptance.json) completed 1,000 default four-player games at 28.03 ms per game on an Apple M3 Pro, with five separate warmups. Public apply p99 was 0.037 ms. Diagnostic invariants were disabled only for timing; validation, private updates, freezing and driver bookkeeping remained enabled. Each run records the committed source fingerprint and confirms matching source before and after execution.

The [100,000 four-player games](verification/stage04/games-100k-4p-seed42-acceptance.json) and [10,000 three-player games](verification/stage04/games-10k-3p-seed42-acceptance.json) completed with diagnostic invariants enabled, zero failures and zero dead games. Both used seed 42, default 10-point games, the 500-turn limit and unchanged source fingerprint `cf421de99e16a547bd89b1c75b5f567df8fdce86398d22dd95a5b3c6e1270e62`. The four-player batch took 35.45 minutes with four workers; its dice chi-square p was 0.4347. The three-player p-value was 0.3712. The [combined 13,075,286 rolls](verification/stage04/dice-110k-combined-acceptance.json) gave chi-square 13.9511 with 10 degrees of freedom and p = 0.1752, above 0.001. The coordinator independently parsed both raw reports and recomputed the combined statistic. Milestone A is complete.

## 05 — Local UI (Hotseat & vs RandomBot)

Source: [05-local-ui.md](05-local-ui.md)

- [x] A human can play a complete 4-player game against RandomBots on desktop and on a phone-sized viewport.
- [x] Hotseat game with 3 humans works, with privacy covers.
- [x] The UI never offers an action the engine rejects (E2E bot-driven UI test clicks only offered actions for 20 games without a single rejected submit).
- [x] 60 fps panning on a mid-range device (record a manual check in STATUS.md).
- [x] All UI strings go through react-i18next; the missing-key check passes in CI; keyboard-only play is possible.
- [x] Live game state is only in Zustand; normal persisted and asynchronous operations use TanStack Query hooks. Synchronous page-exit flushing is the documented exception.

The local game supports hotseat privacy, paced RandomBots, revision-checked commands, save restoration, trades, development cards, event animations, and game-over scoring. The UI uses a single-viewport cockpit with original SVG board and card artwork, on-board building confirmations, cancellable building and Knight intent, public eight-second resource receipts, a persistent last-roll display, and a public build-cost reference. Discard, Year of Plenty, Monopoly, and trading use the shared SVG card picker with explicit confirmation. Full-screen results preserve the finished cockpit, combine VP cards into one count, and support board inspection, reopening, replay export, and rematch.

The 2026-09-25 gameplay checkpoint for the complete browser suite is `013ffce`. `pnpm check` passes all 317 tests across 74 files, production and test typechecks, lint, formatting, dependency boundaries, purity, and i18n checks. `pnpm build` also passes. Coverage passes with `pnpm test:coverage --maxWorkers=1 --minWorkers=1`; an earlier parallel run hit the existing sub-millisecond longest-road timing assertion, while the single-worker run passes the unchanged limit. Engine coverage is 4,894/4,954 lines (98.79%) and 2,116/2,385 branches (88.72%).

The complete Chromium/Firefox/WebKit suite passes 44 tests with 61 intentional browser-specific skips. The [twenty UI-driven games](verification/stage05/ui-full20-cockpit.json) completed 11,311 inputs across 2,303 turns with zero rejected actions. The source fingerprint is `86cd4a0e58b9e5b6a3a47493e58d2f3eff9f9a2cbef9a47472b141dab3ffda73`, unchanged before and after the run. A separate touch-phone test completed a full default ten-point game with one human-controlled seat and three bots. Desktop and touch hotseat tests cover three-human privacy handoffs, setup, rolls, and paid road placement.

The final browser run covers repeated development-card hover sweeps, keyboard focus, Knight cancellation, reduced motion, phone and touch-tablet drawers, and stolen-card transfers in both directions. A manually opened multi-card drawer closes after committing a Knight; narrow desktop resource badges avoid adjacent cards; and the single Knight dock action cancels the card selected from the hand. Results checks cover an authentic two-VP-card replay at four viewport sizes, export, dismissal, reopening, reload, and rematch. The coordinator inspected the generated screenshots.

Screenshots at 1728×960, 1280×720, 1024×768, 390×844, and 844×390 cover the compact Actions dock, public piece counts, build costs, restored dice events, Knight cancellation, development-card pickers, and results. The coordinator inspected desktop dark, portrait-phone, and landscape-phone captures. The mobile redesign keeps a compact hand at the bottom, moves secondary actions into a sheet, and opens public details when a player tile is tapped. Roll, End turn, and required board instructions remain visible.

Focused mobile checks pass in Chromium at 390×844, 360×740, 320×568, and 844×390, and in WebKit at 390×844. They compare exact public Knight counts and route lengths for all four players, check one animation anchor per seat, and cover sheet dismissal, Build costs handoff, focus restoration, and document bounds. The fixture contains four played Knights and Largest Army. At 390×844, the board is 660px tall; the hand and next-step row occupy 128px below a 56px player strip. The coordinator inspected both themes and the landscape layout. Focused phone Knight, bank/offer trade, mandatory setup, robber, and paid-road flows pass. Trade cancellation leaves the revision unchanged and restores the Actions trigger.

Production inspection confirms that the preview implementation, debug drawer, and test hooks are absent from production JavaScript. The [production browser check](verification/stage05/production-audit.json) loads a local game without browser errors, confirms the hook is absent, and verifies that the development board route is blocked. The blocked route retains a small unloaded router stub. Keyboard checks cover the native board chooser, placement confirmation and cancellation, Roll and End turn, and focus restoration after card removal or Clear.

The final state-ownership review confirms that session updates feed Zustand and normal persisted reads and writes use TanStack Query. The synchronous localStorage flush on `pagehide` and cleanup is documented in `DECISIONS.md`; repository tests ensure an older queued save cannot overwrite it.

A follow-up source audit added browser coverage for the existing replay importer and production animations. The focused Chromium/Firefox/WebKit run passes six tests with six intentional browser-specific skips. Replay export and import preserve the public hash, private hands, roles, and presentation in all three browsers; a tampered replay leaves the current game and saved records unchanged. The importer labels now explicitly mention replays. Desktop and touch-phone production checks verify loaded resource artwork, the rendered flight path from producing hex to the correct player, natural cleanup, Skip, and reduced motion. The coordinator inspected the midflight screenshot. These additions change test coverage and two development-tool labels, with no engine or gameplay changes after the complete twenty-game run. After updating the devtools test selectors for those labels, `pnpm check` passes all 317 tests and `pnpm build` passes again.

The physical-phone check was initially pending at the user's request. It passed later on 2026-09-25 after the user connected a Pixel 7 through ADB. The final Pages build from source `ce6bdd1` rendered 90.33–90.89 frames per second during three real 1.8-second Android touchscreen pans at 3.03× zoom. Each gesture moved the board camera, and Android framebuffer captures visibly confirm the movement. The rAF p95 interval was 11.1 ms, with no intervals over 16.7 ms and no browser errors. The [physical-phone report](verification/stage05/physical-phone-performance.md) records the method, device, production-build fingerprints and raw measurements. The coordinator inspected both the measurements and before/after images. This completes the remaining Milestone B device criterion.

The earlier [desktop performance proxy](verification/stage05/renderer-performance.md) remains separate evidence with its stated limitations. The [simulation latency audit](verification/stage05/simulation-latency-diagnostic.md) records a passing current-source measurement of 28.32 ms per complete game and 0.037 ms `apply` p99, alongside earlier slower runs. The 1,000-game audit used the unchanged standard benchmark configuration and completed without failures.

Release source `ce6bdd1` adds the charcoal dark theme, corrected triangle marker, direct board keyboard navigation, mobile player-sheet swipe dismissal, and the omission of the manual hide-hand control for single-human games. `pnpm check` passes all 317 tests and the Pages production build passes. Ten focused board/keyboard tests and both new mobile-control tests pass. A complete phone game using touch controls finishes against three bots at the default ten-point target. Production browser checks cover setup and saved-game route reloads, board rendering, loaded artwork, absence of development tools, and desktop/phone dialog layouts, with no failed asset requests or browser errors. The coordinator inspected the final screenshots.

A subsequent short-landscape CSS correction prevents the open Game info panel from inheriting the closed button's 44px width and places it above the hand. Its 844×390 touch regression verifies readable bank cards, Event log expansion, and closing the panel. The renderer and portrait layout are unchanged from the measured physical-phone build.

## 06 — Protocol & Replicated Event Log

Source: [06-protocol-event-log.md](06-protocol-event-log.md)

- [ ] All 9 chaos scenarios pass on 1,000 seeds each with zero divergence.
- [ ] Forged signatures, replayed nonces, wrong prevHash and invalid commands are all rejected (unit tests).
- [ ] A Byzantine sequencer is detected and replaced in scenarios 6 and 7.
- [ ] The web app can run a "simulated P2P" dev mode: 4 `P2PSession`s over memnet in one tab, with 4 small game views. Useful for debugging.

## 07 — Fair Randomness & Hidden Information

Source: [07-fair-randomness-hidden-info.md](07-fair-randomness-hidden-info.md)

- [ ] P2P games over memnet with real crypto pass the stage-06 chaos suite (200 seeds per scenario in CI).
- [ ] Every row in the cheat table is covered by a passing test.
- [ ] Every completed honest game produces `AuditReport.ok === true` (1,000 simulated games).
- [ ] Dice outcomes from the beacon pass a chi-square test over 100k rounds.
- [ ] Escrow recovery works after a seat departs mid-game, and the recovered seat continues as a bot.

## 08 — WebRTC Networking & Signaling

Source: [08-webrtc-networking.md](08-webrtc-networking.md)

- [ ] 4 browsers (including Firefox and WebKit) form a full mesh via the signaling server and via manual codes plus mesh relay.
- [ ] Offer codes fit a QR code and scan successfully on a phone camera (manual test, recorded in STATUS.md).
- [ ] The identity binding rejects a tampered signaling path (unit test with a MITM fake signaling adapter swapping fingerprints).
- [ ] A 1 MiB message transfers correctly with backpressure.
- [ ] The signaling server never logs or inspects blobs (code review checklist item plus a test asserting blobs are forwarded verbatim).

## 09 — Lobby & Game Setup (first end-to-end P2P game)

Source: [09-lobby-and-game-setup.md](09-lobby-and-game-setup.md)

- [ ] Create → invite → join → start → finish → audit ✓ works over the signaling server and over manual codes.
- [ ] Mixed humans and bots work. The bot host can be any peer.
- [ ] A version mismatch is detected with a clear message.
- [ ] Every ceremony abort path returns everyone to the lobby cleanly.
- [ ] Turn timers work, and a disagreeing peer can't be forced into an early timeout.

## 10 — Persistence, Reconnection & Seat Takeover

Source: [10-persistence-reconnection.md](10-persistence-reconnection.md)

- [ ] All chaos additions pass on 500 seeds each.
- [ ] Refresh-resume takes < 3 s to be back in play on a typical laptop (measured).
- [ ] Takeover works for 3-, 4- and 2-player games, and the audit passes afterwards.
- [ ] A game can be exported from one browser and resumed in another as the same seat.

## 11 — Module Framework Hardening & 5–6 Players (`five-six`)

Source: [11-module-framework-5-6-players.md](11-module-framework-5-6-players.md)

- [ ] Base goldens unchanged after the refactor (or the change is justified and versioned).
- [ ] 50k simulated 6-player games without invariant violations.
- [ ] A 6-browser P2P Playwright game completes, and the audit passes.
- [ ] The SBP is enforced (trading and dev-card plays rejected in the SBP; builds and buys allowed).
- [ ] The module compatibility matrix is enforced in the lobby and in `createGame`.

## 12 — Seafaring Module (`seafaring`)

Source: [12-seafaring.md](12-seafaring.md)

- [ ] All scenarios are playable locally and P2P; the audit covers fog draws.
- [ ] 20k simulated games per scenario pass the invariants (new invariants: ships ≤ 15, ships only on sea/coastal edges, pirate only at sea, robber only on land).
- [ ] The trade-route fixtures pass, including the transition rules.
- [ ] Fog contents are provably not derivable from genesis (a test: two games with the same genesis seed but different deck secrets reveal different fog tiles).

## 13 — Knights & Commerce Module (`knights`)

Source: [13-knights-and-commerce.md](13-knights-and-commerce.md)

- [ ] `docs/rules/knights.md` is complete, with all `[VERIFY]` items resolved and sourced.
- [ ] K1–K6 are done, each with passing tests.
- [ ] The simulation and P2P suites pass; golden replays for 5 knights games.
- [ ] A human can play a full knights game against bots on mobile, with the barbarian track and improvements clearly visible.

## 14 — Frontier Scenarios Module (`frontier`)

Source: [14-frontier-scenarios.md](14-frontier-scenarios.md)

- [ ] F1–F4 shipped (each: rules doc, engine, UI, bot support, simulation, P2P).
- [ ] F5–F6 shipped, or explicitly deferred in STATUS.md with the reason.
- [ ] Every hidden or secret mechanic uses the deck protocol or commit-reveal and is audited.

## 15 — Explorers Module (`explorers`)

Source: [15-explorers.md](15-explorers.md)

- [ ] `docs/rules/explorers.md` is complete and sourced.
- [ ] _Land Ho!_ and at least two missions are playable locally and P2P, with audited reveals.
- [ ] The mid-move reveal pause/resume flow survives the sequencer failover chaos test.

## 16 — Bots

Source: [16-bots.md](16-bots.md)

- [ ] Tournament thresholds met.
- [ ] Hard bot decisions within budget on a mid-range phone (measured).
- [ ] No bot ever submits a rejected command in 10k simulated games per level.
- [ ] Bots support every shipped module (with at least Random fallback for any unsupported decision, logged as a warning).

## 17 — Spectators, Replays & Map Editor

Source: [17-spectators-replays-map-editor.md](17-spectators-replays-map-editor.md)

- [ ] A spectator can watch a live 4-player P2P game. The message-interception test proves it received no secrets.
- [ ] Any finished game can be replayed, with an omniscient view after the audit. Seeking to any point takes < 200 ms.
- [ ] A custom map made in the editor can be shared as a string, loaded in a lobby, and played P2P.

## 18 — PWA, Polish & Release

Source: [18-pwa-release.md](18-pwa-release.md)

- [ ] Installable PWA; offline local and bot games work in airplane mode.
- [ ] Performance budgets and accessibility checks pass in CI.
- [ ] Automated deploys for the app and the signaling service.
- [ ] The release checklist is completed for v1.0.0.
