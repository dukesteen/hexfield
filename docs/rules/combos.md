# Seafaring with Cities & Knights (`seafaring` + `knights`) as implemented

This document is the combined rule set for the `seafaring` and `knights` modules played together. Everything not listed here follows [seafaring.md](seafaring.md) and [knights.md](knights.md) unchanged, and with `five-six` also [five-six.md](five-six.md). The pair is `scenario` in the compatibility matrix: it is offered only through the combined scenarios in [Scenarios](#scenarios), which select the rules module `scenario:seafarers-knights` next to the two expansions.

Sources, all read on 2026-09-29:

- **C&K rulebook (2025)**: [Cities & Knights rulebook v6.250401](https://www.catan.com/sites/default/files/2025-03/CN3087%20CATAN%E2%80%93Cities%26Knights_%20Rulebook.pdf), printed page 12, "Combining with CATAN – Seafarers Expansion". Cited as _C&K 2025_. It is the newest text and wins.
- **C&K rulebook (2020)**: [Cities & Knights rules and almanac](https://www.catan.com/sites/default/files/2021-06/catan_c_k_2020_rule_book_200708.pdf), printed page 13, "Seafarers of Catan Variant", and the Road Building (p.15) and Intrigue (p.16) cards. Cited as _C&K 2020_.
- **C&K FAQ**: [Cities & Knights FAQ](https://www.catan.com/faq/cities-knights), the Diplomat answers (ships, the pirate, the open road). Cited as _C&K FAQ_.
- **Seafarers FAQ**: [Seafarers FAQ](https://www.catan.com/faq/seafarers), "When is a ship open?": "As soon as a shipping route connects two settlements (or cities or for Cities & Knights also knights), the shipping route is considered as closed." Cited as _Seafarers FAQ_.
- The Seafarers rulebooks ([2021](https://www.catan.com/sites/default/files/2021-06/catan-seafarers_2021_rule_book_201201.pdf), [2025](https://www.catan.com/sites/default/files/2025-03/CN3083%20CATAN%E2%80%93Seafarers%20Rulebook%202025%20secured%20reduced.pdf)) and the 5–6 extensions ([C&K 5–6 (2020)](https://www.catan.com/sites/default/files/2021-08/catan_c_k_5-6_2020_rules.pdf), [Seafarers 5–6 (2015)](https://cdn.1j1ju.com/medias/fa/50/04-catan-seafarers-5-6-player-extension-rulebook.pdf)) were read for the same purpose and say nothing about the other expansion.

The publisher's combination text is short. It is one page in each C&K rulebook and lists twelve rules. Everything else below is derived from those twelve rules and from the two module documents, and is marked "(our choice)" where the publisher is silent. Card wording is our own paraphrase, with short quotes only for citation.

## The publisher's twelve rules

From _C&K 2025_ p.12 (the 2020 list has the same content in different words and no Taxation, Diplomacy or Gold Fields lines, and no winning-score line):

| #   | Rule (paraphrase)                                                                                                                                                                                        | Where it lands here                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | C&K rules for roads also apply to ships.                                                                                                                                                                 | [Ships are roads](#ships-are-roads)                                               |
| 2   | The pirate starts on the last space of the barbarian track and enters play only after the first attack, at the Seafarers scenario's pirate start.                                                        | [The pirate and the robber lock](#the-pirate-and-the-robber-lock)                 |
| 3   | The barbarians attack all islands at once. Count all cities and all knights on the board.                                                                                                                | [Barbarians](#barbarians)                                                         |
| 4   | Gold fields produce resources only, never commodities. The merchant may not stand on a gold hex.                                                                                                         | [Gold, fog and commodities](#gold-fog-and-commodities), [Merchant](#the-merchant) |
| 5   | Knights move along continuous routes of roads and ships and may end on an empty sea intersection.                                                                                                        | [Knights on the water](#knights-on-the-water)                                     |
| 6   | Knights must stay connected to a route of their colour: a ship whose move would break that connection cannot move.                                                                                       | [Moving ships](#moving-ships-and-open-routes)                                     |
| 7   | A knight on a sea intersection may chase away the pirate like a land knight chases the robber.                                                                                                           | [Chasing the pirate](#chasing-the-pirate)                                         |
| 8   | Taxation (the Bishop) moves only the robber, never the pirate.                                                                                                                                           | [Progress cards](#progress-cards)                                                 |
| 9   | Diplomacy removing your own road allows only a new road, removing your own ship allows only a new ship.                                                                                                  | [Progress cards](#progress-cards)                                                 |
| 10  | The Road Building card places 2 roads, 2 ships or 1 of each (2020 card text and almanac).                                                                                                                | [Progress cards](#progress-cards)                                                 |
| 11  | The Seafarers scenario's winning score rises by 2 points (2025 only).                                                                                                                                    | [Victory points](#victory-points)                                                 |
| 12  | The best scenarios are the ones without hidden fog and without many small islands ("Heading for New Shores", "Through the Desert"). "Fog Islands" and "Four Islands" raise the barbarians' impact a lot. | [Scenarios](#scenarios)                                                           |

## Resolved interactions

Every interaction the brief listed, with its resolution. "Rule N" points at the table above.

| Interaction                                    | Resolution                                                                                                                                                                                                                                                                                                                                                     | Source                                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Do ships count as a knight's network           | Yes. A knight's network is the seat's roads and ships. A path changes between road and ship only at the seat's own settlement or city (the Seafarers continuity rule). A knight may start on either kind.                                                                                                                                                      | Rules 1 and 5. The transition point is our choice, from the Seafarers rule.                                                                       |
| Recruiting next to a ship                      | A new knight goes on an empty **land** vertex where one of the seat's roads **or ships** ends. Never on a sea vertex.                                                                                                                                                                                                                                          | C&K 2020: a knight may move "to an intersection of sea hexes (but not place a new knight there)".                                                 |
| Moving and displacing over water               | A ready knight moves to any empty vertex, land or sea, reachable along the network. It may displace a weaker knight on a vertex it reaches, land or sea. The displaced owner relocates along the owner's own network.                                                                                                                                          | Rule 5, C&K 2020.                                                                                                                                 |
| Knights at sea and pieces of other seats       | A vertex holding another seat's building or knight is not entered (only a weaker knight may be displaced, as on land). It stops the seat's roads and ships there and does not connect them.                                                                                                                                                                    | Rule 1 with [knights.md](knights.md) (knights stop routes like buildings).                                                                        |
| Closed shipping routes                         | A route joining two of the seat's settlements, cities **or knights** is closed. No ship of a closed route can move.                                                                                                                                                                                                                                            | Seafarers FAQ.                                                                                                                                    |
| Ship moves and knight connection               | A ship cannot be moved if that would leave a knight without a route to a settlement or city. Closing routes at knights makes this automatic. It is also checked directly.                                                                                                                                                                                      | Rule 6.                                                                                                                                           |
| Pirate before the first attack                 | The pirate is off the board and cannot move. It blocks nothing. It enters at the first barbarian attack, on the scenario's pirate hex (or stays off the board until its first move when the scenario has none).                                                                                                                                                | Rule 2, and Seafarers "Pirate" for the start hex.                                                                                                 |
| Robber lock and the pirate                     | One lock for both. Until the first attack a 7 moves neither, steals nothing, and a knight or card cannot move either. Seats still discard on a 7. The Bishop is locked as before.                                                                                                                                                                              | Rule 2 with [knights.md](knights.md).                                                                                                             |
| Same roll: first attack and a 7                | The attack resolves first, the pirate enters, and the seat may move the robber or the pirate for that 7.                                                                                                                                                                                                                                                       | C&K FAQ, Robber ("Yes") with rule 2 (our reading for the pirate).                                                                                 |
| Chasing the pirate                             | A ready knight standing on any vertex of the pirate's hex may chase it, whatever the vertex is (sea or coast). The knight becomes inactive. If the knight also stands on a robber hex vertex, the seat chooses which of the two to move. It moves only the one it stands beside.                                                                               | Rule 7. Coast vertices are our reading of "just like knights on land".                                                                            |
| Barbarian strength and defense on many islands | Unchanged: strength is all cities on the board, defense is all active knights on the board, sea vertices included. Every island is attacked at once.                                                                                                                                                                                                           | Rule 3.                                                                                                                                           |
| Gold fields and commodities                    | Gold gives resources only. A settlement takes 1 resource of its choice, a city 2 resources, never a commodity, and a city on gold does not swap one for a commodity.                                                                                                                                                                                           | Rule 4, and [seafaring.md](seafaring.md) for the choice.                                                                                          |
| Gold and the Aqueduct                          | A seat with a gold claim on the roll received cards, so it does not qualify for the Aqueduct on that roll (our choice: gold production counts as production).                                                                                                                                                                                                  | (our choice)                                                                                                                                      |
| Fog reveals and commodities                    | The reward is unchanged: 1 resource of the revealed land hex, or 1 resource of choice for gold. Never a commodity, also for forest, pasture and mountains.                                                                                                                                                                                                     | Rule 4 by analogy, [seafaring.md](seafaring.md). (our choice)                                                                                     |
| Knights and fog                                | A knight moved or placed next to fog reveals nothing. Only roads and ships reveal.                                                                                                                                                                                                                                                                             | (our choice)                                                                                                                                      |
| Road Building                                  | Two free pieces, any mix of roads and ships, one after another, skipping either. The card is playable when any legal road or ship exists.                                                                                                                                                                                                                      | Rule 10.                                                                                                                                          |
| Diplomat on a ship                             | Removes one open ship of any seat. Open follows the Seafarers rule for ships (an open end on an open route, knights counting like buildings), except that the pirate, the once-per-turn limit and "built this turn" do not apply. Removing your own ship allows one free ship on another legal edge and nothing else. The removal may not disconnect a knight. | Rule 9; C&K FAQ ("You may use the Diplomat for ships just like you do for roads", "The Diplomat doesn't fear pirates", no swap of road for ship). |
| Intrigue                                       | The target knight must stand on a vertex where one of the seat's roads **or ships** ends.                                                                                                                                                                                                                                                                      | C&K 2020 card ("roads or lines of ships").                                                                                                        |
| Deserter                                       | The seat places its knight on an empty land vertex where one of its roads or ships ends. Never on a sea vertex, so a knight removed from the water is replaced on land or not at all.                                                                                                                                                                          | Rule 5 (no new knight at sea). (our choice for the rest)                                                                                          |
| Merchant                                       | Never on a gold hex, and never on sea or fog (not land). A desert stays allowed.                                                                                                                                                                                                                                                                               | Rule 4.                                                                                                                                           |
| Inventor and gold                              | Gold hexes carry number tokens and are land, so the Inventor may swap their tokens under the usual limits (not 2, 6, 8, 12, values must differ). Sea and unrevealed fog have no token.                                                                                                                                                                         | (our choice, silent)                                                                                                                              |
| Irrigation and Mining                          | Unchanged. A gold hex is neither fields nor mountains, so it never counts.                                                                                                                                                                                                                                                                                     | (our choice, consequence of the card text)                                                                                                        |
| Bishop and the pirate                          | The Bishop moves the robber only, to a legal land hex, and steals from land buildings on it. It never moves or steals through the pirate.                                                                                                                                                                                                                      | Rule 8.                                                                                                                                           |
| City walls and metropolises on islands         | No change. A wall goes under any own city and a metropolis on any own city, on any island. Barbarians pillage cities on every island.                                                                                                                                                                                                                          | Rule 3.                                                                                                                                           |
| Island bonus and the target                    | The island bonus is the Seafarers scenario's own. The winning score is the Seafarers scenario's score plus 2, never below 13.                                                                                                                                                                                                                                  | Rule 11 (2025). The 13 floor is our choice.                                                                                                       |
| Setup                                          | Round 1: settlement and road or ship. Round 2: a **city** and a road or ship. Both inside the scenario's setup areas. The city pays 1 resource per adjacent resource hex (gold pays nothing), and a setup ship never touches the pirate hex (the pirate is off the board anyway).                                                                              | [knights.md](knights.md), [seafaring.md](seafaring.md) and rule 2.                                                                                |
| Special build phase (`five-six`)               | A seat may build roads, ships, settlements, cities, walls, knights and improvements and may activate and promote knights. It may not move ships, take knight actions, play cards or trade. Fog reveals in the phase pay their reward.                                                                                                                          | [five-six.md](five-six.md), [seafaring.md](seafaring.md), [knights.md](knights.md).                                                               |
| Longest trade route and knights                | The Longest Trade Route (roads and ships as in seafaring) is broken by another seat's knights at any vertex, sea vertices included: a trail may end there, never pass through.                                                                                                                                                                                 | Rule 1 with [knights.md](knights.md).                                                                                                             |
| Hand limits and ship costs                     | Unchanged. Walls raise the 7-limit by 2 each. A ship costs 1 lumber and 1 wool. Commodities count toward the hand for a 7.                                                                                                                                                                                                                                     | Both module documents.                                                                                                                            |
| The barbarian track on a seafaring board       | The track is a two-hex piece outside the board. An explicit board has no frame, so the fixture takes a slot chosen from the board's perimeter (see [The track fixture](#the-track-fixture)).                                                                                                                                                                   | (our choice)                                                                                                                                      |

## Ships are roads

Rule 1 is applied wherever a C&K rule names a road:

- **Knight recruiting and Deserter sites** use the ends of roads and ships.
- **Intrigue targets** are knights on a vertex where one of the seat's roads or ships ends.
- **Knight connection** ("a knight must stay connected to a settlement or city of its colour") runs over roads and ships.
- **Road Building and Diplomacy** work on ships, as in the tables above.
- **Knights stop ships** exactly as they stop roads: another seat's knight at a vertex stops a route there. A ship may end at that vertex and does not continue through it.
- **Longest Road** is the Longest Trade Route of seafaring, and another seat's knight breaks it like another seat's building.

What does not change: ships still cost 1 lumber and 1 wool, a ship still needs a sea edge and a connection to the seat's own ship or building (never a road), and a road still needs a land edge. A road and a ship meet at a vertex only through the seat's own settlement or city.

## Knights on the water

A seat's **network** is its roads and its ships. Two edges of the same kind join at any shared vertex that another seat has not occupied. A road and a ship join only at a vertex holding the seat's own settlement or city.

- **Where a knight can stand.** On any empty vertex: land, coast or sea. A sea vertex is an empty vertex touching only sea hexes. Every knight rule about a vertex (blocking settlements, breaking opposing routes, counting for defense) applies to knights at sea.
- **Recruit.** Land vertices only (see the table).
- **Move.** A ready knight goes to any empty vertex its network reaches. It may pass vertices holding the seat's own pieces and may not enter a vertex with another seat's building or knight. The starting vertex belongs to no kind, so the knight may leave along a road or a ship (our choice). A ship built this turn can be used at once, like a road (2025 p.9 for roads, rule 1).
- **Displace.** As on land, over the network. The displacer lands on the foe's vertex, which may be at sea. The displaced owner relocates over its own network from that vertex, or loses the knight if there is no empty vertex.
- **Connection.** After every change, each knight must have a network path to one of the seat's own settlements or cities that does not cross another seat's building or knight. A knight at sea is connected through the ships that lead to it. A relocated knight always lands on a connected vertex.
- **Nothing reveals fog** and nothing needs a ship to be "built": a knight's move over ships costs nothing.

## Moving ships and open routes

Seafaring's ship-move rules apply with these additions:

- **Knights count like buildings** when deciding whether a route is closed: a route touching two different own settlements, cities or knights is closed (Seafarers FAQ). A route with one such piece and a free end is open, and its end ship may move.
- **A ship that would leave a knight disconnected cannot move** (rule 6). Closing routes at knights already forbids nearly every such move, and the connection is also checked directly after the removal (a road-and-ship mixture can be the only link).
- **Another seat's knight at a vertex** stops the connection of a moved or built ship there, like an opposing building.
- The pirate rule is unchanged, and applies only once the pirate is on the board.
- A ship is never moved in a special build phase, and never before the roll.

## The pirate and the robber lock

- **Setup.** The pirate is not on the board. The barbarian track piece shows it on the landing space (a UI matter). The Seafarers scenario's pirate hex is kept.
- **Entry.** The first barbarian attack, whatever its outcome, places the pirate on the scenario's pirate hex and unlocks the robber. A scenario without a pirate hex leaves the pirate off the board, and it enters at its first move. The pirate then works as in [seafaring.md](seafaring.md) (blocks new ships and moves of ships on the edges of its hex, steals from seats with a ship on those edges).
- **Locked.** With the robber locked the pirate has no legal hex either. A 7 has its discards and then no robber step, there is no steal, and no knight can chase either piece.
- **On a 7 or a knight's chase**, the seat moves the robber or the pirate, never both. After a chase the piece beside the knight moves (see below).
- **`friendlyRobber`** applies to the pirate as in seafaring.
- **Bishop** moves the robber only (rule 8).

### Chasing the pirate

`CHASE_ROBBER { vertex }` names the knight's vertex. The piece that may move is the robber if the vertex touches the robber's hex, the pirate if it touches the pirate's hex, and the seat's choice if it touches both. The vertex needs no sea: a coast vertex touches sea hexes too. The knight becomes inactive, and the move and the steal follow the piece's own rules (the pirate steals from a seat with a ship on the destination hex's edges). A chase is not possible before the first attack and needs a legal destination for the piece.

## Barbarians

Nothing changes in the battle. The strength `B` is the number of cities on the board, the defense `D` the levels of all active knights, both counted over all islands and all sea vertices (rule 3). Knights outside every island (at sea) defend like any other. The barbarians pillage a city on any island. The barbarian ship's track is the same seven steps. After an attack all knights become inactive and the pirate enters play if it had not.

Multi-island boards make the barbarians relatively stronger, because ships and small islands give cheap early cities and far knights. The publisher recommends scenarios with few islands (rule 12). Our combined scenarios follow that advice, and the pairing is offered only through them.

## Gold, fog and commodities

- **Gold** pays resources only. A settlement claims 1 card and a city 2, of the five resources of the seat's choice (`CHOOSE_GOLD` never offers paper, cloth or coin). The bank shortage handling of [seafaring.md](seafaring.md) counts the five resources only.
- **A city on gold** is a plain "2 cards of your choice". The forest, pasture and mountains swap of [knights.md](knights.md) is for those terrains only.
- **Aqueduct.** A seat with a gold claim on a non-7 roll received cards and does not qualify (our choice).
- **Fog.** The reveal reward is 1 resource for a land hex, 1 chosen resource for gold, nothing for sea or desert. It is never a commodity.
- **Setup** gives no gold cards.

## Progress cards

| Card                 | With ships                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Road Building        | Two free pieces, roads or ships in any mix. The phase ends when no legal piece is left. Playable when any road or ship can be placed.                                                           |
| Diplomat (Diplomacy) | Any seat's open road or open ship. A seat that removes its own piece may build one piece of the same kind on another legal edge. The removal cannot disconnect a knight. The pirate is ignored. |
| Intrigue             | A knight on a vertex where the seat's road or ship ends.                                                                                                                                        |
| Deserter (Treason)   | The replacement knight goes on an empty land vertex where the seat's road or ship ends.                                                                                                         |
| Merchant             | Not on gold hexes.                                                                                                                                                                              |
| Bishop (Taxation)    | Robber only.                                                                                                                                                                                    |
| Inventor             | Gold hexes are eligible.                                                                                                                                                                        |
| Irrigation, Mining   | As in [knights.md](knights.md); gold hexes never count.                                                                                                                                         |
| Other cards          | Unchanged.                                                                                                                                                                                      |

## The merchant

The merchant stands on a land hex touching one of the seat's settlements or cities, and never on a gold hex (rule 4). A hex with no resource still gives the point and no rate, so a desert works and a gold hex does not.

## Victory points

- The winning score of a combined scenario is the Seafarers scenario's own score plus 2 (2025 rule 11), and at least 13 (the knights target). The scenario carries the final number.
- The island bonus tokens count as public points, together with metropolises, Defender of Catan cards, the merchant and victory cards, and are checked on the seat's own turn as in both documents.
- Fog and the island bonus still never appear together.

## Setup and special build phase

- Setup order and reversal are as in base. Round 1 places a settlement and a road or a setup ship. Round 2 places a city and a road or setup ship, and its resources are 1 per adjacent resource hex.
- A setup ship never touches the pirate's hex (the pirate is off the board anyway), and setup pieces still reveal fog where a scenario has fog.
- `five-six`: as in [five-six.md](five-six.md), and the module documents' lists of special build commands add up: builds (`BUILD_SHIP` included), `BUILD_KNIGHT`, `ACTIVATE_KNIGHT`, `PROMOTE_KNIGHT`, `BUILD_CITY_WALL`, `UPGRADE_SIDEWAYS_CITY` and `BUILD_IMPROVEMENT`. Not `MOVE_SHIP`, not a knight action, not a progress card, no trade.

## The track fixture

The barbarian track is a two-hex board fixture. The base and five-six boards give it a fixed slot. Seafaring boards are explicit and list every hex including the sea frame, so they have no slot. The seafaring module therefore derives one from the board (our choice): the fixture goes just outside the board's perimeter, in the direction "straight out" from a perimeter hex, on a spot that

- has no harbor on the perimeter edge it faces,
- keeps its outer hex clear of every board hex, so the two hexes lie beyond the board, and
- is the first such spot in reading order (north-most row first, then closest to the middle).

The derivation is a pure function of the board, so genesis stays deterministic and no scenario data is needed. Rules never read the fixture.

## Scenarios

The combined scenarios reuse original seafaring layouts (see [seafaring.md](seafaring.md#scenarios)) with the knights rules and a track fixture. Their names and targets, from the Seafarers scenario's score plus 2:

| Scenario                     | Seats | Board                   | Target | Notes                                                                         |
| ---------------------------- | ----- | ----------------------- | ------ | ----------------------------------------------------------------------------- |
| New Horizons and Knights     | 3–4   | New Horizons (9×7)      | 16     | One home island, small gold islands, the closest to "Heading for New Shores". |
| New Horizons and Knights 5–6 | 5–6   | New Horizons 5–6 (11×9) | 18     | With `five-six`: special build phase, 18 of each commodity.                   |
| Desert Crossing and Knights  | 3–4   | Desert Crossing (9×7)   | 15     | The closest to "Through the Desert".                                          |

Every scenario keeps its Seafarers setup areas, pirate hex, robber start and island bonus. Fog Islands and Four Isles are not combined (rule 12).

## Cases the rulings fix (for tests)

- A knight recruited at a coastal vertex where only a ship ends. A knight refused at a sea vertex.
- A knight moving along ships to a sea vertex and to another island. No road-to-ship switch at an empty vertex, a switch at an own settlement or city.
- A knight displaced at sea and relocating by ship. A displaced knight with no empty vertex.
- A ship refused a move because a knight would be disconnected. A route closed by a knight and a settlement.
- Another seat's knight at a vertex stopping a new ship's connection, and breaking the Longest Trade Route.
- The pirate off the board and locked before the first attack, entering at the attack, and the attack and a 7 on one roll.
- Chasing the pirate from a sea vertex, a coast vertex, and a vertex touching the robber and the pirate.
- Bishop refused the pirate. Gold paying resources only, also to a city. The Aqueduct with a gold claim. A fog reward that is a resource.
- Road Building with ships. Diplomat removing an open ship, an own ship with a ship replacement, an own ship refused a road, a knight-disconnecting removal, a pirate-adjacent ship. Intrigue over a ship end. Deserter refused a sea vertex.
- Merchant refused on gold. Inventor on gold.
- A combined game to victory: invariants of both modules and of the pair, with the barbarian fixture present on an explicit board.
- The special build phase with all three modules.
