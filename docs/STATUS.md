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

- [ ] 100,000 random 4-player games (and 10,000 3-player games) complete with zero invariant violations and zero dead games.
- [ ] 1,000,000 fuzz mutations, zero throws, zero accepted-invalid inputs.
- [ ] The dice distribution over all simulated rolls matches 2d6 within statistical tolerance (chi-square p > 0.001).
- [ ] Golden replays pass. CI runs sim + fuzz on each PR.
- [ ] Performance budget met.

Implementation checks passed on 2026-09-24 with Node `22.23.3`, pnpm `10.7.1`, and `CI=1 pnpm run ci`. All 225 tests across 45 files, production/test typechecks, lint, formatting, dependency boundaries, engine purity, builds, coverage and Chromium/Firefox/WebKit smoke tests passed. Engine coverage is 4,869/4,932 lines (98.72%) and 2,102/2,372 branches (88.62%). All 20 golden replays match their checkpoints and compare batch private updates against per-seat updates after every input. The end-stage read-only review found no blocking issue; its confirmed fuzz-coverage and failure-reporting findings have regression coverage. Final scale, fuzz and timing evidence remains required before this stage closes.

## 05 — Local UI (Hotseat & vs RandomBot)

Source: [05-local-ui.md](05-local-ui.md)

- [ ] A human can play a complete 4-player game against RandomBots on desktop and on a phone-sized viewport.
- [ ] Hotseat game with 3 humans works, with privacy covers.
- [ ] The UI never offers an action the engine rejects (E2E bot-driven UI test clicks only offered actions for 20 games without a single rejected submit).
- [ ] 60 fps panning on a mid-range device (record a manual check in STATUS.md).
- [ ] All UI strings go through react-i18next; the missing-key check passes in CI; keyboard-only play is possible.
- [ ] Live game state is only in Zustand; persisted/async data is only accessed via TanStack Query hooks.

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
