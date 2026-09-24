# 14 — Frontier Scenarios Module (`frontier`)

## Goal

Implement a collection of smaller scenarios and variants in the style of the "traders and barbarians" family, each as a small `scenario:<id>` module on top of `base` (some also combine with `five-six` or `knights`). Each scenario is independent: ship them one at a time.

## Prerequisites

Stage 13 is complete (the framework has been proven on a large module). The knights-based scenarios need `knights`.

## Process for every scenario

The plan author's knowledge of these rules is incomplete, so every scenario follows this process:

1. **Rules first**: write `docs/rules/frontier-<id>.md` with the complete rules, resolved against the official rules. List every component, cost, placement rule, VP source and edge case. Mark anything uncertain in DECISIONS.md with the interpretation you chose.
2. Define new state, commands, system inputs, pendings, the hooks used, invariants, and hidden-information needs (any random draw from a hidden pile uses the stage-07 deck protocol; public randomness uses the beacon).
3. Implement + unit tests + a 10k-game simulation + 2 golden replays.
4. UI (renderer plugin layer, dialogs, HUD widgets). Art via `claude -p` using the style guide.
5. Bot support (RandomBot through the enumerator; add simple heuristics in stage 16).
6. The lobby scenario entry with an original `about` text and a board.

## Scenarios & variants (in recommended order)

### F1. Variants (small, no board changes)

- **Harbormaster**: harbor points (a settlement on a harbor = 1, a city = 2). The first player with ≥ 3 points gets a 2 VP harbormaster award; others must strictly exceed to take it `[VERIFY]`. VP target +1.
- **Friendly robber**: already in base. Verify it matches this variant's definition.
- **Event deck ("dice cards")**: replace dice with a 36-card deck of all 2d6 combinations, some cards carrying events (e.g. neighbourly assistance, tournament, calm sea…) `[VERIFY the full event list]`. The deck reshuffles when 5 cards remain `[VERIFY]`. Uses the beacon (public draw order) since the results are public; mental poker isn't needed.
- **2-player rules**: a neutral-player variant with trade tokens and a "forced trade" / "remove robber" action `[VERIFY]`.

### F2. Fishermen

- The desert becomes a **lake** with its own number tokens (e.g. 2, 3, 11, 12) `[VERIFY]`. Fishing grounds are placed on the coast with numbers.
- Buildings adjacent to a producing lake or fishing ground receive **fish tokens**: drawn from a hidden pile of fish tokens worth 1–3 fish, including one "old boot" `[VERIFY distribution]`. **The fish pile is a hidden deck** (the deck protocol); the drawer sees the value. Spent fish values become public.
- Spend fish (in `main`) `[VERIFY costs]`:
  - remove the robber from the board,
  - steal a card,
  - take a resource from the bank,
  - build a free road,
  - take a development card.
- **Old boot**: the holder needs +1 VP to win and may pass it to a player with ≥ their VP `[VERIFY]`.
- Fish tokens have a hand limit / don't count toward the 7-card discard `[VERIFY]`.

### F3. Rivers

- River hexes with **bridges** (a road type built on river edges at a special cost) `[VERIFY]`. Building next to a river earns **gold coins**. Coins can be traded for resources `[VERIFY rate]`.
- **Wealthiest settler** (+1 VP) and **poor settler(s)** (−2 VP) are awarded based on coin counts `[VERIFY]`. Coins are public.

### F4. Caravans

- A central oasis (desert). **Camel lines** extend from the oasis along edges. On each roll of a certain result `[VERIFY: trigger]` players **vote** by secretly bidding grain/wool on the direction of the next camel `[VERIFY]`. Implement the secret bids as commit-reveal among all players (commit `H(bid‖salt)`, then reveal).
- Roads under camels count double for longest road, and settlements/cities adjacent to camel lines earn +1 VP `[VERIFY]`.

### F5. Barbarian Attack (requires a knights-lite subsystem; don't depend on the full `knights` module)

- Barbarians land on coastal hexes, determined by dice rolls, block production, and capture coastal buildings when there are enough of them; players' knights fight them for gold and VP `[VERIFY entire mechanic]`.
- A castle in the centre; knights are recruited and moved on edges.
- Implement the barbarian placement randomness via the beacon.

### F6. Traders & Barbarians main scenario

- Commodity trade routes with **wagons** carrying goods (glass, marble, sand) from production sites (glassworks, quarry, castle) along roads to cities/the castle. Delivery earns gold and VP. Barbarians roam; knights escort `[VERIFY entire mechanic]`.
- The most complex scenario; do it last. Split it into sub-milestones in its rules doc.

## Required tests (per scenario)

- Unit tests for every rule in its rules doc.
- A 10k-game simulation with scenario invariants.
- A P2P chaos run with hidden piles/votes where applicable. The audit covers the fish pile and caravan bids.
- Golden replays.

## Acceptance criteria

- [ ] F1–F4 shipped (each: rules doc, engine, UI, bot support, simulation, P2P).
- [ ] F5–F6 shipped, or explicitly deferred in STATUS.md with the reason.
- [ ] Every hidden or secret mechanic uses the deck protocol or commit-reveal and is audited.
