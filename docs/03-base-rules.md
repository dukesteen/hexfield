# 03 — Base Rules Module (`base`)

## Goal

Implement the complete base game for 2–4 players, with the common online-play options, as the `base` module on top of the engine core. Two players use the same rules, as required by stage 05. At the end of this stage a full game can be played headlessly through `LocalGame`.

## Prerequisites

Stage 02 is complete.

## Resolved rules reference

Write `docs/rules/base.md` as you go, stating every rule as implemented. The rules below are the specification. Anything marked `[VERIFY]` must be checked against the official base-game rules.

### Components

| Item              | Quantity                                                                      |
| ----------------- | ----------------------------------------------------------------------------- |
| Land hexes        | 19: 4 forest, 4 pasture, 4 fields, 3 hills, 3 mountains, 1 desert             |
| Number tokens     | 18: 2, 3,3, 4,4, 5,5, 6,6, 8,8, 9,9, 10,10, 11,11, 12                         |
| Harbors           | 9: 4 generic (3:1), one 2:1 for each resource                                 |
| Bank              | 19 of each resource                                                           |
| Development cards | 25: 14 knight, 5 victory point, 2 road building, 2 year of plenty, 2 monopoly |
| Per player        | 5 settlements, 4 cities, 15 roads                                             |

Terrain → resource: hills→brick, forest→lumber, pasture→wool, fields→grain, mountains→ore, desert→none.

### Costs

| Build            | Cost                               |
| ---------------- | ---------------------------------- |
| Road             | 1 brick, 1 lumber                  |
| Settlement       | 1 brick, 1 lumber, 1 wool, 1 grain |
| City (upgrade)   | 2 grain, 3 ore                     |
| Development card | 1 wool, 1 grain, 1 ore             |

### Victory points

- Settlement 1, city 2, VP card 1, Longest Road 2, Largest Army 2. Default target 10 (option `vpTarget`, range 3–20).
- A player **wins only during their own turn**. Public VP reaching the target wins automatically after any input. Hidden VP wins require `CLAIM_VICTORY { slotIds }`, revealing enough owned VP cards to reach the target. The claim is allowed during the active seat's turn, including interrupt phases, and is not a development-card play. Duplicate, missing, foreign or already-spent slots are rejected. In P2P, the protocol verifies the card reveals before the engine sees the claim. `LocalGame`, bots and the UI automatically submit the claim as soon as the active seat's private total reaches the target, before accepting another input. The claim becomes part of the input log.

### Board generation

Two variables: **layout** (option `mapLayout`) and **seed** (genesis).

- `standard-fixed`: a fixed, non-random layout written by us (design an original balanced one; don't copy the rulebook's beginner layout). Store it in `@cp2p/maps` as data. The engine receives the resolved board through config, so the engine doesn't depend on maps.
- `random`: shuffle terrains onto the 19 positions. Number tokens are placed randomly on non-desert hexes without balance constraints. Harbors are shuffled over the 9 fixed harbor slots.
- `balanced-random` (default): `random` plus the balance constraints.
  - no two red numbers (6, 8) adjacent,
  - no two identical numbers adjacent,
  - (option `strictBalance`) no 2/12 adjacent to each other. Four-hex resources have at most 14 pips each; three-hex resources have at most 11 pips each. The token set totals 58 pips, so a uniform 11-pip cap would be impossible.
- Token placement algorithm: backtracking search seeded by the genesis RNG, with a hard cap of 10,000 attempts. After that, reshuffle terrains and retry, at most 100 times. If no layout succeeds, fail genesis with `BOARD_GENERATION_FAILED`. Must terminate deterministically. Verify success over 10k seeds for both balance modes.
- The robber starts on the desert.
- Harbor slots: define 9 edges on the outer ring (every other coastal pair in the standard pattern). Each harbor is attached to a coastal **edge**, and its 2 vertices get the harbor benefit.

### Setup phase

1. The starting seat comes from a `random` pending (`startSeat`, uniform over seats).
2. **Round 1**, in seat order starting at startSeat: each seat places 1 settlement, then 1 road touching that settlement.
3. **Round 2**, in reverse order (snake): each seat places 1 settlement, then 1 road touching _that_ settlement.
4. After the second settlement is placed, the seat immediately receives 1 of the matching resource from each adjacent producing hex (from the bank).
5. Placement rules in setup: the settlement goes on any unoccupied **land** vertex (touching at least one land hex) satisfying the **distance rule** (no settlement/city on any adjacent vertex). No road connection is needed.
6. Then the turn of startSeat begins in `preRoll`.

### Turn structure

Phases (the stack frames in `turn.phase`):

1. `preRoll`: the active seat may play **one** development card (commonly a knight) or roll (`ROLL_DICE`). Nothing else.
2. Rolling creates a `random` pending `dice: 2d6`. Answered by the system input `DICE_RESULT { dice: [a,b] }`.
3. Roll ≠ 7 → **production** (below) → `main`.
4. Roll = 7 →
   a. `discard`: every seat with more than `discardLimit` cards (default 7, option) must discard `floor(total/2)`. All affected seats act **simultaneously** (one pending per seat). Resolves when all have discarded.
   b. `moveRobber`: the active seat moves the robber to a **different** land hex (the desert is allowed).
   c. `steal`: if any _other_ seat has a settlement or city on that hex and ≥ 1 card, the active seat picks one such victim (`STEAL { victim }`). This creates a `random` pending `stealIndex` (see "Steal resolution"). No eligible victim → skip.
   d. → `main`.
5. `main`: any number of builds, trades and maritime trades, and at most **one** development card play per turn (counting a card played in `preRoll`). `END_TURN` passes to the next seat's `preRoll`.

### Production

For roll `n`: for each land hex with token `n` **without the robber**, each adjacent settlement earns 1 and each city earns 2 of that hex's resource.

**Bank shortage** is evaluated per resource: if the bank holds enough for the total demand, pay everyone. Otherwise, if exactly **one** seat demands that resource, give it all the bank has left. Otherwise **nobody** receives that resource this roll.

### Building rules

- **Road**: on an empty edge that connects to the seat's own road, settlement or city. A road can't continue _through_ a vertex occupied by an opponent's settlement/city. Precisely: the connection must come through an endpoint vertex that is either owned by the seat or empty, where the seat has another road touching that vertex.
- **Settlement**: on an empty land vertex meeting the distance rule, touching at least one of the seat's roads.
- **City**: replaces the seat's own settlement. The settlement piece returns to supply.
- Piece limits: the build is rejected if the seat has none of that piece left.

### Development cards

- `BUY_DEV_CARD` needs the cost and a non-empty deck. It creates a `random` pending `draw: dev` for that seat. In P2P this is answered by the deck protocol (stage 07). The public state gains a face-down slot `{ slotId, deck: 'dev', acquiredTurn }`. The owner learns the identity privately.
- Playing (`PLAY_DEV_CARD { slotId, card, ...params }`): the card is revealed publicly at play time. In P2P, the protocol verifies the reveal proof before the engine sees the input.
- A card can't be played on the turn it was acquired (`acquiredTurn == turn.number`), except VP cards, which are never "played" and only count toward the total.
- Max one non-VP card per turn, and it can be played in `preRoll` or `main`.
- **Knight**: move the robber (a different hex) plus steal as on a 7 (no discard). Increments `knightsPlayed`.
- **Road building**: pushes a `roadBuilding { remaining: 2 }` frame. The seat places up to 2 free roads (`PLACE_FREE_ROAD`). If it has no legal placement or no road pieces, the frame ends early. The seat may `SKIP` the remaining placements.
- **Year of plenty**: take any 2 resources from the bank (same or different). If the bank lacks one, only what's available.
- **Monopoly**: name a resource. Every other seat must give _all_ of theirs. In P2P, the counts are revealed by each opponent (`reveal` pending per opponent with `max[r] > 0`; seats with `max[r] == 0` are auto-resolved as 0).
- Victory-point cards: hidden VP. Public VP shows only visible points.

### Awards

- **Longest Road**: at least 5 connected road segments. Longest path = the longest **trail** (edges not repeated; vertices may repeat) in the seat's road subgraph, where the trail can't pass _through_ a vertex occupied by an opponent's settlement/city (it may end there).
  - Recompute for all seats after every road build, settlement build (it can cut someone's road) and every road removal (in modules).
  - Transfer rules:
    - No holder yet: the first seat reaching ≥ 5 gets it.
    - Holder exists: another seat gets it only by **strictly exceeding** the holder's current length.
    - The holder's road gets cut: if the holder is still tied for the maximum (≥ 5), they keep it. Otherwise, if exactly one seat has the unique maximum ≥ 5, it goes to them. If several seats tie for a maximum ≥ 5, or no seat has ≥ 5, **nobody** holds it.
- **Largest Army**: ≥ 3 knights played. It transfers only when another seat **strictly exceeds** the holder.

### Trading

- **Maritime (bank)**: `MARITIME_TRADE { give: {r: n}, get: {r2: m} }`. Rates per resource: 4:1 default, 3:1 with a generic harbor, 2:1 for that resource with its specific harbor. Allow several trades in one command as long as each given resource's count is a multiple of its rate and the output count matches. The bank must hold the output. You can't receive the same resource you give.
- **Player trades** (only during the active seat's `main`; each trade must involve the active seat):
  - `OFFER_TRADE { give, want, to?: Seat[] }` from the active seat creates `offers[offerId]`. Opponents answer `RESPOND_TRADE { offerId, accept: boolean }`. The active seat finalises with `CONFIRM_TRADE { offerId, withSeat }`, where `withSeat` must have accepted. `CANCEL_TRADE { offerId }`.
  - Non-active seats may send `PROPOSE_TRADE { give, want }` to the active seat (a counter-offer). The active seat can `CONFIRM_TRADE` it directly.
  - During `main`, each other seat has optional player pendings for permitted proposals and responses. The active seat can continue or end its turn without waiting for them. Legal-command generation and timeout handling must include those pending choices.
  - Validation: both sides non-empty; no resource on both sides; the affordability check (bounds) is repeated at _confirm_ time for both parties.
  - Delete all open offers at `END_TURN`. When a hand change makes an offer unaffordable, mark it invalid instead of deleting it, so the UI can show why.
  - Option `playerTrades: boolean` (default true).

### Steal resolution (robber / knight)

- The engine emits `random` pending `{ type: 'stealIndex', thief, victim, handSize: victim.total }`.
- System input: `STEAL_RESULT { thief, victim, resource: Resource | 'hidden' }`.
  - `resource` known (local mode) → `loseKnown(victim)` and `gainKnown(thief)`.
  - `'hidden'` (P2P) → `loseHidden(victim, 1)` and `gainHidden(thief, 1)`. The protocol delivers the actual card privately to the thief and victim (stage 07). Each calls `applyPrivate` with it.

### Options (all in `GameConfig.options.base`)

| Option           | Default           | Notes                                                                                                                                                                                                                           |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vpTarget`       | 10                |                                                                                                                                                                                                                                 |
| `discardLimit`   | 7                 | Colonist-style tweakable                                                                                                                                                                                                        |
| `friendlyRobber` | false             | Robber may not be placed on a hex adjacent to any seat with ≤ 2 public VP (unless no legal hex remains, in which case all hexes are allowed)                                                                                    |
| `mapLayout`      | `balanced-random` |                                                                                                                                                                                                                                 |
| `strictBalance`  | false             |                                                                                                                                                                                                                                 |
| `playerTrades`   | true              |                                                                                                                                                                                                                                 |
| `diceMode`       | `random`          | `balanced`: a public 36-card "dice deck" (all 2d6 combinations). The pending `dice` becomes `draw index from remaining combinations`, and the deck reshuffles when ≤ 6 cards remain. Public randomness — no mental poker needed |
| `turnTimer`      | `null`            | `{ preRollSec, mainSec, discardSec, robberSec }`. The engine only defines the _auto-action_ for a `TIMEOUT` input. Timing is done by the protocol/UI                                                                            |
| `hideBankCounts` | false             | UI-only                                                                                                                                                                                                                         |

### Timeout auto-actions (`TIMEOUT { seat, phase }` system input)

- `preRoll` → roll.
- `discard` → discard a deterministic choice: the most plentiful resources first, ties broken by canonical resource order. In P2P the seat's own client computes this from its private hand if online. If the seat is offline, discards are resolved through escrow/bot takeover (stage 10). Until then the game waits.
- `moveRobber` → the first legal hex in canonical id order that doesn't touch the active seat (else the first legal hex).
- `steal` → the first eligible victim by seat order.
- `main` / `roadBuilding` → end the frame / end the turn.
- A pending trade response → decline.

### Commands (complete list for base)

`PLACE_SETTLEMENT`, `PLACE_ROAD` (setup), `ROLL_DICE`, `DISCARD {cards}`, `MOVE_ROBBER {hex}`, `STEAL {victim}`, `BUILD_ROAD {edge}`, `BUILD_SETTLEMENT {vertex}`, `BUILD_CITY {vertex}`, `BUY_DEV_CARD`, `PLAY_DEV_CARD {slotId, card, params}`, `CLAIM_VICTORY {slotIds}`, `PLACE_FREE_ROAD {edge}`, `SKIP`, `MARITIME_TRADE`, `OFFER_TRADE`, `RESPOND_TRADE`, `PROPOSE_TRADE`, `CONFIRM_TRADE`, `CANCEL_TRADE`, `END_TURN`.

System inputs: `START_SEAT {seat}`, `DICE_RESULT {dice}`, `CARD_DEALT {seat, deck, slotId, card?}` (card present only in local mode), `STEAL_RESULT`, `REVEAL_COUNT {seat, resource, count}` (monopoly), `TIMEOUT`, `SEAT_STATUS {seat, status}`.

## Implementation layout

```
packages/engine/src/modules/base/
  index.ts             module definition
  config.ts            option specs + defaults
  constants.ts         costs, piece counts, deck composition, bank
  setup/board/         genesis generation (layouts, tokens, harbors)
  board/               harbor lookup and runtime board queries
  placement/           legality: settlement, road, city, distance rule, connectivity
  production.ts
  robber.ts            move, targets, steal
  devcards.ts
  trade.ts             maritime + player
  awards/              longestRoad.ts, largestArmy.ts
  victory.ts
  phases/              setup, preRoll, discard, moveRobber, steal, main, roadBuilding
  timeouts.ts
  legal.ts             getLegalCommands for base
```

## Steps

1. Constants and option specs. `docs/rules/base.md` skeleton.
2. Board generation for all three layouts, with balance constraints. Tests: constraints hold over 10k seeds; terrain/token/harbor counts are exact; same seed → same board.
3. Placement legality (settlement/road/city) as pure functions over `(state, seat, loc)`. Exhaustive tests on hand-built fixtures (road blocked by an opponent settlement, the distance rule, coastal vertices, off-board edges).
4. Setup phases with snake order and starting resources.
5. Dice, production and bank shortage (tests for all three shortage cases, the robber blocking, and city double production).
6. Seven: discard (simultaneous pendings), robber move, steal selection, steal result for both known and hidden.
7. Building commands with costs and piece limits.
8. Development cards: buy, draw pending, slot model, the play rules (one per turn, not the turn it was bought), each card effect. Monopoly reveal flow.
9. Longest road: an algorithm with full test fixtures (see below). Largest army.
10. Maritime trade and player trade flows.
11. Victory detection, including hidden VP; the game-over state rejects all further inputs.
12. Friendly robber, discard limit, balanced dice deck, timeouts.
13. `getLegalCommands` for every phase (discrete placements enumerated; trades/discards as templates).
14. `base` invariants for `checkInvariants`: piece counts ≤ limits; bank + all hands = 19 per resource in omniscient mode; ≤ 1 dev card played per turn; award holders meet the thresholds; exactly one robber.

## Longest-road fixtures (required tests)

- A simple line of 5 → 5.
- A branch (Y shape) → the longest branch combination.
- A loop of 6 plus a tail of 2 → 8 (the trail may traverse the loop and exit).
- A figure-eight → every edge counted once.
- Cut by an opponent settlement in the middle of 7 → max(left, right).
- A road passing _its own_ settlement is not cut.
- The award transfer scenarios from the rules above: tie keeps holder, cut to a tie among others → nobody, and so on.
- Performance: worst-case 15 roads computed in < 1 ms (DFS with an edge-visited bitset from every endpoint vertex).

## Required tests (summary)

- Unit tests per rule, per phase and per command, including the failure codes for every invalid command (wrong seat, wrong phase, can't afford, illegal location, no pieces).
- Scenario tests: scripted full games in `test/scenarios/*.ts` using a fluent builder (`scenario().seed(..).setup(...).roll(6,2).build(...)`), asserting the resulting state.
- Bounds tests: a game with hidden steals where a seat tries to spend a resource the bounds prove it can't have → rejected. A spend that the bounds allow but the true hand doesn't → accepted publicly, and the **omniscient invariant** flags it (this proves the audit is needed; stage 07 handles it).

## Acceptance criteria

- [ ] Every rule in this document has at least one test. `docs/rules/base.md` is complete, with every `[VERIFY]` resolved.
- [ ] A full 4-player game can be scripted and completed through `LocalGame`.
- [ ] Engine coverage ≥ 90% lines, ≥ 85% branches.
- [ ] All option variants are covered by tests.
- [ ] `getPending` is never empty until `result` is set (checked by the stage 04 fuzzer, and here by a simple assertion helper).
