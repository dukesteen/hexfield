# Stage 16 acceptance evidence

Stage: [16 — Bots](../../16-bots.md). Dates are local time, 2026-09-29. Design decisions are in [DECISIONS](../../DECISIONS.md) ("Stage 16 bots — …").

## Deviations from the stage document

- **1,000 simulated games per level, not 10,000** (user decision). "No bot ever submits a rejected command" ran 1,000 games per level (Easy, Normal, Hard), 200 on each of five module sets, invariants on. Random bots already have their stage 04 evidence (100,000 games).
- **No physical phone.** "Hard bot decisions within budget on a mid-range phone" was measured in headless Chromium with DevTools CPU throttling at 4× and 6× as a proxy. It is recorded as a proxy, not a phone measurement.
- **Resource limits** (user request): every simulation and tournament ran with two worker processes, one run at a time, and waited while another agent's browser tests ran.

## Tournament thresholds met

`pnpm sim tournament --bots <levels> --games 2000 --seats-rotation`, four-player base games (balanced random maps), one bot of the stronger level against three of the weaker, seats rotated every game, invariants checked on every input. Hard uses the simulation iteration budget (`--iterations 6`, about what 300 ms buys on a desktop). The seeds (1600, 1602) were not used while tuning (7–21).

| Threshold (stage 16)           | Measured                                                             | Result |
| ------------------------------ | -------------------------------------------------------------------- | ------ |
| Easy beats Random ≥ 60%        | Easy won **85.5%** of 2,000 games against three Random bots          | met    |
| Normal ≥ 40% win share vs Easy | Normal won **42.5%** of 2,000 games against three Easy bots (SE 1.1) | met    |
| Hard ≥ 35% win share vs Normal | Hard won **43.2%** of 2,000 games against three Normal bots (SE 1.1) | met    |

Per level (win share = the level's wins over the games it played; with one seat of the stronger level the even-field baseline is 25%):

| Tournament                                       |     Games | Level  | Seats | Wins | Win share | Avg VP |  Elo | Avg length (turns) |
| ------------------------------------------------ | --------: | ------ | ----: | ---: | --------: | -----: | ---: | -----------------: |
| [easy vs random](tournament-easy-vs-random.json) | 2000/2000 | easy   |  2000 | 1711 |     85.5% |   9.69 | 1500 |               86.5 |
| [easy vs random](tournament-easy-vs-random.json) | 2000/2000 | random |  6000 |  289 |     14.4% |   4.76 | 1000 |               86.5 |
| [normal vs easy](tournament-normal-vs-easy.json) | 2000/2000 | normal |  2000 |  850 |     42.5% |   8.04 | 1000 |               76.3 |
| [normal vs easy](tournament-normal-vs-easy.json) | 2000/2000 | easy   |  6000 | 1150 |     57.5% |   6.70 |  862 |               76.3 |
| [hard vs normal](tournament-hard-vs-normal.json) | 2000/2000 | hard   |  2000 |  864 |     43.2% |   8.28 | 1000 |               72.4 |
| [hard vs normal](tournament-hard-vs-normal.json) | 2000/2000 | normal |  6000 | 1136 |     56.8% |   7.04 |  857 |               72.4 |
| [all levels](tournament-all-levels.json)         | 2000/2000 | easy   |  2000 |  367 |     18.4% |   6.63 | 1644 |               73.2 |
| [all levels](tournament-all-levels.json)         | 2000/2000 | normal |  2000 |  643 |     32.1% |   7.60 | 1742 |               73.2 |
| [all levels](tournament-all-levels.json)         | 2000/2000 | hard   |  2000 |  981 |     49.0% |   8.45 | 1815 |               73.2 |
| [all levels](tournament-all-levels.json)         | 2000/2000 | random |  2000 |    9 |      0.4% |   3.91 | 1000 |               73.2 |

Elo is a Bradley–Terry fit on the Elo scale (a win counts as beating every other seat of another level), anchored at 1000 for Random when it plays, otherwise for the first listed level; the [all-levels](tournament-all-levels.json) table is the one comparable scale. Game length is in turns (one turn per seat per round). No game failed, no bot fell back to a random move, and every run's source fingerprint was unchanged while it ran (`sourceUnchanged: true`, fingerprint `3b903b087066…`, commit 7366281).

Two later commits touched the bots package without changing simulated play: per-turn memory keyed by turn number instead of state identity (71321b4) and the wall-clock budget handling (170dcab; simulations use iteration budgets). Rerunning two tournaments on 71321b4 reproduced them exactly: [easy vs random](recheck-easy-vs-random.json) 1,711 / 289 wins and [normal vs easy](recheck-normal-vs-easy.json) 850 / 1,150 wins, the same average VP and turns.

## No bot ever submits a rejected command (1,000 games per level)

Each run seats four (five-six: six) bots of one level and plays 200 games with every public and private invariant checked on every input; a rejected command, a stall (500 turns, 2,000 inputs without a turn) or an invariant failure would fail the game. Hard plays with `--iterations 6`.

| Run                                                                         | Level  | Module set                               | Games finished | Failed | Fallback warnings | Avg turns |
| --------------------------------------------------------------------------- | ------ | ---------------------------------------- | -------------: | -----: | ----------------: | --------: |
| [legality-easy-base](legality-easy-base.json)                               | easy   | base                                     |        200/200 |      0 |                 0 |      78.7 |
| [legality-easy-five-six](legality-easy-five-six.json)                       | easy   | five-six (6 seats)                       |        200/200 |      0 |                 0 |      72.1 |
| [legality-easy-seafaring](legality-easy-seafaring.json)                     | easy   | seafaring (four-isles)                   |        200/200 |      0 |                 0 |      87.3 |
| [legality-easy-knights](legality-easy-knights.json)                         | easy   | knights                                  |        200/200 |      0 |                 0 |     113.9 |
| [legality-easy-seafaring-knights](legality-easy-seafaring-knights.json)     | easy   | seafaring + knights (four-isles-knights) |        200/200 |      0 |                 0 |     113.9 |
| [legality-normal-base](legality-normal-base.json)                           | normal | base                                     |        200/200 |      0 |                 0 |      71.3 |
| [legality-normal-five-six](legality-normal-five-six.json)                   | normal | five-six (6 seats)                       |        200/200 |      0 |                 0 |      65.6 |
| [legality-normal-seafaring](legality-normal-seafaring.json)                 | normal | seafaring (four-isles)                   |        200/200 |      0 |                 0 |      78.2 |
| [legality-normal-knights](legality-normal-knights.json)                     | normal | knights                                  |        200/200 |      0 |                 0 |     103.5 |
| [legality-normal-seafaring-knights](legality-normal-seafaring-knights.json) | normal | seafaring + knights                      |        200/200 |      0 |                 0 |     106.1 |
| [legality-hard-base](legality-hard-base.json)                               | hard   | base                                     |        200/200 |      0 |                 0 |      77.6 |
| [legality-hard-five-six](legality-hard-five-six.json)                       | hard   | five-six (6 seats)                       |        200/200 |      0 |                 0 |      76.0 |
| [legality-hard-seafaring](legality-hard-seafaring.json)                     | hard   | seafaring (four-isles)                   |        200/200 |      0 |                 0 |      83.2 |
| [legality-hard-knights](legality-hard-knights.json)                         | hard   | knights                                  |        200/200 |      0 |                 0 |     104.7 |
| [legality-hard-seafaring-knights](legality-hard-seafaring-knights.json)     | hard   | seafaring + knights                      |        200/200 |      0 |                 0 |     105.8 |

Totals: Easy 1,000/1,000, Normal 1,000/1,000, Hard 1,000/1,000 games finished, 0 rejected commands, 0 failures. The tournaments above add 8,000 more games (every level, invariants on) without a failure.

By construction, a heuristic decision is one of the seat's legal concrete commands or a command built from a legal template and checked with `engine.validate`; anything else falls back to the random bot, whose moves come from `enumerateCommands` (validated). Unit tests: `packages/bots/src/runtime/runtime.test.ts`, `packages/bots/src/search/search.test.ts`, `tools/sim/src/bot-honesty.test.ts` (every level plays a whole game), `tools/sim/src/bot-worker-boundary.test.ts`.

## Hard bot decisions within budget (Chromium CPU throttling as a phone proxy)

The Hard bot's budget is 150 ms per decision on a phone or tablet and 300 ms on a desktop (by user agent). Only the opening settlements and the robber are searched; every other decision is the heuristic alone.

`apps/web/dev/bot-timing.html` plays a whole base game with four Hard bots through the real bot host (the `decide` protocol, hosted trade settling, 150 ms budget) and records the host's time per decision. Headless Chromium (Playwright's Chromium 1243 headless shell, on an Apple silicon Mac) ran it with DevTools CPU throttling at 1×, 4× and 6×, two games each ([phone-proxy-inline.json](phone-proxy-inline.json)). DevTools throttling did not reach the dedicated bot worker (worker times did not change with the rate, [phone-proxy-worker.json](phone-proxy-worker.json)), so the throttled runs host the bots on the page's thread (`inline=1`), where it applies; a phone's worker thread runs at about the same speed as its main thread.

| CPU throttling | Game | Opening settlements (n, max ms) | Robber (n, max ms) | Other decisions, max ms |
| -------------- | ---- | ------------------------------- | ------------------ | ----------------------- |
| 1×             | 1    | 8, 122                          | 25, 128            | 0.4                     |
| 1×             | 2    | 8, 124                          | 21, 128            | 0.4                     |
| 4×             | 1    | 8, 124                          | 10, 125            | 2                       |
| 4×             | 2    | 8, 126                          | 28, 118            | 2                       |
| 6×             | 1    | 8, 139                          | 25, 125            | 4                       |
| 6×             | 2    | 8, 140                          | 10, 119            | 4                       |

Every decision stayed within the 150 ms budget (largest 140 ms at 6×). The search uses 85% of the budget from the start of the decision, predicts rollout cost so no rollout or iteration starts that cannot finish, aborts a rollout at the deadline, drops a partial iteration and falls back to the heuristic's move when no iteration fits (`packages/bots/src/search/hard-bot.ts`). Each game finished. **This is a proxy**: no physical phone was measured.

## Bots support every shipped module

Base, five-six, seafaring and knights and the seafaring+knights combination (frontier and explorers do not exist yet) are covered by the legality runs above: 3,000 games across the five module sets with **zero fallback warnings**, so every decision those games raised had a policy. Plugins: `packages/bots/src/plugins/seafaring.ts` (ship expansion toward ship-reachable sites, gold choice, pirate, setup road or ship, free ships) and `packages/bots/src/plugins/knights.ts` (now `plugins/knights-v1.ts`, kept frozen; see [Follow-up A](#follow-up-a-cities--knights)) (improvements with science first, knight recruiting and activation against the estimated barbarian arrival, walls, progress cards and deck choices, aqueduct, metropolis, pillage, Deserter, relocation, Wedding and Saboteur discards, Harbor replies). Any decision without a policy falls back to a random legal move and is reported through `DecideContext.warn`; the tournament output counts these per level (an earlier run surfaced the Deserter and knight relocation, which then got policies). `tools/sim/src/bot-modules.test.ts` plays each level on every module set in the unit suite.

## Other stage requirements

- **Runtime**: `packages/bots/src/runtime/` — `decide({ view, pending, legal?, timeBudgetMs?, iterationBudget? })`, `respondTrade`, `dispose`; one `BotHost` per bot host multiplexes its bots by key. In the browser it runs in a dedicated Web Worker (`apps/web/src/session/bot-worker.ts`): local games post from the page, online games from the protocol worker. The simulator's bots run inside its `worker_threads` batches.
- **Honesty**: `BotView = { state, priv, seat }`; `assertBotView`/`parseBotRequest` refuse any extra field or another seat's private state. `tools/sim/src/bot-honesty.test.ts` plays a whole game per level with views in which reading any absent field throws, and uses `@ts-expect-error` for the type-level check.
- **Seeded RNG**: online, `deriveBotSeed(master, { game, seat })` (HKDF label `bot`, `packages/crypto/src/derivation.ts`); simulations derive from the simulation seed; `search.test.ts` checks a decision replays from its seed.
- **Evaluation library**: `packages/bots/src/eval/` with `eval.test.ts` (pips, the known-board fixture where the obviously best vertex wins, complementing a first settlement, harbors, road distances, hand inference from bounds, turns-to-afford, trade values and a dangerous partner, robber targeting, discards).
- **Humanlike behaviour**: delays scaled by decision importance on top of the table's pace, trade replies in 1–3 s (`runtime/pace.ts`), Normal and Hard offer occasional 1:1 trades, settled by the existing hosted-bot trade flow.
- **UI**: difficulty per bot seat in the local setup (saved with the game) and in the online lobby (Easy, Normal, Hard; a bot's level can be changed); the player rail shows each bot's level and "Thinking" while it owes a move. `apps/web/tests/bot-difficulty.e2e.ts` (Chromium, one worker) picks Easy and Hard, sees the levels and the indicator, and sees the worker-hosted bots place their settlements; `bot-trade.e2e.ts` passes with random bots.

## Follow-up A: Cities & Knights

Dates are local time, 2026-09-29 to 2026-09-30. The plan is [16-bots.md, "Follow-up: stronger bots"](../../16-bots.md#follow-up-stronger-bots-planned-2026-09-29), part A. Decisions are in [DECISIONS](../../DECISIONS.md) ("Stage 16 follow-up A — …"). Every run below used the source at commit f38ecc8 (fingerprint `a62745ab0759…`, `sourceUnchanged: true`), invariants on, `--iterations 6`, at most five worker processes while the load average stayed below 8 (two otherwise), one run at a time.

The stage 16 knights policy is kept frozen as `packages/bots/src/plugins/knights-v1.ts`. The simulator's benchmark levels `hard-v1` and `normal-v1` play it (they are never offered in a game). Easy plays it too. Normal and Hard play the new policy in `packages/bots/src/plugins/knights/`.

### How each item was measured

Each item was switched on alone and played in one seat against three bots with the policy before it (seats rotated), 400 games per seed, two seeds on `knights` and two on `four-isles-knights` (the seafaring + knights scenario), without invariant checks. An item was kept when it gained clearly more than the noise (a win share of 25% means no change; the standard error over 3,200 games is 0.8 points). Tuning seeds were 3001–3062; the final runs below use seeds never used for tuning (1701–1704).

| Item                  | Against             | Games | Win share | Kept |
| --------------------- | ------------------- | ----: | --------: | ---- |
| 1. Progress cards     | stage 16 Hard       | 1,600 |     32.6% | yes  |
| 2. Barbarian planning | Hard with item 1    | 3,200 |     27.3% | yes  |
| 3. Metropolis race    | Hard with items 1–2 | 3,200 |     27.8% | yes  |
| 4. Active knights     | Hard with items 1–3 | 3,200 |     25.3% | no   |
| 5. City walls by hand | Hard with items 1–3 | 3,200 |     26.2% | no   |

Variants that were tried and dropped along the way: activating only when the attack is likely next round (22.7%), also keeping wool and ore for a recruit (fewer cities lost, 0.83 against 1.09 per game, and more Defender points, but fewer cities and improvements overall: 23.5% of 200 games), per-kind commodity values in the hand score (neutral), up to three bank trades for a metropolis (neutral).

### Final comparison (2,000 games each)

`pnpm sim tournament --bots hard,hard-v1,hard-v1,hard-v1 --games 2000 --seats-rotation --iterations 6 --scenario <id>`; with one seat of the new level the even-field baseline is 25%.

| Tournament                                                                                | Games     | Level     | Seats | Wins | Win share | Avg VP |  Elo | Avg turns |
| ----------------------------------------------------------------------------------------- | --------- | --------- | ----: | ---: | --------: | -----: | ---: | --------: |
| [hard vs hard-v1, knights](followup-a-hard-vs-hard-v1-knights.json)                       | 2000/2000 | hard      |  2000 |  789 | **39.5%** |   9.91 | 1000 |      99.6 |
| [hard vs hard-v1, knights](followup-a-hard-vs-hard-v1-knights.json)                       | 2000/2000 | hard-v1   |  6000 | 1211 |     60.6% |   8.53 |  884 |      99.6 |
| [hard vs hard-v1, four-isles-knights](followup-a-hard-vs-hard-v1-four-isles-knights.json) | 2000/2000 | hard      |  2000 |  765 | **38.3%** |  10.76 | 1000 |      99.4 |
| [hard vs hard-v1, four-isles-knights](followup-a-hard-vs-hard-v1-four-isles-knights.json) | 2000/2000 | hard-v1   |  6000 | 1235 |     61.8% |   9.38 |  892 |      99.4 |
| [normal vs normal-v1, knights](followup-a-normal-vs-normal-v1-knights.json)               | 2000/2000 | normal    |  2000 |  755 | **37.8%** |   9.73 | 1000 |      99.6 |
| [normal vs normal-v1, knights](followup-a-normal-vs-normal-v1-knights.json)               | 2000/2000 | normal-v1 |  6000 | 1245 |     62.3% |   8.47 |  896 |      99.6 |

The new Hard wins 39.5% and 38.3% (standard error 1.1) where the stage 16 Hard would win 25%; Normal gains about as much. Games between four new Hard bots are shorter (94.7 turns on knights in the legality run below, 104.7 in stage 16).

### Nothing regressed in the base game

The knights policy runs only in knights games, and base and seafaring games take no path it changed. The three threshold tournaments rerun on the stage 16 seed (1600) reproduce the recorded results exactly:

| Threshold (stage 16)           | Rerun                                                             | Result                     |
| ------------------------------ | ----------------------------------------------------------------- | -------------------------- |
| Easy beats Random ≥ 60%        | [85.5%](followup-a-recheck-easy-vs-random.json), 1,711/2,000 wins | met, identical to stage 16 |
| Normal ≥ 40% win share vs Easy | [42.5%](followup-a-recheck-normal-vs-easy.json), 850/2,000 wins   | met, identical to stage 16 |
| Hard ≥ 35% win share vs Normal | [43.2%](followup-a-recheck-hard-vs-normal.json), 864/2,000 wins   | met, identical to stage 16 |

Average VP and turns also match the stage 16 tables (9.69/4.76 and 86.5; 8.04/6.70 and 76.3; 8.28/7.04 and 72.4).

### Legality on knights and seafaring + knights (200 games per level)

Four bots of one level, invariants on, seed 1704.

| Run                                                                                      | Level  | Scenario           | Games finished | Failed | Fallback warnings | Avg turns |
| ---------------------------------------------------------------------------------------- | ------ | ------------------ | -------------: | -----: | ----------------: | --------: |
| [legality-easy-knights](followup-a-legality-easy-knights.json)                           | easy   | knights            |        200/200 |      0 |                 0 |     113.1 |
| [legality-easy-four-isles-knights](followup-a-legality-easy-four-isles-knights.json)     | easy   | four-isles-knights |        200/200 |      0 |                 0 |     114.3 |
| [legality-normal-knights](followup-a-legality-normal-knights.json)                       | normal | knights            |        200/200 |      0 |                 0 |      98.0 |
| [legality-normal-four-isles-knights](followup-a-legality-normal-four-isles-knights.json) | normal | four-isles-knights |        200/200 |      0 |                 0 |      97.1 |
| [legality-hard-knights](followup-a-legality-hard-knights.json)                           | hard   | knights            |        200/200 |      0 |                 0 |      94.7 |
| [legality-hard-four-isles-knights](followup-a-legality-hard-four-isles-knights.json)     | hard   | four-isles-knights |        200/200 |      0 |                 0 |      92.5 |

No rejected command, no failure and no fallback warning; the final comparisons add 6,000 more knights games without one. A tuning run surfaced a free-road frame that offers only `SKIP` (a Road Building card with no road left to place); the policy now answers it.

Unit tests: `packages/bots/src/plugins/knights/knights-policy.test.ts` (the attack chance, activating a turn ahead, the metropolis purchase before a city and the bank trade for a missing commodity, the Alchemist on the best number, the progress discard, the Merchant).

## Follow-up B: all modes

Dates are local time, 2026-09-30. The plan is [16-bots.md, "Follow-up: stronger bots"](../../16-bots.md#follow-up-stronger-bots-planned-2026-09-29), part B (items 6–8). Decisions are in [DECISIONS](../../DECISIONS.md) ("Stage 16 follow-up B — …"). Every final run below used the source at one fingerprint (`61578736319c…`, `sourceUnchanged: true`), invariants on, `--iterations 6`, at most five worker processes while the load average stayed below 8 (two otherwise), one run at a time. Tuning seeds were 5001–5304; the final runs use seeds never used for tuning (1801–1809).

The follow-up A levels are frozen as the simulator's benchmark levels `hard-v2` and `normal-v2` (never offered in a game). Easy is unchanged.

### How each item was measured

One seat of the candidate against three bots of the version before it (five on five-six), seats rotated, 400-game batches, invariants off. "Of expected" is the candidate's wins divided by an equal bot's expected wins (a quarter of the games, a sixth on five-six), so 1.00 is no change; its standard error over 3,200 games is about 0.03. The heuristic items (6, 7) ran with `--iterations 0` (heuristic only, on both sides), the search items with `--iterations 6`.

| Item                                                           | Games                                    | Result (of expected, or win share)                                    | Kept                          |
| -------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------- | ----------------------------- |
| 6. Tuning, base weights (21 parameters, coordinate search)     | 43 × 3,200, base + five-six              | all 0.95–1.03; the one accepted change 1.05 and 0.97 on fresh seeds   | no                            |
| 6. Tuning, knights values (9 parameters)                       | 18 × 3,200, knights + four-isles-knights | two changes accepted (1.07 on the tuning seeds), 0.996 on fresh seeds | no                            |
| 7. Endgame awareness, all parts                                | 6,400, base + five-six                   | 1.02                                                                  | no                            |
| 7. Robber focus / trade refusal / road block alone             | 4,800 each                               | 1.00 / 1.00 / 1.00                                                    | no                            |
| 8. Main-phase lookahead with a leaf evaluation (7 variants)    | 1,600 each, base + five-six              | 0.15–0.99                                                             | no                            |
| 8. Search with module chance nodes, knights                    | 800                                      | 32.1% (1.28)                                                          | yes                           |
| 8. Same, four-isles-knights                                    | 800                                      | 47.3% (1.89)                                                          | yes                           |
| 8. Same, four-isles                                            | 800                                      | 43.0% (1.72)                                                          | yes                           |
| 8. Same, fogbound                                              | 800                                      | 20.1% (0.81)                                                          | no: fog maps are not searched |
| 8. Knights: opening search only / robber search only           | 800 each                                 | 1.23 / 1.02                                                           | the opening only              |
| 8. Separate dice streams in base (against the stage 16 search) | 800 each                                 | 0.94 (0.93 without the robber search)                                 | no: base keeps stage 16       |

Profiles of Hard's search (base and knights) put event generation under 0.1% of the search time (the rollout policy's planning, legal-command listing and validation take most of it), so a sim-mode apply without events was not built: it could not measurably help.

### Final comparison (2,000 games each)

`pnpm sim tournament --bots hard,hard-v2,hard-v2,hard-v2 --games 2000 --seats-rotation --iterations 6 [--scenario <id>]` (five-six: five `hard-v2`); with one seat of the new level the even-field baseline is 25% (16.7% on five-six).

| Tournament                                                                            | Games     | Level     |  Seats |  Wins | Win share | Avg VP |  Elo | Avg turns |
| ------------------------------------------------------------------------------------- | --------- | --------- | -----: | ----: | --------: | -----: | ---: | --------: |
| [hard vs hard-v2, base](followup-b-hard-vs-hard-v2-base.json)                         | 2000/2000 | hard      |  2,000 |   504 | **25.2%** |   7.36 | 1000 |      77.3 |
| [hard vs hard-v2, base](followup-b-hard-vs-hard-v2-base.json)                         | 2000/2000 | hard-v2   |  6,000 | 1,496 |     74.8% |   7.38 |  998 |      77.3 |
| [hard vs hard-v2, five-six (6 seats)](followup-b-hard-vs-hard-v2-five-six.json)       | 2000/2000 | hard      |  2,000 |   359 | **17.9%** |   7.02 | 1000 |      77.0 |
| [hard vs hard-v2, five-six (6 seats)](followup-b-hard-vs-hard-v2-five-six.json)       | 2000/2000 | hard-v2   | 10,000 | 1,641 |     82.0% |   6.91 |  984 |      77.0 |
| [hard vs hard-v2, knights](followup-b-hard-vs-hard-v2-knights.json)                   | 2000/2000 | hard      |  2,000 |   624 | **31.2%** |   9.48 | 1000 |      94.1 |
| [hard vs hard-v2, knights](followup-b-hard-vs-hard-v2-knights.json)                   | 2000/2000 | hard-v2   |  6,000 | 1,376 |     68.8% |   8.72 |  947 |      94.1 |
| [hard vs hard-v2, four-isles (seafaring)](followup-b-hard-vs-hard-v2-four-isles.json) | 2000/2000 | hard      |  2,000 |   843 | **42.1%** |  10.87 | 1000 |      85.4 |
| [hard vs hard-v2, four-isles (seafaring)](followup-b-hard-vs-hard-v2-four-isles.json) | 2000/2000 | hard-v2   |  6,000 | 1,157 |     57.9% |   9.15 |  864 |      85.4 |
| [normal vs normal-v2, base](followup-b-normal-vs-normal-v2-base.json)                 | 2000/2000 | normal    |  2,000 |   501 | **25.1%** |   7.36 | 1000 |      72.1 |
| [normal vs normal-v2, base](followup-b-normal-vs-normal-v2-base.json)                 | 2000/2000 | normal-v2 |  6,000 | 1,499 |     75.0% |   7.36 | 1000 |      72.1 |

The new Hard is the follow-up A heuristic with its opening search now running in expansion games, so it gains where that search runs: 31.2% of knights games and 42.1% of four-isles games (standard error 1.0–1.1) where no change would be 25%. In base and five-six it plays as `hard-v2` does (25.2%, and 17.9% against 16.7%, both within noise), and Normal is unchanged (25.1%): no base-game change measured as an improvement, so none was kept.

### The stage 16 thresholds still hold

Fresh seeds 1806–1808, four-player base games, invariants on.

| Threshold (stage 16)           | Measured                                                                          | Result |
| ------------------------------ | --------------------------------------------------------------------------------- | ------ |
| Easy beats Random ≥ 60%        | [86.3%](followup-b-easy-vs-random.json), 1,725/2,000 wins (avg VP 9.71 vs 4.75)   | met    |
| Normal ≥ 40% win share vs Easy | [43.0%](followup-b-normal-vs-easy.json), 860/2,000 wins (SE 1.1, Elo 1000 vs 858) | met    |
| Hard ≥ 35% win share vs Normal | [41.3%](followup-b-hard-vs-normal.json), 826/2,000 wins (SE 1.1, Elo 1000 vs 870) | met    |

The levels stay distinct and ordered: Easy is the weakest bot, Normal beats Easy and Hard beats Normal.

### Legality (200 games per level and module set)

Four bots of one level (six on five-six), invariants on, seed 1809.

| Run                                                                                      | Level  | Module set                               | Games finished | Failed | Fallback warnings | Avg turns |
| ---------------------------------------------------------------------------------------- | ------ | ---------------------------------------- | -------------: | -----: | ----------------: | --------: |
| [legality-easy-base](followup-b-legality-easy-base.json)                                 | easy   | base                                     |        200/200 |      0 |                 0 |      79.4 |
| [legality-easy-five-six](followup-b-legality-easy-five-six.json)                         | easy   | five-six (6 seats)                       |        200/200 |      0 |                 0 |      73.4 |
| [legality-easy-knights](followup-b-legality-easy-knights.json)                           | easy   | knights                                  |        200/200 |      0 |                 0 |     115.7 |
| [legality-easy-four-isles](followup-b-legality-easy-four-isles.json)                     | easy   | seafaring (four-isles)                   |        200/200 |      0 |                 0 |      86.2 |
| [legality-easy-four-isles-knights](followup-b-legality-easy-four-isles-knights.json)     | easy   | seafaring + knights (four-isles-knights) |        200/200 |      0 |                 0 |     117.1 |
| [legality-normal-base](followup-b-legality-normal-base.json)                             | normal | base                                     |        200/200 |      0 |                 0 |      73.6 |
| [legality-normal-five-six](followup-b-legality-normal-five-six.json)                     | normal | five-six (6 seats)                       |        200/200 |      0 |                 0 |      65.8 |
| [legality-normal-knights](followup-b-legality-normal-knights.json)                       | normal | knights                                  |        200/200 |      0 |                 0 |      95.3 |
| [legality-normal-four-isles](followup-b-legality-normal-four-isles.json)                 | normal | seafaring (four-isles)                   |        200/200 |      0 |                 0 |      78.6 |
| [legality-normal-four-isles-knights](followup-b-legality-normal-four-isles-knights.json) | normal | seafaring + knights (four-isles-knights) |        200/200 |      0 |                 0 |      93.0 |
| [legality-hard-base](followup-b-legality-hard-base.json)                                 | hard   | base                                     |        200/200 |      0 |                 0 |      76.8 |
| [legality-hard-five-six](followup-b-legality-hard-five-six.json)                         | hard   | five-six (6 seats)                       |        200/200 |      0 |                 0 |      74.8 |
| [legality-hard-knights](followup-b-legality-hard-knights.json)                           | hard   | knights                                  |        200/200 |      0 |                 0 |      96.5 |
| [legality-hard-four-isles](followup-b-legality-hard-four-isles.json)                     | hard   | seafaring (four-isles)                   |        200/200 |      0 |                 0 |      87.0 |
| [legality-hard-four-isles-knights](followup-b-legality-hard-four-isles-knights.json)     | hard   | seafaring + knights (four-isles-knights) |        200/200 |      0 |                 0 |      96.4 |

3,000 games with no rejected command, no failure and no fallback warning; the final comparisons add 16,000 more games without one.

### Hard's phone budget (Chromium CPU throttling as a proxy)

Re-measured as in stage 16 (`apps/web/dev/bot-timing.html`, which now takes `?scenario=<id>`; four Hard bots, the real bot host, a 150 ms budget, headless Chromium with DevTools CPU throttling, bots on the page's thread), two games per rate on base and on knights, where Hard now searches its openings: [base](followup-b-phone-proxy-base.json), [knights](followup-b-phone-proxy-knights.json). Each cell gives both games.

| Game    | CPU throttling | Opening settlements (n, max ms) | Robber (n, max ms)     | Other decisions, max ms |
| ------- | -------------- | ------------------------------- | ---------------------- | ----------------------- |
| base    | 1×             | 8, 120 / 8, 125                 | 23, 127 / 26, 128      | 0.4                     |
| base    | 4×             | 8, 122 / 8, 123                 | 18, 128 / 24, 127      | 2.2                     |
| base    | 6×             | 8, 136 / 8, 138                 | 12, 129 / 14, 124      | 2.8                     |
| knights | 1×             | 8, 112 / 8, 125                 | not searched (max 0.2) | 1.8                     |
| knights | 4×             | 8, 134 / 8, 135                 | not searched (max 1)   | 4.4                     |
| knights | 6×             | 8, 139 / 8, 141                 | not searched (max 2)   | 15.8                    |

Every decision stayed within the 150 ms budget (largest 141 ms, a knights opening at 6×). Knights rollouts cost more than base ones, so on a slow phone fewer iterations fit in the budget than the simulator's six; the search's gain was measured with the simulator's iteration budget, not on a phone. **This is a proxy**: no physical phone was measured.

Unit tests: `packages/bots/src/search/chance.test.ts` (a knights rollout answers the event die, progress draws and reveals for 40 turns; the dice stream does not depend on the draws), `packages/bots/src/search/search.test.ts` (Hard searches its knights opening, legally and reproducibly; the stage 16 settings do not), `packages/bots/src/levels.test.ts` (the benchmark levels, and parameter overrides refusing unknown or mistyped parameters).
