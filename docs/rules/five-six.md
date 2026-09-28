# Five and six players (`five-six`) as implemented

The `five-six` module depends on `base` and allows five or six seats. Everything not listed here follows [the base rules](base.md).

Source: the publisher's [5–6 player extension rules for the base game](https://www.catan.com/sites/default/files/2021-08/catan_5-6_basegame_rules.pdf) (2020 edition), read on 2026-09-28. The newer [paired-players rule](https://www.catan.com/sites/default/files/2021-09/CATAN_New5-6Player_ruleEN.pdf) is not implemented (see DECISIONS.md).

## Components (all `[VERIFY]` items resolved)

| Item          | Implemented                                                                                | Source                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Land hexes    | 30: 6 forest, 6 pasture, 6 fields, 5 hills, 5 mountains, 2 desert                          | The extension adds 11 hexes (1 desert and 2 of each other terrain) to the base game's 19.                                              |
| Number tokens | 28: two each of 2 and 12, three each of 3, 4, 5, 6, 8, 9, 10 and 11                        | The extension replaces the base tokens with its own 28. The rulebook's token illustration gives this distribution; 28 = 2 + 8 × 3 + 2. |
| Harbors       | 11: five generic 3:1, one 2:1 for each resource and a second 2:1 wool                      | The extension adds one 3:1 harbor and one 2:1 wool harbor to the base nine.                                                            |
| Bank          | 24 of each resource                                                                        | The extension adds 5 cards of each resource.                                                                                           |
| Dev deck      | 34: 20 knight, 5 victory point, 3 road building, 3 year of plenty, 3 monopoly              | The extension adds 6 knights and one each of monopoly, year of plenty and road building.                                               |
| Pieces        | Unchanged: 5 settlements, 4 cities, 15 roads per seat                                      | The extension's piece sets are for the two added colors.                                                                               |
| Board shape   | Rows of 3-4-5-6-5-4-3 land hexes (axial rows `r = -3..3`, see `modules/five-six/board.ts`) | The larger frame holds 30 hexes in this elongated hexagon.                                                                             |

The layout, harbor positions and fixture slot are our own. We never reproduce the rulebook's fixed layout or lettered token spiral. Boards come from the same generator as the base game (`random` or `balanced-random`, with or without `strictBalance`). With `strictBalance`, pip caps are 21 for six-hex terrains and 18 for five-hex terrains. The robber starts on the desert with the lowest hex id. The rulebook lets players choose either desert, and one fixed choice keeps genesis deterministic.

The 38-edge coast has harbor slots at perimeter offsets `0, 4, 7, 11, 14, 18, 21, 25, 28, 31, 35`. No two share a vertex. The two-hex fixture slot is anchored at `h:1,-4` with its outer hex at `h:1,-5`, and no harbor uses that frame hex ([hooks.md](hooks.md)).

## Special build phase

With `specialBuildPhase: true` (the default), `END_TURN` starts a special build phase for every other seat, one at a time, in turn order from the seat after the one that ended. The publisher's rule: "In clockwise order, each player then takes a special build turn … you are not allowed to play development cards, nor trade with other players, nor use maritime trade."

- A seat in its special build phase may use `BUILD_ROAD`, `BUILD_SETTLEMENT`, `BUILD_CITY`, `BUY_DEV_CARD` and `END_SBP`. Every trade command, `PLAY_DEV_CARD`, `ROLL_DICE` and `END_TURN` fails with `not-pending`. No other seat may act.
- A development card bought in the special build phase is acquired on the previous seat's turn number, so its buyer can play it on their own next turn.
- `END_SBP`, or a `TIMEOUT` for that seat in phase `sbp`, passes to the next seat. After the last seat, the next turn starts in the same input. With a turn timer, the phase uses the main-phase limit.
- The phase is implemented through the `turnFlow` hook as one `sbp { seat }` frame per seat, above a base `turnEnd` marker.
- Nobody can win during a special build phase. The base rules end the game when a player has 10 points during their own turn. A seat that reaches the target while building wins when its own turn begins, before it rolls. Hidden victory-point claims are also held until the owner's turn.
- With `specialBuildPhase: false`, turns pass directly, as in the base game.

## Unchanged

Longest road, largest army, the robber, discards, setup order and victory target all follow the base rules.
