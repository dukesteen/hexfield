# 13 — Knights & Commerce Module (`knights`)

## Goal

Implement the city-development expansion mechanics:

- commodities,
- city improvements on three tracks, with level-3 abilities and metropolises,
- knights (build/activate/promote/actions),
- the barbarian track and attacks,
- the event die, and progress cards in three decks,
- city walls, the merchant, and the defender VP.

It replaces development cards and Largest Army. Compatible with `five-six` (and with `seafaring` later, as a separate combo task).

This is the largest module. Split the work into the sub-milestones K1–K6 below and finish each with tests before starting the next.

## Prerequisites

Stage 11 is complete.

## Rules specification

Write `docs/rules/knights.md` first, resolving **every** `[VERIFY]` against the official rules. The summary below is the plan author's understanding.

### Components & setup

- VP target 13.
- No development cards, no Largest Army. Longest Road stays.
- **Commodities** (new card kinds): `paper`, `cloth`, `coin`. Bank of 12 each `[VERIFY]`.
- Setup:
  - round 1 settlement + road;
  - round 2 **city** + road (instead of a settlement). The city yields the starting resources as in base, 1 per adjacent hex, **resources only** `[VERIFY]`.
- Pieces per player: 5 settlements, 4 cities, 15 roads, 3 city walls, 6 knights (2 each of basic/strong/mighty). Shared: 3 metropolises (one per track), the merchant (single), and the barbarian ship.
- **Hand limit**: 7 + 2 per city wall owned. Commodities count toward it.

### Production changes (cities)

| Terrain   | Settlement | City               |
| --------- | ---------- | ------------------ |
| forest    | 1 lumber   | 1 lumber + 1 paper |
| pasture   | 1 wool     | 1 wool + 1 cloth   |
| mountains | 1 ore      | 1 ore + 1 coin     |
| fields    | 1 grain    | 2 grain            |
| hills     | 1 brick    | 2 brick            |

The bank-shortage rules apply per card kind.

### Dice

- Three dice: **red** d6, **yellow** d6, and an **event die** (6 faces: 3 × ship, 1 × each gate colour: yellow/trade, blue/politics, green/science).
- Production uses red + yellow.
- Order of resolution `[VERIFY]`: (1) event die: ship → advance barbarians (attack if they arrive); gate → progress card draws; (2) production (or the 7 procedure).
- **Alchemist** progress card: played before rolling; the player picks the red and yellow values, and only the event die is rolled.
- Beacon derivations: `red`, `yellow`, `event`, each with its own label.

### Robber

- Until the **first barbarian attack**, the robber stays in the desert and can't be moved. On a 7, players still discard `[VERIFY]`, but there is no robber move or steal.

### City improvements

- Three tracks: **Trade** (yellow, paid with cloth), **Politics** (blue, coin), **Science** (green, paper).
- Level `k` (1–5) costs `k` of that commodity. At least one city is required to build any level `[VERIFY]`.
- Level 3 abilities:
  - Trade → **Trading House**: 2:1 bank trades for commodities.
  - Politics → **Fortress**: can promote strong knights to mighty.
  - Science → **Aqueduct**: whenever a production roll (not 7) gives you nothing, take 1 resource of choice.
- **Metropolis**: the first player to reach level 4 on a track places that track's metropolis on one of their cities (the city is then worth 4 VP; a metropolis can't be pillaged).
  - A player reaching level 5 takes a metropolis from a holder who is only at level 4.
  - A player can't advance to level 4+ without a city available to hold the metropolis `[VERIFY]`.
  - A player may hold several metropolises (on different cities).

### Progress cards

- On an event-die gate of colour C with red die value r: every player whose track-C level L satisfies `r ≤ L + 1` (L ≥ 1) draws 1 card from deck C, in turn order starting with the active player `[VERIFY]`.
- Hand limit for progress cards: 4 (VP cards are played immediately and don't count). On drawing a 5th, discard one `[VERIFY: timing and exceptions on own turn]`.
- Cards can be played during your turn after rolling (except Alchemist, before rolling). Several per turn are allowed. VP cards (Printer, Constitution) are revealed immediately and kept face up.
- Decks (18 cards each) `[VERIFY counts]`:
  - **Science (green)**: Alchemist ×2, Inventor ×2, Crane ×2, Engineer ×1, Irrigation ×2, Medicine ×2, Mining ×2, Printer ×1 (VP), Road Building ×2, Smith ×2.
  - **Trade (yellow)**: Commercial Harbor ×2, Master Merchant ×2, Merchant ×6, Merchant Fleet ×2, Resource Monopoly ×4, Trade Monopoly ×2.
  - **Politics (blue)**: Bishop ×2, Constitution ×1 (VP), Deserter ×2, Diplomat ×2, Intrigue ×2, Saboteur ×2, Spy ×3, Warlord ×2, Wedding ×2.
- Effects (write them in your own words in the UI):
  - Alchemist: choose the production dice values.
  - Inventor: swap 2 number tokens (not 2, 12, 6, 8).
  - Crane: the next city improvement costs 1 less commodity.
  - Engineer: a free city wall.
  - Irrigation: 2 grain per fields hex adjacent to your buildings.
  - Mining: 2 ore per mountains hex adjacent to your buildings.
  - Medicine: upgrade a settlement to a city for 2 ore + 1 grain.
  - Road Building: 2 free roads.
  - Smith: promote up to 2 knights free (the Fortress rule still applies for mighty).
  - Commercial Harbor: offer each opponent a resource from your hand; each must give you a commodity in return if they have one.
  - Master Merchant: look at the hand of a player with more VP and take 2 cards.
  - Merchant: place the merchant next to a land hex adjacent to your building; 2:1 trades of that hex's resource; +1 VP while you control it.
  - Merchant Fleet: 2:1 trades of one chosen resource/commodity for the rest of the turn.
  - Resource Monopoly: name a resource; each opponent gives up to 2.
  - Trade Monopoly: name a commodity; each opponent gives 1.
  - Bishop: move the robber and steal 1 from each player with a building adjacent to the new hex.
  - Constitution: +1 VP.
  - Deserter: an opponent removes one of their knights; you place one of equal strength for free.
  - Diplomat: remove an open road (anyone's); if it's yours, you may relocate it.
  - Intrigue: displace an opponent's knight on your road network without using a knight.
  - Saboteur: each player with VP ≥ yours discards half their cards (rounded down).
  - Spy: look at an opponent's progress cards and take 1 (not a VP card).
  - Warlord: activate all your knights free.
  - Wedding: each player with more VP gives you 2 cards of their choice.
- Hidden-info implications (P2P):
  - Master Merchant / Spy / Commercial Harbor / Wedding / Saboteur / Resource Monopoly need **private reveals or choices** from other seats, using the stage-07 patterns: a private reveal to the actor + a public commitment + the audit.
  - Spy reveals the target's progress-card identities to the actor. Use a DLEQ-verified per-card reveal to one recipient: the owner sends `(identity, proof)` privately, the actor verifies against the public `Z` point and the owner's lock key.

### Knights

- Build a basic knight: 1 wool + 1 ore. It's placed **inactive** on an empty vertex connected to your road network. No distance rule `[VERIFY]`.
- Activate: 1 grain `[VERIFY: may a knight act in the same turn it was activated?]`.
- Promote: 1 wool + 1 ore; basic → strong; strong → mighty requires the Fortress. Once per knight per turn `[VERIFY]`. The active state is kept.
- Actions (active knights only; the knight becomes inactive afterwards; one action per knight per turn):
  - **Move** along your connected roads to another empty vertex.
  - **Displace** an opponent's _weaker_ knight on a vertex connected to your network. The opponent must move theirs to an empty vertex on their own network, or remove it if none exists.
  - **Chase away the robber**: a knight adjacent to the robber's hex; then move the robber and steal as on a 7.
- Knights block opponents' roads for longest road (like buildings) and occupy vertices (you can't build a settlement on a knight's vertex).
- A knight of yours on a vertex doesn't break your own road.

### Barbarians

- The track has 7 steps `[VERIFY]`. It advances 1 per ship face on the event die.
- On arrival:
  - **Barbarian strength** = number of cities + metropolises on the board (all players).
  - **Defense** = the total level of all _active_ knights.
  - Defense ≥ strength → defenders win `[VERIFY: tie goes to defenders]`. The player with the highest active-knight contribution (strictly) gets a **Defender** VP card. If tied, each tied player draws a progress card from a deck of their choice.
  - Otherwise → the player(s) with the lowest contribution _among those who own at least one non-metropolis city_ lose one city (reduced to a settlement; any city wall on it is removed). All tied lowest lose one. If a player has no settlement piece available to replace it `[VERIFY]`.
- After any attack: all knights become inactive, the barbarian ship returns to the start, and the robber becomes movable (after the first attack).

### City walls

2 brick. Placed under one of your cities (max 1 per city, 3 per player). +2 hand limit each. Removed if the city is pillaged.

### VP summary

Settlement 1, city 2, metropolis +2 (a city with a metropolis = 4 total), Longest Road 2, Defender card 1 each, Printer 1, Constitution 1, Merchant 1 (while controlled). Target 13.

## Implementation plan (sub-milestones)

- **K1 — Commodities & production**: card kinds, the bank, the city production table, the three dice + beacon derivations, hand limit with walls, the 13 VP target, city-in-setup. The event die only logs its result at this point.
- **K2 — City improvements & metropolises**: tracks, costs, level-3 abilities (Trading House, Aqueduct; Fortress gets wired in K3), metropolis award/steal logic, VP.
- **K3 — Knights**: pieces, build/activate/promote, actions (move/displace/chase), displacement sub-phase for the displaced owner, the longest-road interaction, the robber lock until the first attack.
- **K4 — Barbarians**: the track, attack resolution, pillage, the defender card, the knight reset.
- **K5 — Progress cards**: three decks via the deck protocol (3 deck ids), the draw rule, the hand limit, all 27 card effects, each as its own handler file with tests. Private-reveal flows for Spy, Master Merchant, Commercial Harbor, Wedding, Resource/Trade Monopoly and Saboteur.
- **K6 — UI & bots**:
  - a barbarian track widget,
  - a city-improvement board per player (3 tracks × 5 levels),
  - a commodities hand,
  - a knight layer (3 strengths × active/inactive, drawn distinctly),
  - knight action modes with highlights,
  - progress card hand + play dialogs,
  - the merchant and metropolis sprites; wall overlays.

  Art via `claude -p` per the style guide. RandomBot + enumerator coverage for every new command.

## Required tests

- A unit test per card effect (including edge cases: not enough cards to give, targets with no cards, the bank running out).
- Knight displacement chains; knights breaking roads; pillage when a player has only metropolises (immune).
- Metropolis transfer at level 5; no metropolis without an available city.
- Barbarian ties (both sides).
- Aqueduct triggers only on non-7 rolls with zero production.
- A seeded simulation of 20k games (3–4p) and 10k (5–6p); invariants for commodity conservation, knight counts, and metropolis uniqueness.
- P2P: progress-card private flows under the chaos suite; the audit validates the Spy / Master Merchant exchanges.

## Acceptance criteria

- [ ] `docs/rules/knights.md` is complete, with all `[VERIFY]` items resolved and sourced.
- [ ] K1–K6 are done, each with passing tests.
- [ ] The simulation and P2P suites pass; golden replays for 5 knights games.
- [ ] A human can play a full knights game against bots on mobile, with the barbarian track and improvements clearly visible.
