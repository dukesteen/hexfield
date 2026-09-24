# 12 — Seafaring Module (`seafaring`)

## Goal

Add sea-based play: sea hexes, ships, moving ships, the pirate, gold fields, islands with bonus VP, the longest trade route, exploration fog, and a set of original scenarios. Compatible with `five-six`.

## Prerequisites

Stage 11 is complete.

## Rules specification

Write `docs/rules/seafaring.md` and resolve every `[VERIFY]` before implementing.

### Board

- Hex terrains add `sea`, `gold`, `fog` (unrevealed).
- Boards come from **scenarios** (fixed or semi-random). A board can have multiple islands. An _island_ is a connected component of land hexes, computed once at genesis (and again after fog reveals).
- **Coastal edge**: an edge with land on one side and sea on the other. **Sea edge**: sea on both sides. **Land edge**: land on both sides.
- Harbors sit on coastal edges (scenario-defined, or shuffled over scenario harbor slots).

### Ships

- Cost: 1 lumber + 1 wool. Supply: 15 per player.
- Placed on a sea or coastal edge.
- **Connectivity**:
  - A ship must connect to the player's settlement/city at one of its vertices, **or** to another of the player's ships.
  - Roads and ships connect to each other **only through the player's settlement/city** on the shared vertex. A road touching a ship at an empty vertex doesn't connect them.
- A **shipping route** is a chain of ships. It's **closed** if it connects two of the player's settlements/cities; otherwise open.
- **Moving a ship**:
  - Once per turn (in `main`), a player may move one ship that sits at the open end of an open route. "End" = one of its vertices has no other own ship or own building.
  - Restrictions: not a ship built this turn; not a ship adjacent to the pirate `[VERIFY]`; the ship must not be part of a closed route.
  - The new location must be legal for a new ship placement (computed as if the moved ship were removed).
- Ships can't be placed on edges of the pirate's hex.
- Settlements can be built at the vertex at the end of a shipping route (on land), following the distance rule.

### Pirate

- Starts on a scenario-defined sea hex (or off-board).
- On a 7, or when a knight is played, the player moves **either** the robber (land hex only) **or** the pirate (sea hex only).
- Moving the pirate: steal one card from a player who has a **ship** on an edge of that hex.
- The pirate blocks placing ships on its hex's edges, and moving ships from them.
- Implement the pirate as a second entry in the `robberLike` hook.

### Gold fields

- A settlement adjacent to a producing gold hex earns 1 resource **of its choice**; a city earns 2 (any combination).
- This creates a `goldChoice` pending for each affected seat after production (all at once). Bank limits apply (if the bank is short, choices are limited to what's available; resolve in seat order starting with the active seat) `[VERIFY]`.
- Robber on a gold hex blocks it as normal.

### Islands & special VP

- Scenario option `newIslandBonus: { vp: 1 | 2 }`: the first settlement a player builds on each island other than their _home_ island(s) earns bonus VP.
- Home islands = the islands where the player placed their setup settlements.
- Track per seat per island. The bonus is permanent (a token).

### Longest trade route (replaces Longest Road)

- The same rules as longest road, but the graph includes roads **and** ships. A path switches between road and ship only at a vertex with the player's own settlement/city.
- Opponent buildings break the route as normal. Opponent ships/roads just occupy different edges.
- Implement via the `routeGraph` hook. Refactor the longest-road algorithm to take an edge set plus a "transition allowed at vertex" predicate.

### Fog / exploration

- A `fog` hex is unrevealed. When a player places a road or ship whose edge touches a fog hex, that hex is **revealed**: draw the next tile from the scenario's **fog stack** (terrain + number token).
- If the revealed tile is a land resource hex, the player who revealed it receives 1 of that resource `[VERIFY]`.
- **Fairness**: the fog stack must be _hidden and unpredictable_. Use the deck protocol (stage 07) with a **public reveal**: every seat removes its lock layer, including the drawer's layer (a new "public draw" mode of Phase B). Deck ids: `fog-terrain` and `fog-token` (or one deck of combined tiles).
- The genesis seed must **not** determine the fog contents.
- Island detection reruns after a reveal.

### Setup

- The setup placements are restricted to the scenario's designated setup islands/areas.
- Players may place a ship instead of a road in setup when the settlement is coastal `[VERIFY]`.

### VP target

Scenario-defined (typically 12–14).

### Scenarios (original layouts; do not copy official maps)

Design each as data in `@cp2p/maps/scenarios/seafaring/`:

1. **New Horizons**: one large home island plus several small outer islands; +2 VP per new island. 3–4p and 5–6p variants.
2. **Four Isles**: four medium islands; each player starts on one or two; +2 VP per new island.
3. **Fogbound**: home island plus a fog region with a fog stack; resources on discovery.
4. **Desert Crossing**: a large island split by a desert strip; +2 VP for settling across the desert strip and on outer islands.
5. **Open Sea (random)**: a procedural archipelago generator (seeded), with constraints (min/max island sizes, every island reachable, gold fields count, number balance).

Each scenario has an `about` text for the lobby, written originally.

## Implementation notes

- New piece type `ship` on edges. `BoardState.edges[edgeId]` holds `{ type: 'road' | 'ship', seat }`.
- Commands: `BUILD_SHIP { edge }`, `MOVE_SHIP { from, to }`, `MOVE_PIRATE { hex }` (or a generalised `MOVE_BLOCKER { blocker, hex }`; decide and record), `CHOOSE_GOLD { resources }`, `PLACE_SETUP_SHIP { edge }`.
- System inputs: `FOG_REVEALED { hex, terrain, token }` with deck public-reveal evidence.
- Renderer: a sea layer with animated water; ship sprites; pirate sprite; fog overlay; island outlines (debug). Generate the art with `claude -p` following `docs/design/style-guide.md`.
- UI: a build menu with ship; a move-ship mode (select a movable ship → highlight legal targets); a gold-choice dialog; a blocker choice (robber/pirate) on 7 and on knight plays; an island-bonus badge; the longest trade route label.
- Bots: RandomBot support for all new commands; the enumerator covers ship moves.

## Steps

1. Rules doc with every `[VERIFY]` resolved.
2. Board/terrain extensions, island detection, the edge classification.
3. Ships: build, connectivity, setup ships.
4. Ship moving.
5. Pirate as a second blocker.
6. Gold fields + the choice pending.
7. The generalised route algorithm + longest trade route (with fixtures: road–settlement–ship chains, a road meeting a ship at an empty vertex doesn't connect).
8. Island bonus.
9. Fog reveal + the public-draw deck mode.
10. Scenarios 1–5 + the archipelago generator.
11. UI/renderer/art.
12. Simulation (20k games per scenario), P2P chaos with fog reveals, golden replays per scenario.

## Acceptance criteria

- [ ] All scenarios are playable locally and P2P; the audit covers fog draws.
- [ ] 20k simulated games per scenario pass the invariants (new invariants: ships ≤ 15, ships only on sea/coastal edges, pirate only at sea, robber only on land).
- [ ] The trade-route fixtures pass, including the transition rules.
- [ ] Fog contents are provably not derivable from genesis (a test: two games with the same genesis seed but different deck secrets reveal different fog tiles).
