# 15 — Explorers Module (`explorers`)

## Goal

Implement the exploration-heavy seafaring variant:

- a mostly hidden board revealed as ships explore,
- ships with movement points carrying **settlers** and **crews**,
- harbor settlements,
- gold,
- modular **missions** (fish delivery, spice trading, pirate lairs) that award VP.

This builds on the seafaring infrastructure (sea edges, ships, fog reveal with the deck protocol) but is a **separate** module, incompatible with others at first.

## Prerequisites

Stage 12 is complete.

## Process

The plan author's knowledge of these rules is partial. **Write `docs/rules/explorers.md` in full first**, resolving everything marked `[VERIFY]` against the official rules, and define the implementation from that document. The summary below is the intended scope and the plan author's understanding.

## Rules summary (all `[VERIFY]`)

- **Board**: a small known starting island; the rest is unexplored sea/land tiles, face down. Tiles are revealed when a ship moves adjacent. The land/sea tile stack is a **hidden deck** (deck protocol, public reveal). Number tokens are assigned on reveal from a hidden token deck.
- **Ships** move along sea edges using movement points per turn (e.g. 4, upgradable). Moving costs points; loading/unloading happens at harbors/coasts. Ships are the main units; there are no roads at sea.
- **Settlers**: a unit built at a harbor settlement and carried by a ship to a new land site, where it founds a settlement.
- **Crews**: units carried by ships to complete missions (pirate lairs, spice villages).
- **Harbor settlements**: an upgraded settlement that allows building ships, and counts for more VP.
- **Gold**: earned when a player receives no resources on a roll, and from exploration/discovery. Tradeable for resources at a fixed rate.
- **Missions** (chosen per scenario):
  - _Land Ho!_: exploration only; VP from discoveries and settlements.
  - _Fish for the council_: fish shoals are revealed; ships collect fish and deliver them to the council hex; there is a VP track.
  - _Spices for the council_: spice villages on discovered islands; crews establish contact and ships deliver spice; there are benefits (e.g. more ship movement) and a VP track.
  - _Pirate lairs_: crews capture lairs, with a dice-based fight; there are VP rewards.
- **Pirate ships / hazards** as the mission defines.
- **Victory**: the scenario sets the VP target (e.g. 8–17 depending on missions).

## Implementation guidance

- Reuse from seafaring: the edge classification, the fog-reveal deck mode, island detection, ship rendering.
- New core concept: **units** (settlers, crews) carried by ships. State: `ships: { id, seat, edge, cargo: Unit[], movesLeft }[]`. Movement is a pathfinding-validated `MOVE_SHIP { shipId, path: EdgeId[] }`; validate step by step, and reveal tiles as each step becomes adjacent to fog. Reveals inside a move create chained pendings: the move pauses on a reveal, the deck-protocol reveal resolves, and the remaining path continues or is re-validated. **Design this carefully** and document it in the rules doc.
- Missions are sub-modules: `explorers:mission:<id>`, each with its own state, commands, VP track and invariants.
- The UI needs movement-path preview (click a destination → show the path and cost), a cargo panel, mission track widgets and a discovery animation. Art via `claude -p`.
- Bots: RandomBot with bounded movement enumeration (a destination set, not all paths; the path is chosen by a shortest-path helper).

## Sub-milestones

1. E1: the rules doc complete.
2. E2: the hidden board, ship movement, reveals, settlers, harbor settlements, gold. This makes _Land Ho!_ playable.
3. E3: fish mission.
4. E4: spice mission.
5. E5: pirate lairs mission.
6. E6: UI polish, bots, the simulation (10k games per mission), P2P chaos with frequent mid-move reveals, goldens.

## Acceptance criteria

- [ ] `docs/rules/explorers.md` is complete and sourced.
- [ ] _Land Ho!_ and at least two missions are playable locally and P2P, with audited reveals.
- [ ] The mid-move reveal pause/resume flow survives the sequencer failover chaos test.
