# Stage 12 acceptance evidence

Stage: [12 — Seafaring module](../../12-seafaring.md). Dates are local time, 2026-09-28 and 2026-09-29.

## Run size: 1,000 games per scenario, not 20,000

The stage document asks for 20,000 simulated games per scenario. At the user's direction the closeout ran **1,000 games per scenario**, one run at a time with four workers, so that memory and CPU stayed bounded. The acceptance box for the simulation is ticked against that agreed size, not against 20,000.

## Simulation: 1,000 games per scenario with invariants on

Reports are in [`sim/`](sim/). Each run is `pnpm sim run --scenario <id> --players <seats> --games 1000 --seed <seed> --parallel 4`, with public and private invariants and card conservation checked on every input (`verifyInvariants: true` in each report). All eight scenario ids ran, at the seat counts below, and New Horizons also at three seats.

| Scenario        | Seats | Seed | Games         | Failures | Avg turns | Dice p | BUILD_SHIP | MOVE_SHIP | MOVE_PIRATE | CHOOSE_GOLD | Minutes | Peak RSS |
| --------------- | ----- | ---- | ------------- | -------- | --------- | ------ | ---------- | --------- | ----------- | ----------- | ------- | -------- |
| new-horizons    | 4     | 1202 | 1,000/1,000   | 0        | 162.3     | 0.259  | 20,786     | 18,673    | 16,235      | 1,522       | 2.7     | 708 MB   |
| new-horizons    | 3     | 1203 | 1,000/1,000   | 0        | 142.9     | 0.972  | 14,477     | 13,926    | 13,952      | 603         | 2.1     | 712 MB   |
| new-horizons-56 | 6     | 1205 | 1,000/1,000 † | 0        | 196.3     | 0.224  | 35,593     | 23,353    | 22,350      | 1,200       | 9.0     | 881 MB   |
| four-isles      | 4     | 1204 | 1,000/1,000   | 0        | 141.8     | 0.685  | 18,983     | 21,520    | 13,122      | 37,121      | 3.0     | 712 MB   |
| four-isles-56   | 6     | 1206 | 1,000/1,000   | 0        | 120.3     | 0.911  | 31,927     | 17,080    | 13,236      | 47,607      | 5.4     | 753 MB   |
| fogbound        | 4     | 1201 | 1,000/1,000   | 0        | 131.1     | 0.546  | 12,488     | 11,315    | 12,999      | 481         | 2.1     | 758 MB   |
| desert-crossing | 4     | 1207 | 1,000/1,000   | 0        | 201.6     | 0.817  | 19,209     | 25,685    | 17,405      | 5,547       | 3.3     | 734 MB   |
| open-sea        | 4     | 1208 | 1,000/1,000   | 0        | 150.5     | 0.816  | 19,074     | 23,058    | 13,745      | 25,968      | 2.3     | 762 MB   |
| open-sea-56     | 6     | 1209 | 1,000/1,000   | 0        | 125.5     | 0.585  | 25,497     | 15,030    | 13,005      | 27,836      | 5.1     | 738 MB   |

Files: `<scenario>-<seats>p-1k.json`. Every report has `failedGames: 0` and `sourceUnchanged: true`. Dice chi-square p-values are all above 0.001. Peak RSS is the whole process (four workers), sampled every ten seconds, and stayed flat for the length of each run, so the summaries did not accumulate per-game data.

Provenance: eight runs used a copy of the tree at commit `0564d9e` (source fingerprint `aa570f1a47be…`, taken before any later commit touched engine, maps or protocol sources; the copy was deleted afterwards to free disk). The New Horizons six-seat rerun used the main checkout at `d667493` (fingerprint `05f2ff32402f…`).

† The first New Horizons six-seat run ([`new-horizons-56-6p-1k-cap500.json`](sim/new-horizons-56-6p-1k-cap500.json), 991 of 1,000 finished) had 9 games stopped by the simulation's 500-turn dead-game cap. They are not deadlocks. No invariant failed and turns kept advancing. Replaying five of them (indexes 320, 329, 330, 588 and 633) with a 3,000-turn cap ended each with a winner, between turns 518 and 1,063. Random bots run out of pieces on the full six-seat board and then crawl toward the 16-point target. I added `--max-turns` to the sim and reran the scenario with a 3,000-turn cap: 1,000 of 1,000 finished with zero failures (average 196.3 turns). The 16-point target was left alone (see [DECISIONS](../../DECISIONS.md)). No other scenario had a capped game.

## The four invariants

`packages/engine/src/modules/seafaring/invariants.ts` (ships) and `packages/engine/src/modules/base/invariants.ts` (robber) already check the stage's new invariants on every input:

- ships at most 15 per seat: `seat N placed too many ships` (the limit comes from the module's `pieceLimits`);
- ships only on sea or coastal edges: `ship must touch the sea`;
- the pirate only at sea: `pirate must occupy a sea hex`;
- the robber only on land: `robber must occupy a land hex`.

None had a test that tampered with a state, so [`invariants.test.ts`](../../../packages/engine/src/modules/seafaring/invariants.test.ts) now does: a fresh game holds them all, an inland ship, a sixteenth ship (fifteen pass), a pirate on land and a robber at sea are each reported. Five tests pass.

## Trade-route fixtures and the transition rules

- [`packages/engine/src/modules/base/awards/index.test.ts`](../../../packages/engine/src/modules/base/awards/index.test.ts), `generalized route graph` (15 tests in the file, all passing): without a predicate every join is allowed; a road–settlement–ship chain counts through the settlement vertex only; a road meeting a ship at an empty vertex does not connect; same-kind edges join at any vertex and only a kind change needs the transition; an opponent building ends the route at its vertex; and, through the `routeGraph` hook on a real board, roads and ships join only at the own settlement between them, an opponent settlement on the road part breaks the route, and roads-only games are unchanged.
- [`packages/engine/src/modules/seafaring/routes.test.ts`](../../../packages/engine/src/modules/seafaring/routes.test.ts), `longest trade route` (8 tests, all passing): a road, own settlement and ship chain is one route; a road meeting a ship at an empty vertex does not connect; a city joins pieces like a settlement; ships alone form a route; an opponent building breaks it but a trail may end there; base rules are unchanged without ships; the award moves to the seat whose road-and-ship route reaches five and to a longer one; roads-only games keep their result.

The three files (28 tests) pass in the final run of `packages/engine`.

## Fog contents are not derivable from genesis

[`tools/sim/src/fog-deck-secrets.test.ts`](../../../tools/sim/src/fog-deck-secrets.test.ts) runs the real deck ceremony among four verified seats on the real Fogbound config (`certifyPublicDraws`). Two games with one genesis seed and different deck secrets have identical genesis state (and 13 hidden fog hexes) but reveal different tiles; the same secrets reveal the same tiles, and every tile is one the declared stack holds. Both tests pass (about 46 s).

## Golden replays, one per scenario id

`pnpm sim golden --update --seafaring` writes [`packages/engine/test/golden/seafaring/`](../../../packages/engine/test/golden/seafaring/) (its own manifest; the base golden directory and its 20 fixtures are untouched and still pass). Each case names the paths its game must show, and the generator takes the first game index of its seed that shows them. [`packages/engine/test/golden-seafaring.test.ts`](../../../packages/engine/test/golden-seafaring.test.ts) replays every fixture, checks every canonical checkpoint, the public and private invariants at every input, the winner and the declared features; a `tools/sim` test regenerates Fogbound and compares it byte for byte with the committed file.

| Golden          | Seats | Seed / game | Inputs | Winner | Paths shown                                                          |
| --------------- | ----- | ----------- | ------ | ------ | -------------------------------------------------------------------- |
| new-horizons    | 4     | 1200 / 3    | 1,115  | 3      | gold choice, island bonus, pirate, ship build, ship move             |
| new-horizons-56 | 6     | 1200 / 0    | 1,899  | 1      | island bonus, pirate, setup ship, ship build, ship move              |
| four-isles      | 4     | 1200 / 3    | 827    | 0      | gold choice, island bonus, pirate, ship build, ship move             |
| four-isles-56   | 6     | 1200 / 3    | 1,190  | 1      | gold choice, island bonus, pirate, ship build, ship move             |
| fogbound        | 4     | 1200 / 5    | 1,191  | 0      | **fog reveals**, gold choice, pirate, ship build, ship move          |
| desert-crossing | 4     | 1200 / 1    | 1,049  | 2      | gold choice, island bonus, pirate, ship build, ship move             |
| open-sea        | 4     | 1200 / 4    | 697    | 2      | gold choice, island bonus, pirate, setup ship, ship build, ship move |
| open-sea-56     | 6     | 1200 / 0    | 1,969  | 5      | gold choice, island bonus, pirate, setup ship, ship build, ship move |

Every fixture ends in a win. Together they cover fog reveals (Fogbound only, which is the only scenario with fog), ship builds and moves, the pirate, gold choices, island bonuses and setup ships. The 10 tests in `golden-seafaring.test.ts` and the 22 in the base `golden.test.ts` pass in the final run of `packages/engine`.

## Local play

[`apps/web/tests/seafaring-scenario-setup.e2e.ts`](../../../apps/web/tests/seafaring-scenario-setup.e2e.ts) creates a local game from the setup form for each of the eight scenario ids (six seats for the two -56 boards), checks the seafaring module, the seat count, sea hexes (and fog hexes for Fogbound alone), then places the human's first settlement and road or ship through the session and waits for the bots' pieces. 8 of 8 passed in Chromium on 2026-09-29 (16.6 s). `apps/web/tests/seafaring.e2e.ts` (the UI stage) plays a New Horizons game against bots through setup ship, sailing, building and the pirate, and covers gold payouts and fit on desktop and both phone orientations. The simulations above play every scenario through `LocalGame` with bots. The later UI follow-up (merged after this run) adds the fog reveal animation, a "revealing" indicator for online draws, the seafaring default fit, and `apps/web/tests/seafaring-scenarios.e2e.ts` (42 tests: every scenario played against bots, fit at four viewports, and a Fogbound reveal).

## P2P

### Online lobby

The online create screen and the lobby settings editor now offer the seafaring scenarios (see [DECISIONS](../../DECISIONS.md)). A fixed board and the seafaring options travel in the signed genesis config, and the archipelago is generated from the genesis seed.

- `tools/sim/src/seafaring-lobby.test.ts`: for each of the eight scenario ids the host accepts the scenario config at its most seats and the guest receives it with the same board hash and the same seafaring options (8 tests).
- `OnlineConfiguration.test.tsx` and `OnlineCreate.test.tsx`: picking Fogbound saves the base and seafaring modules with the fog board and a 12-point target, later edits keep the scenario, a seat count outside its range falls back to the classic default, an existing seafaring config opens on its own scenario, and the create screen builds a seafaring config. All 84 tests in `apps/web/src/features/online` pass.

### Every scenario id through peer sessions

[`p2p-scenarios/`](p2p-scenarios/): `node tools/sim/dist/index.js net --scenario 1 --seeds 1 --seed 42 --players <seats> --map <id>`, the clean network scenario with stub security and the real sessions, signatures, wire encoding and journals. Together with the Fogbound and Open Sea 5–6 chaos runs and the browser games, all eight ids have played a full game between peers.

| Scenario        | Seats | Games | Turns | Inputs | BUILD_SHIP | MOVE_SHIP | MOVE_PIRATE | CHOOSE_GOLD | Wall time (s) | Source unchanged |
| --------------- | ----- | ----- | ----- | ------ | ---------- | --------- | ----------- | ----------- | ------------- | ---------------- |
| new-horizons    | 4     | 1/1   | 171   | 979    | 23         | 19        | 18          | 7           | 142           | yes              |
| new-horizons-56 | 6     | 1/1   | 138   | 1,541  | 19         | 11        | 21          | 0           | 527           | yes              |
| four-isles      | 4     | 1/1   | 107   | 631    | 4          | 7         | 8           | 19          | 89            | yes              |
| four-isles-56   | 6     | 1/1   | 91    | 1,032  | 19         | 8         | 7           | 37          | 313           | yes              |
| desert-crossing | 4     | 1/1   | 283   | 1,473  | 17         | 16        | 24          | 0           | 221           | yes              |

### Four-browser games with audit

Command, from `apps/web` with the local signaling server on port 8909 (already running from this checkout, not started or stopped by me):

```sh
CI_BROWSER_SET=chromium CP2P_MIXED_ENGINE_ACCEPTANCE=1 CP2P_MIXED_ENGINE_MODE=signaling \
  CP2P_MIXED_ENGINE_SEATS=4 CP2P_MIXED_ENGINE_NO_WEBKIT=1 \
  CP2P_MIXED_ENGINE_SCENARIO=<id> [CP2P_MIXED_ENGINE_VP=<n>] \
  npx playwright test tests/mixed-engine-online.e2e.ts --project chromium
```

Two Chromium and two Firefox contexts form a full mesh, host the scenario from the create screen, run the verified four-seat genesis ceremony (with the fog decks for Fogbound), play to the end and audit. The driver places the ship nearest the fog whenever one is legal (`apps/web/tests/helpers/seafaring-policy.ts`); the base race-to-VP policy never builds ships.

| Run            | File                                                               | Result                    | Minutes | Head (all four peers) | Driver moves | Fog hexes revealed       | Notable accepted moves                                            |
| -------------- | ------------------------------------------------------------------ | ------------------------- | ------- | --------------------- | ------------ | ------------------------ | ----------------------------------------------------------------- |
| Fogbound, 8 VP | [`four-browser-fogbound-p2p.json`](four-browser-fogbound-p2p.json) | passed, 4 audits complete | 5.9     | seq 335               | 225          | 1 (terrain and token)    | 6 BUILD_SHIP, 5 MOVE_PIRATE, 1 CHOOSE_GOLD, 6 BUILD_CITY, 1 STEAL |
| Open Sea, 7 VP | [`four-browser-open-sea-p2p.json`](four-browser-open-sea-p2p.json) | passed, 4 audits complete | 8.1     | seq 483               | 332          | 0 (no fog on this board) | 7 BUILD_SHIP, 1 MOVE_SHIP, 15 MOVE_PIRATE, 2 CLAIM_VICTORY        |

In both, every peer's audit reached `complete` with `auditOk` and no audit problems, and the four heads and results were equal. The Fogbound test asserts that at least one fog hex was drawn; the drawn tile went through the certified public deck protocol on each peer. The Open Sea board is the archipelago generated from the joint genesis seed, and every peer ended on the same head, so the generated boards agreed. WebKit is left out as in stage 11 (no local WebRTC connectivity).

Two things to know:

- The first attempts did not finish. One hung in the browser while a simulation with four workers and other agents' jobs kept the machine at a load average near 100 (progress stopped at seq 71 with all pages idle). The next, at 10 VP, played 363 moves correctly but ran past its play budget. The third finished the game (seq 491, 82 turns) and the two Chromium peers' audits completed, but both Firefox peers' audits ended in `audit-worker`. The audit worker has a fixed 60-second deadline (`apps/web/src/session/audit-worker-client.ts`), and that audit did not finish in time under load. In the passing runs the audit took 44 and 49 seconds from the terminal state (`auditElapsedMs` in the JSON files), so a 350–500 entry seafaring game is within about 20 seconds of that deadline on a slow or busy machine. I did not change the deadline; it is worth raising for long games.
- Only one fog hex was revealed in the Fogbound browser game. The explorer policy reveals tiles in about two thirds of games at 8 VP, and the test only requires one. The chaos runs below reveal 16 to 19 tiles per game through the same protocol.

### Chaos suite on Fogbound, four peers

[`chaos-fogbound-4p/`](chaos-fogbound-4p/): `node tools/sim/dist/index.js net --scenario N --seeds 1 --seed 42 --players 4 --map fogbound` for scenarios 1 to 9, with stub security and the real peer sessions, signatures, wire encoding and journals. The bots are `ExplorerBot`s (random bots that sail toward the fog) so that every game reveals fog through the public-draw path.

| Scenario | Games | Turns | Inputs | Fog reveals | Ship builds and moves | Fault injected / recovered | Wall time (s) |
| -------- | ----- | ----- | ------ | ----------- | --------------------- | -------------------------- | ------------- |
| 1        | 1/1   | 179   | 1,040  | 19          | 68                    | no / no                    | 262           |
| 2        | 1/1   | 179   | 1,040  | 19          | 68                    | no / no                    | 653           |
| 3        | 1/1   | 179   | 1,040  | 19          | 68                    | yes / yes                  | 152           |
| 4        | 1/1   | 179   | 1,040  | 19          | 68                    | yes / yes                  | 146           |
| 5        | 1/1   | 179   | 1,040  | 19          | 68                    | yes / yes                  | 151           |
| 6        | 1/1   | 154   | 895    | 16          | 52                    | yes / yes                  | 115           |
| 7        | 1/1   | 179   | 1,040  | 19          | 68                    | yes / yes                  | 170           |
| 8        | 1/1   | 179   | 1,040  | 19          | 68                    | yes / yes                  | 198           |
| 9        | 1/1   | 179   | 1,040  | 19          | 68                    | yes / yes                  | 235           |

No divergence, no failures, `sourceUnchanged: true` on all nine.

### Verified genesis, real deck protocol: Fogbound scenario 1

[`chaos-fogbound-4p/scenario-1-verified.json`](chaos-fogbound-4p/scenario-1-verified.json): `node tools/sim/dist/index.js net --scenario 1 --seeds 1 --seed 42 --players 4 --security verified --map fogbound`. Four verified peers run the genuine genesis and deck ceremony (fog decks included) and play a Fogbound game with the explorer bots: 217 turns, 1,370 inputs, **21 fog reveals** drawn through the certified public-draw path, plus 46 ship builds, 26 ship moves, 22 pirate moves, 24 steals and a gold choice. All four seats' terminal audits reached `ok` and `complete` at the same final head (seq 1,370) with no cheat findings. It ran in 20.7 minutes (each audit about 166 s in the Node worker). `sourceUnchanged: true`.

The first attempt at this run failed with `genesis-config` from the fixture's audit; see the fixes below.

### Chaos suite on Open Sea 5–6, six peers

[`chaos-open-sea-56-6p/`](chaos-open-sea-56-6p/): `node tools/sim/dist/index.js net --scenario N --seeds 1 --seed 42 --players 6 --map open-sea-56` for scenarios 1 to 9. Open Sea 5–6 is the six-seat archipelago generated from the genesis seed, so every peer had to derive the same board. Stub security, real sessions, signatures, wire encoding and journals, as in stage 11's six-peer suite.

| Scenario | Games | Turns | Inputs | Ship builds and moves | Fault injected / recovered | Wall time (s) | Source unchanged |
| -------- | ----- | ----- | ------ | --------------------- | -------------------------- | ------------- | ---------------- |
| 1        | 1/1   | 168   | 2,053  | 80                    | no / no                    | 542           | yes              |
| 2        | 1/1   | 138   | 1,724  | 67                    | no / no                    | 5,355 ‡       | no ‡             |
| 3        | 1/1   | 111   | 1,333  | 45                    | yes / yes                  | 402           | yes              |
| 4        | 1/1   | 119   | 1,475  | 57                    | yes / yes                  | 463           | yes              |
| 5        | 1/1   | 125   | 1,490  | 51                    | yes / yes                  | 472           | yes              |
| 6        | 1/1   | 121   | 1,433  | 60                    | yes / yes                  | 397           | yes              |
| 7        | 1/1   | 131   | 1,662  | 47                    | yes / yes                  | 488           | yes              |
| 8        | 1/1   | 143   | 1,756  | 48                    | yes / yes                  | 543           | yes              |
| 9        | 1/1   | 106   | 1,342  | 48                    | yes / yes                  | 481           | yes              |

All nine completed without divergence or failures. Their games differ in length because each fault schedule changes the message order. ‡ Scenario 2 (latency, jitter and duplicated packets) took 89 minutes on the shared machine, against 8 minutes for the others (stage 11's six-peer run of this scenario was also the slowest, at 28 minutes). Its `sourceUnchanged` is `false` because I edited two test files under `tools/sim/src` while it ran; no engine, protocol or maps source changed. Because of the machine load, several runs shared the CPU (up to five single-thread network runs at once, about 300 MB each), which is more than the one-run-at-a-time limit for the 1,000-game simulations; the simulations themselves ran one at a time.

Fog does not exist on Open Sea, so the six-peer suite exercises ships, the pirate, gold, island bonuses and the generated board; the Fogbound runs above exercise fog.

## Final check

`npx vitest run tools/sim packages/engine` on 2026-09-29: 71 files, 506 tests passed. `packages/protocol/src/testing`: 7 files, 35 tests passed. `apps/web/src/features/online`: 22 files, 84 tests passed. `tsc -b` and the test-config typecheck are clean; lint and format are clean for the files I touched.

## Not met, and caveats

- The simulation ran 1,000 games per scenario, not 20,000 (the user's decision, above). Nothing else in the four criteria is short.
- The Fogbound browser game revealed one fog hex. The chaos and verified runs reveal 16 to 21 per game. The 12-point Fogbound target was not played through in a browser; the browser games used 7 and 8 points to stay within the audit deadline.
- Chaos scenarios 3 to 9 on Fogbound ran with stub security; only scenario 1 ran with verified security (the real deck ceremony). Six-seat games cannot run verified in this harness.
- The browser audit worker's 60-second deadline is close to the audit time for these games (44 and 49 seconds) and was missed once on a heavily loaded machine.

## Fixes made along the way

- `packages/protocol/src/testing/verified-network-audit.ts` audited with the base engine, so a verified network game on any scenario was refused with `genesis-config`. It now uses the catalogue engine, as the browser's audit worker does. The failing case was the first verified Fogbound run; `net` now says why a terminal audit failed.
- `createVerifiedNetworkFixture` takes an optional full genesis config so the verified harness can run a scenario (`tools/sim/src/verified-fixture-config.test.ts` checks that it commits the fog decks).
- The online screens now offer the seafaring scenarios, and `OnlineConfiguration` no longer rebuilds a base-only config over a scenario.
- No engine rule changed.

## Reproduce

```sh
pnpm sim run --scenario fogbound --players 4 --games 1000 --seed 1201 --parallel 4
pnpm sim run --scenario new-horizons-56 --players 6 --games 1000 --seed 1205 --parallel 4 --max-turns 3000
pnpm sim golden --update --seafaring
node tools/sim/dist/index.js net --scenario 1 --seeds 1 --seed 42 --players 4 --map fogbound
node tools/sim/dist/index.js net --scenario 1 --seeds 1 --seed 42 --players 4 --security verified --map fogbound
npx vitest run tools/sim/src/fog-deck-secrets.test.ts packages/engine/test/golden-seafaring.test.ts
```
