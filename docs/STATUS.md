# Status

Check each item only after its acceptance evidence is recorded. Stage 01 uses the user-authorized local CI equivalent.

Milestones A and B are complete. The [release and milestone audit](verification/stage05/pages-release.md) links the acceptance evidence and the published local-play app.

The immediate release goal is now the [first multiplayer beta](multiplayer-beta.md),
following the user's 2026-09-27 scope reduction. It prioritizes manual-code play
with friends without operating a server, same-browser reconnect, and completed
games with audits. Seat transfer, recovered-human return, takeover UI and other
large features remain deferred from the beta. The app and signaling service are
now deployed together on Cloudflare. Full M-C and M-D remain incomplete; the
smaller beta does not change their acceptance claims.

The [current beta browser check](verification/stage09/beta-browser-check.md)
passes four-human manual-code startup, all setup placements, a shared roll, a
player trade and same-browser reconnect in the Pages production build. A
[separate v3 ten-point game](verification/stage09/beta-v3-game-check.md) finished
after 332 moves with matching successful audits from both peers. The
[multiplayer beta is published](verification/stage09/beta-release.md) at
[Hexfield](https://dukesteen.github.io/hexfield/), from source `7ec176d`.
Production home, create, lobby invitation generation and join-route refresh
checks pass. External-network connectivity remains unverified, and the full
milestone acceptance items below remain open.

The current app is [Hexfield on Cloudflare](https://hexfield.steenbakkers.cc/).
The [redesign release](verification/cloudflare/redesign-release.md) is deployed
from `127f6ab` and includes the merged artwork, multiplayer controls and certified
seat-transfer flow. Its live check covers startup, human/bot setup and saved-game
exit. Later local checkpoints below have not yet been deployed.
The earlier [deployment check](verification/cloudflare/deployment.md) records live
invite-link startup, replicated setup moves, reload, lobby autosave and desktop /
mobile viewport checks. Workers Free remains the deployment constraint; TURN is
disabled. The [online worker release](verification/cloudflare/online-worker-release.md)
introduced the worker boundary in `929e889`. Certified setup and live game computation run in a
dedicated browser worker so pending indicators, menus and board rendering can
continue while checks run. It preserves the earlier action feedback and
duplicate-click protection; it does not eliminate network agreement latency.

The [current local checkpoint](verification/stage09/local-checkpoint-2026-09-27.md)
adds reviewed signed chat and automatic capture of rejected signed proofs.
Two independent browser profiles pass lobby/game messages, reactions, mute,
history separation and saved-game chat restoration. The new bad-beacon trace
certifies one cheat finding across two peers while preserving the owed outcome.
Static/build checks and focused correction tests pass; the checkpoint records
the mixed-source workspace run precisely. Proposer consequences remain
unfinished. The [fairness UI checkpoint](verification/stage09/fairness-status-check.md)
adds a public verified-move counter and certified proof-failure details in the
board, player information, event log and game results. Its focused UI, worker
projection and store checks pass 20 tests. The
[online worker implementation](verification/stage09/online-worker-implementation.md)
now moves certified setup and live game computation off the UI thread. The complete
local web suite passes 242 tests. Two-browser placements, dice, trades and restore
checks pass, as does a hosted-bot startup. The
[terminal worker check](verification/stage09/online-worker-terminal-check.md)
now completes a real shortened certified game through the worker runtime and
session proxy, with both peers passing their audits. A separate native Chrome
check passes the nested audit-worker path for the same 53-entry history.
Proof/heartbeat performance acceptance for the new boundary remains open.

The [latest real-crypto CI report](verification/stage07/verified-ci-hand-cache-2026-09-28.md)
records six completed scenarios, each with four successful audits: clean play,
sequencer restart, two-against-two partition, censorship, derived-state repair
and simultaneous restarts. Latency/duplicates, three-against-one partition and
invalid-proposer scenarios still exceed the unchanged runtime bound.
The [current M-C matrix](verification/stage09/mc-remaining-acceptance.md) and
[M-D matrix](verification/stage10/remaining-acceptance.md) distinguish current-v6
evidence from older traces. Reviewed lobby readiness and ceremony delivery fixes
are committed locally and on `acceptance/mc-md-v6`; they are not deployed.
The [persistence profile](verification/stage10/persistence-lifecycle-acceptance.md)
now checks exact restoration, restored-voter participation and private state at
every sequence. The latest run timed out before victory. The
[worker correction](verification/stage10/worker-audit-scheduling.md)
preserves independent audits and private comparisons while allowing reveal
delivery to continue; complete lifecycle acceptance remains open. The
[derived-state repair review](verification/stage10/derived-context-repair-review-disposition.md)
now covers locked safety records, pending writes and the commit boundary.
Focused tests and the complete corruption scenario now pass.

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

The published release `f9b7559` passes the complete local Chromium/Firefox/WebKit suite: 51 tests passed, 69 intentional browser-specific skips, and no failures. The [twenty release UI games](verification/stage05/ui-full20-release.json) completed 11,083 inputs across 2,303 turns with no rejected actions or browser errors. Source fingerprint `5e88158fbd25f96b9acefddc85a3bd78ce732ea7e6914483236f9a9cb3f94459` was unchanged through the run and independently recomputed afterward. The same run includes a complete touch-phone game. The [release report](verification/stage05/pages-release.md) records the successful GitHub checks and deployment, the explicitly skipped hosted E2E, live-site checks, and the final A/B acceptance audit.

## 06 — Protocol & Replicated Event Log

Source: [06-protocol-event-log.md](06-protocol-event-log.md)

- [x] All 9 chaos scenarios pass on 20 seeds each with zero divergence, alongside the targeted adversarial tests.
- [x] Forged signatures, replayed nonces, wrong prevHash and invalid commands are all rejected (unit tests).
- [x] A Byzantine sequencer is detected and replaced in scenarios 6 and 7.
- [x] Adversarial vote, lock, persistence and small-population pause tests pass. No unavailable voter is removed without the required certificates.
- [x] The web app can run a "simulated P2P" dev mode: 4 `P2PSession`s over memnet in one tab, with 4 small game views. Useful for debugging.

Stage 06 is accepted after the full CI gate on commit `53c33a2`. The user selected strict agreement when the original majority protocol could not guarantee both agreement and continued play after a disconnect. The [reviewed design](verification/stage06/strict-agreement-design.md) records the one-Byzantine-voter bound, quorum sizes, persistent locks and safe recovery policy. Commit `0dab4fb` adds the voting controller, atomic certified journal, replay validation, transport adapter and `P2PSession` with a simulation-only private-state driver. Voting records persist before messages are sent; private consequences appear after commitment.

The current implementation also includes certified proposer exclusion without reducing voting weight, bounded ingress and replay-verified snapshot repair. Single-seed full games converge in all nine scenarios. Stronger checks confirm a 2|2 pause after both halves receive the proposal, 3|1 progress before healing, a later proposer committing the exact censored command, certified exclusion in the honest peers' histories, and snapshot request/response traffic during repair. The final local checkpoint on 2026-09-25 passes 534 tests across 98 files, plus typechecking, lint, formatting, dependency, purity and i18n checks. Build, coverage and the focused Chromium peer-view check pass. The [local verification report](verification/stage06/local-checks.md) records the source fingerprint, coverage and final crash/Byzantine smoke results.

The dev-only `/#/dev/network` page displays four independent sessions and boards. A Chromium smoke test and a manual Chrome check confirm settlement and road placement advance all four peers to the same revision. A fresh production build excludes the simulation page and stub driver. The full browser rerun was interrupted at the user's request after macOS browser-launch failures caused crash dialogs; further local browser checks use targeted Chromium tests. Cross-browser CI remains enabled.

The approved [Claude implementation review](verification/stage06/implementation-review.md) is complete. It found no conflicting-certificate trace under the stated fault model, but identified persistence and resource-limit gaps around the voting core. Regressions now cover unknown local signatures inside certificates, bounded conflicting proposals, and congestion without misconduct strikes. Durable accusations, historical evidence and replay limits have focused regressions. Later reviews identified session restore, repeated-accusation and additional safety and transport gaps; the [follow-up](verification/stage06/implementation-review-response.md) tracks their fixes. The first acceptance batch completed 23 games and failed two proposer-replacement assertions before cancelling the remaining jobs. The fault injector now requires surviving peers to know the pending input before the crash. Its five tested layouts certify a replacement while the original proposer is still offline. The user approved reducing initial acceptance to 20 full games per scenario, with the targeted security tests retained. CI runs five games per scenario, nightly runs use 20 rotating game indices, and larger manual runs remain available. These counts and their rationale are recorded in the [runtime policy](verification/stage06/ci-runtime-options.md). The final 180-game acceptance batch passed all nine scenarios with zero divergence or failures. The [CI acceptance report](verification/stage06/ci-acceptance.md) retains every raw result and the independent audit evidence. The workflow, including deployment, is green. Its full browser suite passed 54 tests with 69 intentional skips and no flaky results; all three browsers passed the four-peer view test. Twenty full UI games completed 11,336 inputs with zero rejected actions. The source fingerprints match the local source. Verification was completed on 2026-09-26, local time. Milestones C and D are not complete.

## 07 — Fair Randomness & Hidden Information

Source: [07-fair-randomness-hidden-info.md](07-fair-randomness-hidden-info.md)

Implementation has started after the Stage 06 CI gate. The [design review response](verification/stage07/design-review-response.md) records the accepted lifecycle, delivery, proof-composition and recovery corrections, as well as review claims rejected after checking the mathematics. Step 1 adds group/derivation helpers, hash chains, unbiased integer sampling, secret sharing, Schnorr/DLEQ proofs, sealing, composable bit/range proofs and compact shuffle proofs. The approved [implementation review and response](verification/stage07/step1-review-response.md) add explicit escrow parameter checks, proof-mode nonce separation and a complete CDS OR helper. The follow-up review is complete, with isolated attack regressions and mutation checks for its test findings. [Local checks](verification/stage07/step1-local-checks.md) pass 623 tests in 112 files and the production build.

Step 2 now integrates the beacon with certified-log verification, replay, durable outgoing contributions and peer delivery. The [local checkpoint](verification/stage07/step2-local-checks.md) passes 655 tests in 116 files and the production build. A read-only review identified an extension-secret lifecycle gap; deterministic reconstruction and crash regressions address it. The follow-up review confirms the correction; its remaining hardening and test findings are addressed locally.

The first part of Step 3 adds signed deck setup, private draw/reveal proofs and durable outgoing contributions. The [foundation checkpoint](verification/stage07/step3-foundation-local-checks.md) passes 687 tests and the production build. The [ledger checkpoint](verification/stage07/step3-ledger-local-checks.md) adds canonical genesis commitments, durable consent, certified setup-pass delivery and mandatory deal/reveal checks in log validation. Admission and objective accusations use the same command proofs, with bounded handling of invalid submissions and repeated proposals. The [live checkpoint](verification/stage07/step3-live-local-checks.md) connects durable unlock delivery, private session restoration and reveal-proof production, including a certified knight play through two live sessions. Its local checks pass 737 tests. The review fixes enforce private replay continuity and ownership, and isolate notification failures from consensus.

The [victory checkpoint](verification/stage07/step3-victory-local-checks.md) adds bounded automatic-claim retries and proves a real privately dealt victory card can finish a certified game after a temporary proof failure. The [follow-up response](verification/stage07/step3-victory-review-response.md) records the review fixes. Current headed Chrome shuffle runs take 2.30 s and 2.17 s, within the three-second target. Three full-draw samples with independent peer caches and 50 ms links take 965.1–991.5 ms against the unchanged one-second target. A three-human relay and a second legal draw pass. Follow-up tests cover one human with three bots, four humans and bounded invalid/stale live contributions. Live excluded-unlocker recovery still depends on escrow.

The [Step 4 foundation checkpoint](verification/stage07/step4-foundation-local-checks.md) adds ordered engine accounting effects, public commitment arithmetic and consistency checks without changing saved engine state or golden hashes. Its final local gate passes 772 tests in 134 files, with one opt-in timing test skipped, plus the production build. The [Claude review response](verification/stage07/step4-foundation-review-response.md) records the validation fixes and retained-history coverage. The [ledger checkpoint](verification/stage07/step4-ledger-local-checks.md) now connects public hand commitments and mandatory spending-proof checks to admission, voting, accusation verification and certified replay. Owned private updates must open the public commitments. The final combined check passes 787 tests in 137 files, with the opt-in draw benchmark skipped. The subsequent [count-delivery checkpoint](verification/stage07/step4-count-local-checks.md) adds frozen owner-signed Monopoly counts, immutable outbox retries, bounded gossip, mandatory replay validation and owned private hand updates. Its [review response](verification/stage07/step4-count-review-response.md) records startup and shared-path validation fixes. The final local gate passes 805 tests in 141 files, with the opt-in draw benchmark skipped, and the production build. A legal Monopoly trace restores both peers while one victim is pending, resends the exact saved contribution, and finishes with matching private hands. The subsequent Step 5 checkpoints connect hidden steals. Other-owner trade proof delivery is recorded in the subsequent trade checkpoint below. Authorized recovery from withholding owners, escrow, audit and the remaining adversarial integration are unfinished. This mode is not exposed in the production UI, and Stage 07 is not accepted. Real WebRTC transport, lobby setup and durable browser recovery remain in stages 08–10.

The [Step 5 foundation checkpoint](verification/stage07/step5-foundation-local-checks.md) adds one-hot/index transfer proofs, victim-signed sealed openings, recipient receipts and authenticated bad-delivery disputes. Verified genesis now binds every seat's encryption key before deck setup. The [review response](verification/stage07/step5-foundation-review-response.md) records the corrected order of cheap authentication and expensive proof checks. The full local gate passes 832 tests in 145 files, with one opt-in benchmark skipped, and the production build. The [live delivery checkpoint](verification/stage07/step5-live-local-checks.md) connects these helpers to certified steal messages and private hand updates. A legal two-peer trace drops delivery, restarts both peers, verifies exact retransmission, completes one transfer and restores the same hands again. A certified bad-opening dispute preserves hands and blocks completion. The [security review response](verification/stage07/step5-live-review-response.md) records a reproduced shared-secret disclosure attack and its fix: mandatory sender knowledge of the ephemeral scalar before a recipient can disclose a dispute point. The follow-up review confirms that correction. The final combined local check passes 852 tests in 149 files, with one opt-in benchmark skipped, and the production build passes. The source fingerprint is unchanged throughout verification. Typed cheat consequences, escrow and audit remain unfinished. The eight-type browser performance target also remains open; an early Node diagnostic exceeded it. Stage 07 and milestones C/D remain incomplete.

The [trade checkpoint](verification/stage07/step4-trade-local-checks.md) connects signed, directly routed other-owner spending proofs to certified player trades. Preparation supports cancellation, deadlines, timer priority and three fresh-parent retries; admission preserves the existing mandatory proof verifier. The legal live trace covers four requests at distinct certified parents, stale response rejection, restart, exact response regeneration and one committed transfer. Claude's follow-up confirms the timing fixes. The final combined local gate passes 899 tests in 157 files, with one opt-in benchmark skipped, and the production build. That total includes 30 tests for separate unintegrated cheat-proof, escrow-roster and WebRTC foundations; their integration and stage acceptance remain open. The verified private protocol is still outside the production online UI.

Work on 2026-09-27 adds durable live cheat candidates and signed master/escrow transcripts with manifest approval, atomic master reservation and ceremony-wide retirement on authenticated disclosure. The [live candidate review response](verification/stage07/step6-live-review-response.md) records fixes for owed contributions, auxiliary restore failures and rotating retries, with separate gossip and historical-proposal budgets. The [escrow follow-up](verification/stage07/step7-escrow-followup-review.md) led to private dispute-proof nonces, typed fault verdicts and retirement for false complaints too. The [lifecycle response](verification/stage07/step7-lifecycle-review-response.md) records local-manifest binding, permanent master retirement and reserved abort storage, with 12 focused passing lifecycle tests. The [combined local checkpoint](verification/stage07/step6-7-local-checks.md) passes 1,014 tests in 167 files with one opt-in timing test skipped, all static checks and the production build. The 566-file source fingerprint remained unchanged during verification. Automatic cheat capture, proposer consequences, authorized recovery/activation, browser storage and complete audit remain unfinished. The [current Chrome steal measurement](verification/stage07/step5-hidden-transfer-precompute.md) is 1.09–1.14 seconds after fixed-generator precomputation, above the unchanged 300 ms target.

The [recovery groundwork checkpoint](verification/stage07/recovery-local-checks.md) adds a ceremony coordinator with durable accepted shares, exact outbound retries, irrevocable genesis consent and completed/retired lifecycle states. A reproduced crash between saving a complaint and retiring the ceremony is fixed and covered by a real signed bad-share regression. Browser IndexedDB records and cross-context locks pass unit tests and a [native Chrome check](verification/stage07/native-storage-check.md). Private reconstruction authenticates the certified prefix, verifies supplied masters and every owned beacon extension, and rebuilds hands/slots; real draw and steal traces match their retained private state. The full local gate passes 1,031 tests in 170 files, with one opt-in timing test skipped. The [design review](verification/stage07/recovery-integration-review.md) is complete; the attempted implementation review hit Claude's session limit and remains pending. The coordinator and storage are not yet wired into an online lobby. Recovery authorization, share release, controller activation, full audit and stage acceptance remain unfinished.

The [audit checkpoint](verification/stage07/audit-checkpoint.md) adds exact recorded
engine replay, signed post-result master exchange, durable incoming/outgoing
reveals, independent full-hand auditing and a browser worker adapter. A real
certified victory passes the audit; the live trace covers lost reveals, retry,
worker cancellation and restoration after the other peer leaves. Audit status is
separate from the certified game result. The production lobby and results view
do not consume this path yet. The [Claude review and corrections](verification/stage07/audit-review-disposition.md)
address rejected-history reporting, signed reveal relay, recovered-secret storage
wiring, corrupt reveal records, fault attribution and worker deadlines. Pending
recovery now pauses ordinary gameplay until activation. Complete recovered-game
audits, adversarial acceptance and performance remain open.

The [recovered deck receipt correction](verification/stage07/recovered-deck-review-disposition.md)
fixes a reproduced private draw halt after seat takeover. A certified card retains
the exact unlock signer roster from its deal, so later private opening, public
reveal and audit do not incorrectly return to genesis signing keys. New draws
still use current certified authority. The focused 43-test check and a subsequent
snapshot-tampering recheck pass. Claude found no blocking issue; its malformed-key
hardening is implemented. The [recovered-game acceptance](verification/stage07/recovered-game-audit-check.md)
now passes one complete game after seat 0 becomes a recovered bot. All three
surviving sessions finish successful audits, including a development-card draw
under the replacement authority. The same 109-entry history also passes the
native Chrome audit worker with an exact report match. Broader adversarial and
cross-device acceptance remain open.

- [ ] All nine real-crypto fault scenarios pass one reproducible complete game under the [bounded acceptance policy](verification/p2p-acceptance-policy.md).
- [x] Every cheat-table row has a passing signed-admission check at the stated boundary. The [coverage matrix](verification/stage07/cheat-table-coverage.md) records the live gameplay, signed ceremony and private recovery-void scopes.
- [x] Human-only, hosted-bot and recovered-bot compositions finish without false `CHEAT_PROOF` entries and with successful independent audits from every survivor, under the [bounded acceptance policy](verification/p2p-acceptance-policy.md).
- [x] Dice outcomes from the beacon pass the 100,000-round chi-square check; the [measured checkpoint](verification/stage09/local-checkpoint-2026-09-27.md) records the face and sum distributions.
- [x] Escrow recovery works after a seat departs mid-game, and the recovered seat continues as a bot. The [current-v6 native lifecycle](verification/stage10/native-takeover-acceptance.md) passes two takeovers, human return, default-ten-point finish and all three surviving audits.
- [x] Shuffle and steal proofs meet the performance targets in Steps 3 and 5. The [current-v6 draw](verification/stage07/draw-owned-genesis-2026-09-28.md) passes three independent-cache 50 ms-link samples, worst 889.0 ms against one second. The [shuffle checkpoint](verification/stage07/step3-victory-local-checks.md) retains 2.30/2.17 s against three seconds and the prior failed draw sample; the [reviewed eight-type proof](verification/stage07/step5-zero-scalar-hardening.md) remains below 300 ms. These measurements do not establish cross-device timing.

## 08 — WebRTC Networking & Signaling

Source: [08-webrtc-networking.md](08-webrtc-networking.md)

The [latest Chrome check](verification/stage08/chromium-replacement-smoke.md) formed all six native links, transferred a 1 MiB pattern and reconnected a lost pair after the authenticated replacement fixes. It used four same-origin frames, not four independent browsers. The [transport review response](verification/stage08/mesh-final-review-response.md) records protection against old signed offers replacing a live connection, deferred offer handling and 45 focused passing tests. The signaling service and client adapter pass 21 focused tests. The [signaling review response](verification/stage08/server-review-response.md) records half-open socket replacement, heartbeats, paced messages and full forwarded-frame limits.

Manual signed codes, QR generation/scanning, in-mesh signaling relay, configurable
ICE settings and connection diagnostics are implemented locally. The
[two-origin browser check](verification/stage09/manual-browser-check.md) reaches
the board and certifies human/bot moves without a signaling server, then restores
the guest's saved board and private hand after closing its tab. Its manual
reconnect follow-up exposed a stale bootstrap bridge. After the lifecycle fix,
the surviving host accepts a replacement connection and both peers certify the
next turn handoff. The reconnected game then finishes at its configured
three-point target, with both browsers independently reporting a passed game
audit. This uses two humans and two hosted bots on the same laptop and network;
it does not establish the four-browser or external-network criteria.
Thirty focused manual/transport/room tests pass.
The [TURN guide](ops/turn.md) covers deployment and credential configuration;
temporary credentials now refresh while a room remains open. Fourteen focused
RTC-configuration, credential-query and room-registry tests pass, including
expiry, retry and disposal. App typechecking and scoped lint pass. Cross-browser,
phone-camera, cross-network and deployment acceptance remain open.

- [x] 4 browsers (including Firefox and WebKit) form a full mesh via the signaling server and via manual codes plus mesh relay. Verified in [run 36408263093](verification/stage08/mixed-engine-manual-2026-09-28.md) at `95a1f63`; manual relay also finished with four audits, while signaling hit its unchanged 240-second game limit.
- [ ] Offer codes fit a QR code and scan successfully on a phone camera (manual test, recorded in STATUS.md).
- [x] The identity binding rejects a tampered signaling path (unit test with a MITM fake signaling adapter swapping fingerprints).
- [x] A 1 MiB message transfers correctly with backpressure.
- [x] The signaling server never logs or inspects blobs (code review checklist item plus a test asserting blobs are forwarded verbatim).

The [networking acceptance audit](verification/stage08/current-acceptance-audit.md)
records source review and 74 passing focused tests for these three items. The
mixed-browser and phone-camera checks remain open.

## 09 — Lobby & Game Setup (first end-to-end P2P game)

Source: [09-lobby-and-game-setup.md](09-lobby-and-game-setup.md)

The [native lobby check](verification/stage09/lobby-browser-check.md) passes in
Chrome with three clients using real signaling and WebRTC. Guests take seats,
the host adds a bot, and all humans sign the same configuration and ceremony
nonce. A native startup race found during the check is fixed with bounded signed
snapshot retries. Device identities and fresh per-game key material have durable
storage helpers. The create/join/lobby screens are now implemented, with a
[native host UI check](verification/stage09/lobby-ui-check.md) covering room
creation, bot seating, readiness, settings, invitation copying and leave
confirmation. The adapter between authenticated device connections and fresh
game identities passes focused tests. The home screen still exposes only local play.

A detached `verifyLobbyFreezeAgreement` now verifies the exact ready-state
snapshot and one signed ACK from each seated human before ceremony restoration;
its focused lobby checks pass. The [online-start plan](verification/stage09/online-start-plan.md)
records the remaining board-seed transcript, device-to-game key bindings, durable
ceremony phases and game-session handoff. It is a design contract, not acceptance
evidence.

The next local checkpoint implements the protocol-v2 board-seed ceremony,
certified device-to-game identity bindings, durable browser startup and the
online game route. A real two-human/two-bot trace finishes setup and certifies
its first board move with isolated private hands. Four-human setup also passes
with real escrow and deck proofs. Focused retry, close-during-startup and
storage-binding tests pass. The [startup foundation review disposition](verification/stage09/startup-foundation-review-disposition.md)
records the reproduced nonce-reuse and wrong-device-routing fixes. Native
browser lobby-to-board and close/reopen/rejoin verification now pass in the
[manual-code check](verification/stage09/manual-browser-check.md), including
a completed shortened game and passed audits on both peers. The resume
follow-up review also has its correction record below. A current-v2
four-human recovered-game acceptance run remains open.
These are local implementation results, not a published P2P release or Stage 09
acceptance.

The focused online-ceremony file now passes all 11 cases (71.2 seconds), covering
one through four humans, exact share/ACK replay after restart, bad-share
retirement, objective invalid-envelope evidence, and post-consent disclosure
before and after a ready result. Three browser-startup lifecycle traces pass
(18.4 seconds), including lease contention, closing while acquiring a lease,
and stopping both opening and active games after the coordinator reports a
verified disclosure. The latter tests inject the authenticated coordinator event
at the browser lifecycle boundary; the ceremony tests establish its cryptographic
verification. No browser gameplay acceptance is implied by these Node tests.

The [implementation review disposition](verification/stage09/online-start-implementation-review-disposition.md)
records fixes for valid ceremony lock IDs, invalid-envelope handling after
consent, unauthorized packet senders and interrupted retirement. Focused
regressions pass. The [saved-game resume checkpoint](verification/stage10/browser-resume-checkpoint.md)
adds the browser resume route and saved-game list, restores existing credentials
and the certified journal, and drains replayed disputes before activation.
Eleven runtime tests pass in 59.69 seconds. Combined type, lint, dependency and
production-build checks pass. The resume follow-up review is complete; its
[correction record](verification/stage10/browser-resume-review-disposition.md)
tracks the journal identifier and route lifecycle fixes, catalogue resilience,
safe first-open recovery and dispute-evidence work. Native Chromium
close/reopen restoration now passes; measured refresh performance remains
pending.

The online lobby exposes every base-module option, all four turn-timer values,
the agreed random or fixed board seed, and bot-host assignment. Guests can inspect
the signed settings before readying. Three configuration-form tests and five
signed-lobby tests pass, including ready resets and seed binding. The actual
browser form check is still pending.

- [ ] Create → invite → join → start → finish → audit ✓ works over the signaling server and over manual codes.
- [ ] Mixed humans and bots work. The bot host can be any peer.
- [x] A version mismatch is detected with a clear message. The [signed-version UI check](verification/stage09/lobby-ceremony-ui-bridge.md) covers incompatible protocol and engine versions, the host-version alert and unavailable start action.
- [ ] Every pre-consent ceremony abort retires its keys and returns to the lobby; post-consent timeout or disclosure preserves the signed promise and shows recoverable waiting.
- [ ] Turn timers work, and a disagreeing peer can't be forced into an early timeout.

## 10 — Persistence, Reconnection & Seat Takeover

Source: [10-persistence-reconnection.md](10-persistence-reconnection.md)

The [certified recovery checkpoint](verification/stage10/recovery-checkpoint.md)
adds authorization, activation, durable private reconstruction and retired-voter
records. The [live recovery checkpoint](verification/stage10/live-recovery-checkpoint.md)
connects share/check routing and replacement-bot ownership to the session. Three
survivors recover a missing seat, finish the frozen beacon and accept a bot move
under its replacement key; restarting the host restores the hand and resumes the
bot. A delayed departed client catches up and retires its former key. Native
Chrome checks cover the atomic journal and cross-worker writer lease. Browser
session integration, complete recovered games and audit acceptance remain open.
No Stage 10 acceptance item is checked by these implementation checkpoints.

The [saved-game resume checkpoint](verification/stage10/browser-resume-checkpoint.md)
verifies restart after a certified move using two human sessions and hosted
bots. Browser refresh, external-network reconnection, transferable saves and
seat-transfer controls still require integration and acceptance checks.

Opening an online game now requests persistent browser storage once. The settings
repository claims a durable marker under its cross-tab lock before the request;
denied, unsupported and failed requests do not stop gameplay. Sixteen focused
storage/query tests and the online game-screen lifecycle tests pass.

The [public snapshot checkpoint](verification/stage10/public-snapshot-checkpoint.md)
adds a version-4 IndexedDB cache every 100 certified entries and retains the last
three. Cache failures cannot change the commit verdict. Reads require independent
full replay, and game deletion removes cached snapshots in its tombstone
transaction. This cache does not grant voting authority or replace full replay.
Optional passphrase encryption of live identity/private storage remains open.

The [takeover review](verification/stage10/takeover-policy-review-disposition.md)
identified voting-progress, competing-request and returning-target defects in
the local approval facade. The corrected implementation binds takeover policy
to signed lobby configuration and genesis, certifies presence changes, and
measures absence only while the required quorum is reachable. The
[product review](verification/stage10/takeover-product-review-disposition.md)
covers policy controls, eligibility checks and approval of the exact current
candidate. These checks do not establish a complete browser takeover.

The local [v4 transfer core checkpoint](verification/stage10/transfer-core-check.md)
adds certified authorization, cancellation, activation and same-seat key
retirement. A four-replica network trace exercises those transitions and refuses
restart by the retired key. Review fixes reject older recovery roots after a
new recovery and reserve transfer-encryption keys after cancellation. The user
waived backward compatibility: v4 rejects earlier saves without rewriting them.
The sealed private-delivery and atomic import-promotion helpers now pass focused
tests. Promoted browser startup restores the current certified device and key
without reminting ceremony material. A recovered player's former host releases
that seat's keys and private state while retaining its own hand. The
[runtime integration map](verification/stage10/transfer-runtime-integration-map.md)
tracks the remaining bootstrap, device admission, worker orchestration and user
controls. This checkpoint is not deployed and does not complete Stage 10.

The [product checkpoint](verification/stage10/product-acceptance-checkpoint.md)
adds two-/three-human departure and restart traces, automatic-first reconnect
controls, and enlarged QR views. Finished-game outcome metadata now follows the
verified session and audit lifecycle; the home list shows winner/audit status
and derives local statistics only from complete successful audits. Saved history
now has public replay export/opening, confirmed local removal and a display-only
30-day inactivity label. A permanent deletion marker prevents a deleted game
from reviving its old voting identity. The [full-save UI](verification/stage10/full-save-ui-checkpoint.md) adds optional
passphrase-encrypted private export and read-only imports. Public file export,
import, reload and a mobile view pass in native Chrome. Imported history and
safety do not authorize play; certified fresh-key resume remains unfinished.

The [native v5 handoff](verification/stage10/native-transfer-acceptance.md) certifies
activation, accepts a move from the new device at matching peer heads and refuses
retired-source reload. Certified cancellation also passes receipt, continued source
play and durable destination reload in 46.7 seconds. Post-takeover return browser
acceptance remains open. The [recovered v5 run](verification/stage10/recovered-v5-acceptance.md)
finishes a three-point game and all three surviving peers complete clean audits
in 95.42 seconds. Its crash occurs before survivor startup, so it does not satisfy
the separate mid-game browser takeover requirement.

The [native resume trace](verification/stage10/native-resume-acceptance.md) now
refreshes the higher-ID WebRTC responder and accepts its next certified move in
2.438 seconds. The reconnect fix retries a lost signed offer when signaling
reports a known peer returning, while preserving admission and replay checks.
Both pages and workers also close and reopen in reverse order, then accept
another move at matching heads. This is a local laptop measurement; whole-browser
process restart and cross-device performance remain separate checks.

- [ ] All five chaos additions and every distinct unlock persistence boundary pass deterministic traces under the [bounded acceptance policy](verification/p2p-acceptance-policy.md).
- [x] Refresh-resume takes < 3 s to be back in play on a typical laptop (measured).
- [x] Four-human takeover and audit pass; two-/three-human departure pauses safely and resumes when the required voter returns. See the [current-v6 native lifecycle](verification/stage10/native-takeover-acceptance.md) and [signed departure tests](verification/stage10/product-acceptance-checkpoint.md#departure-safety).
- [ ] A game can be exported and resumed in another browser as the same seat through a certified key transfer; a stale save cannot reactivate a retired key.

## 11 — Module Framework Hardening & 5–6 Players (`five-six`)

Source: [11-module-framework-5-6-players.md](11-module-framework-5-6-players.md)

- [ ] Base goldens unchanged after the refactor (or the change is justified and versioned).
- [ ] 50k simulated 6-player games without invariant violations.
- [ ] A 6-browser P2P Playwright game completes, and the audit passes.
- [ ] The SBP is enforced (trading and dev-card plays rejected in the SBP; builds and buys allowed).
- [ ] The module compatibility matrix is enforced in the lobby and in `createGame`.

## 12 — Seafaring Module (`seafaring`)

Source: [12-seafaring.md](12-seafaring.md)

- [ ] All scenarios are playable locally and P2P; fog draws are verified on the move.
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
- [ ] Every hidden or secret mechanic uses the deck protocol or commit-reveal and is verified on the move.

## 15 — Explorers Module (`explorers`)

Source: [15-explorers.md](15-explorers.md)

- [ ] `docs/rules/explorers.md` is complete and sourced.
- [ ] _Land Ho!_ and at least two missions are playable locally and P2P, with reveals verified on the move.
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

## Protocol v5 proposer evidence checkpoint, 2026-09-27

[The invalid-proof control checkpoint](verification/stage07/invalid-proof-control-checkpoint.md)
adds certified proposer consequences for attributable bad proofs in system/crypto
entries, fixes wrapped deck-pass capture, and records the independent review and
75 focused passing cases. The protocol version is now 5; mixed-version admission
is rejected. Full cheating/network matrix acceptance remains open.

The [native v5 three-browser transfer trace](verification/stage10/native-transfer-acceptance.md)
passes activation, a destination move accepted by the survivor at matching heads,
and retired-source reload refusal in 21.6 seconds. The earlier reported startup
stall was a test turn/registry lookup issue; the worker ingress omission was the
production bug. Full takeover-to-victory audit acceptance remains separate.
