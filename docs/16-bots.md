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
