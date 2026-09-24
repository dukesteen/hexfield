# 04 — Simulation & Rule Testing

## Goal

Prove the engine correct at scale before any UI or networking exists:

- a legal-move enumerator,
- a `RandomBot`,
- a headless simulator CLI,
- invariant checking after every input,
- fuzzing of invalid inputs,
- golden replay files that lock behaviour down across refactors.

## Prerequisites

Stage 03 is complete.

## Deliverables

```
packages/engine/src/core/enumerate.ts     expand LegalCommandSet templates into concrete commands
packages/bots/src/random-bot.ts
packages/bots/src/types.ts                Bot interface (used again in stage 16)
tools/sim/src/cli.ts                      `pnpm sim ...`
tools/sim/src/run-game.ts
tools/sim/src/fuzz.ts
packages/engine/test/golden/*.replay.json
packages/engine/test/golden.test.ts
```

## 1. Enumerating legal commands

- `enumerateCommands(engine, state, seat, priv, opts)` uses the supplied engine's module registry:
  - discrete sets (placements, robber hexes, victims, card plays) are returned in full;
  - templates are expanded with caps:
    - **Discard**: all multisets of size k drawn from the private hand, capped at `opts.maxDiscardOptions` (default 50, sampled deterministically by the bot RNG when the space is larger).
      The sampler is injected through `opts`; enumeration never imports the genesis RNG or generates randomness itself.
    - **Maritime trade**: every single-unit trade (give one rate-sized group, get 1).
    - **Player trade offers**: a small curated set (1-for-1 and 2-for-1 of each resource pair), capped.
    - **Year of plenty**: all 15 resource pairs. **Monopoly**: 5.
- **Consistency property**: every enumerated command must pass `validate`. Property-test this over thousands of random states produced by the simulator.
- **Completeness property**: for discrete placement commands, brute-force every vertex/edge on the board through `validate`. The set that passes must equal the enumerated set.

## 2. Bot interface

```ts
interface Bot {
  id: string;
  // Given only what this seat may know:
  decide(view: BotView, pending: Pending, rng: BotRng): Command;
  respondToTrade?(view: BotView, offer: TradeOffer, rng: BotRng): boolean;
}
interface BotView {
  state: GameState;
  priv: PrivateState;
  seat: Seat;
} // never other seats' PrivateState
```

`RandomBot` groups enumerated commands by action type, chooses a weighted group, then chooses randomly among its preferred moves. It favors productive settlement sites and affordable buildings, trades toward a feasible build cost, and preserves saved resources when discarding. It limits repeated offers and accepts trades with probability 0.3. These choices use the public board and that bot's own private hand.

`BotRng` is seeded per bot and per game. It's the bot's own randomness, separate from the game's randomness.

## 3. Simulator

`pnpm sim run --games 10000 --players 4 --seed 42 --options '{...}' --modules base [--bots random,random,...] [--parallel 8]`

- Uses `LocalGame` (omniscient) with a seeded `LocalRandomSource`, so every game is reproducible from `(simSeed, gameIndex)`.
- After **every** input: run all module `invariants`, plus core invariants:
  - card conservation (bank + hands + discarded/decks = total, per kind),
  - true hands lie inside the public bounds,
  - piece counts on board + supply = limits,
  - `getPending(state)` is non-empty until `result` is set,
  - `apply` is non-mutating (enable in a sampled 1% of steps, because deep freeze is slow),
  - state encodes canonically (no floats or undefined), checked every 100 steps.
- Detects **dead games** (turn number > 500, or 2,000 inputs without a turn change) and reports them.
- Outputs summary stats:
  - average game length in turns,
  - win distribution by seat,
  - distribution of dice results (should match 2d6),
  - frequency of each command type,
  - % of games decided by the Longest Road / Largest Army swing,
  - errors with repro command lines.
- On any failure it writes `failures/<seed>-<game>.replay.json` containing the config, genesis seed and full input list, and prints the command to reproduce it: `pnpm sim replay failures/...`.
- Parallelism via `worker_threads`.

## 4. Fuzzing invalid inputs

`pnpm sim fuzz --iterations 1e6`:

- During random games, before each real input, generate K random _mutations_: random command types, out-of-range ids, wrong seats, negative counts, huge counts, extra fields, missing fields, and system inputs that don't match a pending.
- For each mutation, assert `validate` returns `{ ok: false }` **without throwing**, and that the state is unchanged.
- Also, as a property test, fuzz random valid-looking commands (right type, random params) and check that whatever `validate` accepts keeps all invariants when applied.
- Extra-field mutations add an undeclared key, including inside nested card parameters. Missing-field mutations remove a required field. Omitting optional `to` or `card`, or including explicit zero resource counts, is not inherently invalid: exercise those in the valid-looking path. All base handlers declare their allowed keys; report counts by mutation family and do not skip accepted mutants that were classified as invalid.

## 5. Golden replays

- The replay format (also reused by stages 06, 10 and 17):
  ```json
  { "format": "cp2p-replay", "version": 1, "engineVersion": "x.y.z",
    "config": {...}, "genesisSeed": "<base64url>",
    "inputs": [ {...}, ... ],
    "checkpoints": [ { "index": 120, "stateHash": "<hex>" }, ... ] }
  ```
- Commit ~20 golden replays covering: a normal game, a win by longest road, a win by largest army, a hidden VP win, bank shortage, friendly robber, balanced dice, all dev cards, road building with no legal spot, and so on.
- `golden.test.ts` replays each one and compares every checkpoint hash. **Any rules change that alters a hash must bump `engineVersion`** and regenerate goldens intentionally (`pnpm sim golden --update`), with an entry in DECISIONS.md.

## 6. Performance budget

- A 4-player RandomBot game: < 30 ms average in Node on a modern laptop (excluding invariant checks). `apply` p99 < 0.5 ms.
- Add a `pnpm sim bench` command and record the baseline in STATUS.md.
- Time the full single-worker game, including bot decisions, validation, private updates and LocalGame bookkeeping. Warmup games are separate. Report the invariant setting and machine details; parallel throughput is not single-game latency. LocalGame invariant diagnostics are enabled by default and remain enabled for simulation acceptance runs.

## Steps

1. Implement the enumerator and its consistency and completeness property tests.
2. Bot interface + RandomBot.
3. Simulator runner with invariant checking and failure replay output.
4. Worker-thread parallelism and stats reporting.
5. Fuzzer.
6. Golden replay tooling + initial goldens.
7. Bench command + performance fixes (typical hotspots: longest road recomputation, cloning; use structural sharing and only copy the changed branches).
8. Add a CI job: 2,000 simulated games + 50k fuzz iterations on each PR (< 3 min); 100k games nightly.

## Acceptance criteria

- [ ] 100,000 random 4-player games (and 10,000 3-player games) complete with zero invariant violations and zero dead games.
- [ ] 1,000,000 fuzz mutations, zero throws, zero accepted-invalid inputs.
- [ ] The dice distribution over all simulated rolls matches 2d6 within statistical tolerance (chi-square p > 0.001).
- [ ] Golden replays pass. CI runs sim + fuzz on each PR.
- [ ] Performance budget met.
