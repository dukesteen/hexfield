# 16 — Bots

## Goal

Bots that are fun to play against at several difficulty levels, run fully in the browser (Web Workers), never cheat (they use only their seat's view), and support every module. Also a tournament harness to measure strength.

## Prerequisites

Stage 11 for base/five-six bots. The module-specific heuristics come after their modules (12–15).

## Levels

| Level | Name   | Approach                                                                                          |
| ----- | ------ | ------------------------------------------------------------------------------------------------- |
| 0     | Random | stage 04 RandomBot                                                                                |
| 1     | Easy   | Greedy: builds whatever it can afford, prioritising VP; simple placement; accepts fair-ish trades |
| 2     | Normal | Heuristic: placement evaluation, a resource plan, trade evaluation, robber targeting              |
| 3     | Hard   | Heuristic + determinized Monte Carlo search (ISMCTS) at key decisions within a time budget        |

## 1. Bot runtime

- Bots run in a dedicated **Web Worker** (one worker per bot host, multiplexing its bots) in the browser, and in `worker_threads` in the simulator.
- Message API: `decide({ view, pending, legal, timeBudgetMs }) → command` and `respondTrade(...)`.
- Bots get a `BotView` = public state + their own `PrivateState` only (enforced by type and by the worker boundary: only these are posted).
- Bot randomness: a seeded bot RNG (seeded from its master secret via HKDF, label `bot`), so bot play is reproducible for audits and debugging.
- A deterministic time budget: in simulations, use an iteration budget rather than wall time, for reproducibility.

## 2. Shared evaluation library (`packages/bots/src/eval/`)

- **Pip values**: the probability weights of numbers (2:1 … 6:5, 8:5 … 12:1).
- **Vertex score**: the sum of pips per resource, weighted by the current resource need; bonuses for diversity, harbor synergy (a 2:1 harbor on a high-production resource), blocking the best spots of opponents, and expansion potential (reachable good vertices within 2 roads).
- **Hand inference for opponents**: from public bounds plus event tracking (with the bounds as the base), estimate each opponent's likely hand (a uniform distribution over hands consistent with the bounds, refined by observed trades/builds). Used for robber targeting, monopoly timing and determinization.
- **Plan evaluation**: estimate turns-to-afford for each build goal given expected production per turn. Pick the goal that maximises VP gain per expected turn, with a strategic bias (city vs expansion vs dev cards).
- **Trade evaluation**: the value of a resource = its marginal reduction in turns-to-goal. Accept a trade if own gain > threshold and the partner's gain isn't dangerous (e.g. never trade with a player at VP ≥ target − 2 unless hugely favourable).
- **Robber**: target the hex maximising (the leader's production loss × leader weight) − own loss; steal from the leader or the player with the most cards.
- **Discard**: keep the cards closest to completing the current goal.

## 3. Hard bot: ISMCTS

- **Determinization**: sample opponents' hidden hands consistent with the bounds and inference, and sample the unknown deck order from the remaining card composition. Dice outcomes are chance nodes (sampled).
- Decisions searched: setup placements, main-phase build sequences (a macro-action "build X" instead of low-level commands), robber placement, and dev card use. Trades use the heuristic only.
- Rollout policy = the Easy/Normal heuristic (fast). Budget: e.g. 300 ms per decision on desktop, 150 ms on mobile.
- The engine must be fast enough; profile `apply` in the worker. Consider a lightweight "sim-mode" apply that skips event generation (same code path with an `emitEvents: false` flag).

## 4. Module-specific heuristics

Add per-module evaluation plugins:

- `seafaring`: ship expansion to islands, gold choice, pirate usage.
- `knights`: improvement track priorities (science early for the aqueduct, etc.), knight activation before the barbarians arrive (estimate the attack timing), progress card play policies.
- `frontier`/`explorers`: basic policies per scenario, falling back to Random for unsupported decisions (logged).

## 5. Humanlike behaviour

- Delays scaled by decision importance.
- Chat emotes (optional, off by default).
- Trade offers: Normal+ bots propose reasonable trades to humans occasionally, and respond within 1–3 s.
- Difficulty honesty: bots **never** read hidden information. Add a test that runs a bot with a `BotView` whose opponent-private data is structurally absent (so any accidental access fails at type level and at runtime).

## 6. Tournament harness

`pnpm sim tournament --bots easy,normal,hard,random --games 2000 --seats-rotation`:

- Rotates seat positions for fairness; reports win rates, average VP, average game length; computes Elo/TrueSkill.
- Acceptance thresholds, measured in 4-player games with rotation:
  - Easy beats Random ≥ 60%.
  - Normal beats Easy ≥ 40% win share (vs the 25% baseline).
  - Hard beats Normal ≥ 35% win share.
- Save the results in STATUS.md per version.

## Steps

1. The worker runtime + message protocol + seeded bot RNG.
2. The evaluation library with unit tests (known-board fixtures: the best setup vertex is the obviously best one).
3. Easy bot. 4. Normal bot. 5. Tournament harness. 6. Hard bot (ISMCTS). 7. Module plugins. 8. UI: difficulty picker in the lobby and local setup; a "bot thinking" indicator.

## Acceptance criteria

- [ ] Tournament thresholds met.
- [ ] Hard bot decisions within budget on a mid-range phone (measured).
- [ ] No bot ever submits a rejected command in 10k simulated games per level.
- [ ] Bots support every shipped module (with at least Random fallback for any unsupported decision, logged as a warning).

## Follow-up: stronger bots (planned 2026-09-29)

The first implementation met the thresholds, but its evidence ([acceptance](verification/stage16/acceptance.md)) showed where Hard is weak: its edge comes almost entirely from heuristics, the search adds little (main-phase search was switched off because it made the bot weaker), Hard does not search in expansion games, and knights progress cards are played at random. The follow-up work, in order:

### A. Cities & Knights (first)

Done 2026-09-30 ([evidence](verification/stage16/acceptance.md#follow-up-a-cities--knights)): the new Hard wins 39.5% of 2,000 knights games and 38.3% of 2,000 four-isles-knights games against three stage 16 Hard bots (25% would be no change).

1. **A policy per progress card** (replaces random play). Examples: Saboteur when opponents' public card counts are high; Spy and Master Merchant against the leader or the largest hand; Warlord just before a barbarian attack; Bishop on the leader's best hex; Diplomat to break the leader's longest road; Alchemist to hit the bot's own best numbers and avoid a 7; Irrigation/Mining only with at least two matching hexes; Merchant on the bot's strongest resource; Wedding when behind; discard the weakest card over the hand limit. **Done (kept, +7.6 points of win share against three stage 16 Hard bots over 1,600 tuning games).**
2. **Barbarian planning.** Estimate the attack turn from the track position (a ship face comes up on half of all rolls). Keep enough active knight strength not to lose a city and, where cheap, to win the Defender point; let an attack succeed when the bot is safe and opponents are not; activate knights a turn ahead instead of reacting. **Done (kept, +2.3 points over the previous step, 3,200 games).** Keeping wool and ore for a recruit as well as grain cost more cities than it saved and was dropped.
3. **Metropolis race.** Choose improvement tracks by the commodities the bot's cities produce (paper from forest, cloth from pasture, coin from mountains), aim to reach level 4 first, push to 5 to take a metropolis held at 4, and value the level-3 abilities (Aqueduct, Trading House) early. **Done (kept, +2.8 points, 3,200 games).** Per-kind commodity values in the hand score measured neutral and were dropped; the race itself (purchase first, bank trades for a missing commodity) is what helped.
4. **Active knights.** Displace opponents' knights that block expansion, chase the robber off own hexes, park knights on contested building spots or across the leader's longest road. **Tried, not kept**: displacing, parking on contested sites or the leader's road and matching recruit sites measured neutral (25.3% of 3,200 games against 25% for no change). Knights still chase the robber when the attack does not need them.
5. **City walls** once the bot's hand regularly exceeds the limit. **Tried, not kept**: walls by the expected hand against the limit measured neutral (26.2% of 3,200 games); walls keep the stage 16 rule.

### B. All modes

6. **Self-play weight tuning.** Tune the heuristic weights with the tournament harness (small batches of 200–400 games, at most two processes, never alongside a browser run), keeping the final acceptance tournaments on seeds never used while tuning.
7. **Endgame awareness.** Detect a rival close to winning and focus the robber, trade refusals and road blocking on them; count hidden victory points when deciding to claim.
8. **Search that pays off.** A faster sim-mode apply without event generation, a leaf evaluation (VP plus expected production) instead of full rollouts, shallow lookahead over macro-actions, and chance nodes for module decks and the knights event die so search works in expansion games.

### Measuring

Each step is measured with the tournament harness before it is kept: knights games (`--scenario knights` and a seafaring-with-knights scenario) for part A, base and five-six for part B, 2,000 games per final comparison on fresh seeds. Record the new numbers in [the stage 16 acceptance](verification/stage16/acceptance.md) and STATUS. A change that does not measurably help is not kept.
