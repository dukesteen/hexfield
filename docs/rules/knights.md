# Cities & Knights (`knights`) as implemented

The `knights` module depends on `base` and is compatible with `five-six`. Combining it with `seafaring` is a separate task (see [Recorded for the seafaring combination](#recorded-for-the-seafaring-combination)). Everything not listed here follows [the base rules](base.md), and with `five-six` also [the five-six rules](five-six.md).

Sources, all read on 2026-09-28:

- **Rulebook (2025)**: the publisher's [Cities & Knights rulebook, v6.250401](https://www.catan.com/sites/default/files/2025-03/CN3087%20CATAN%E2%80%93Cities%26Knights_%20Rulebook.pdf) (sixth edition, includes the card descriptions). Cited as _2025_ with the printed page number.
- **Rulebook (2020)**: the publisher's [Cities & Knights game rules and almanac](https://www.catan.com/sites/default/files/2021-06/catan_c_k_2020_rule_book_200708.pdf), fifth English edition (text dated 2015, printed 2020). Cited as _2020_. Where the two differ, _2025_ is the newer text and wins (see [Differences between the editions](#differences-between-the-editions)).
- **FAQ**: the publisher's [Cities & Knights FAQ](https://www.catan.com/faq/cities-knights). Cited as _FAQ_ with the question's topic. The FAQ's definition of an "open" road points to the [Seafarers FAQ](https://www.catan.com/faq/seafarers) ("When is a ship open?"), cited as _Seafarers FAQ_.
- **5–6 extension**: the publisher's [Cities & Knights 5–6 player extension rules](https://www.catan.com/sites/default/files/2021-08/catan_c_k_5-6_2020_rules.pdf) (special build phase, the version we implement). The newer [2025 5–6 rulebook](https://www.catan.com/sites/default/files/2025-03/CN3088%20CATAN%E2%80%93Cities%20%26%20Knights%205-6_%20Rulebook.pdf) replaces the special build phase with paired players, which is not implemented (see [five-six.md](five-six.md)). Cited as _5–6 (2020)_ and _5–6 (2025)_.

The rulebook and FAQ never state the number of steps on the barbarian track in words. It was counted on the printed track (see the resolved items). Nothing in the publisher's texts covers bank shortage for commodities, the Aqueduct when the bank cannot pay, a defense with no knights at all, several sideways city pieces, or the exact shape of an "open" road in loops. Those items are marked "(our choice)". Card wording in this document is our own paraphrase, with short quotes only for citation.

## Resolved `[VERIFY]` items

Every `[VERIFY]` in [13-knights-and-commerce.md](../13-knights-and-commerce.md) is settled here.

| Item                                                 | Resolution                                                                                                                                                                                                                                            | Source                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commodity bank size                                  | 12 of each of paper, cloth and coin. 18 of each with `five-six`.                                                                                                                                                                                      | 2025 p.3: "12x paper, 12x cloth, 12x coin". 2020 components: 12 each. 5–6 (2020): "18 commodity cards: 6 coin, 6 paper, 6 cloth". 5–6 (2025): "18 commodity cards", 6 of each.                                                                                                                                                                   |
| Round-2 city and starting resources                  | Round 2 places a **city** and a road. The city pays 1 **resource** card per adjacent producing hex. No commodities, and a hex counts once even for a city.                                                                                            | 2025 p.5: "Each player takes 1 matching resource card … for each hex adjacent to their city. During setup, only take 1 card for each hex." (the example shows resource cards only). 2020 p.4: "You get 1 resource for each terrain that your city is adjacent to."                                                                               |
| Event die faces                                      | Six faces: 3 ships and one city gate each in yellow (trade), blue (politics) and green (science).                                                                                                                                                     | 2020 components: "event die (with 3 ships and 3 city gate symbols)". 2020 p.5: gates are "blue, green, or yellow".                                                                                                                                                                                                                               |
| Order of resolution                                  | Roll red, yellow and event die together. Resolve the event die first (ship, or progress draws), then production (or the 7 procedure).                                                                                                                 | 2025 p.6: "Resolve the event die before resolving the production dice." 2020 p.5: "The effects of the die roll must be resolved in a specific order".                                                                                                                                                                                            |
| Robber lock and 7s before the first attack           | Until the first barbarian attack the robber cannot be moved by a 7, a knight or a card, and nothing is stolen. Seats still discard on a 7.                                                                                                            | 2025 p.7: "The robber does not activate until after it has been placed on the desert following the first barbarian attack. Until that time, the robber does not move, and you may not steal a card". 2020 p.5: "all players must check if they are holding too many cards as usual; however, you do not move the robber … and you do not steal". |
| A city is needed to improve                          | At least one city must be on the board to buy **any** level. Losing the last city keeps the improvements, abilities and cards, and only blocks new purchases.                                                                                         | 2025 p.8: "You must have at least 1 city on the board to make city improvements." FAQ, Barbarians III: "You merely can't purchase any further city improvements before having built a city again." FAQ, City Improvements: level-3 abilities stay.                                                                                               |
| No available city for a metropolis                   | Buying level 4 or level 5 needs one of your cities that carries no metropolis. Without one the purchase is refused. See [Metropolises](#metropolises) for the holder's own level 5.                                                                   | 2025 p.8: "If you do not have an available city, you may not purchase the level 4 (or level 5) improvement." 2020 p.8: no improvement beyond level 3 "unless you have a city where you could build a metropolis". FAQ, Metropolises: one city cannot hold two metropolises.                                                                      |
| Level 5 steal                                        | The first seat to reach level 5 on a track takes that track's metropolis from a holder who is only at level 4. It is then permanent. A seat that lost a metropolis cannot regain it.                                                                  | 2025 p.8: first to level 5 gains "permanent" control. 2020 p.8: "If another player reaches the fifth level of improvement before the metropolis owner does, that player may take both". FAQ, Metropolises: "the metropolis stays with the first player to perform the 5th city improvement".                                                     |
| Progress card draw condition                         | See [Progress card draws](#progress-card-draws). A seat at level `L ≥ 1` on the gate's track draws when the red die is `≤ L + 1`.                                                                                                                     | 2025 p.6 and p.8: level 1 example draws on a red 1, and after reaching level 2 "a 1, 2, or 3". 2020 p.7: "The first level of improvement shows 2 red dice", "the second … three".                                                                                                                                                                |
| Draw order                                           | Turn order starting with the active seat.                                                                                                                                                                                                             | 2025 p.6: "Cards are drawn in turn order (starting with the current player and continuing clockwise)." 2020 p.9: "beginning with the player who rolled the dice".                                                                                                                                                                                |
| Progress hand limit and discard timing               | 4 cards, VP cards excluded. Off your turn you discard the surplus at once, before production. On your own turn you have until the end of your Action phase, and at turn end any surplus is discarded. The newly drawn card may be the one discarded.  | 2025 p.6 and p.10. FAQ, Progress Cards General: "before the dice roll result is resolved" off turn; on your turn "If you end your turn and still have more than 4 cards you have to discard the exceeding number"; you may look at the fifth card first.                                                                                         |
| Deck compositions                                    | 54 cards, 18 per deck. Counts in [Progress cards](#progress-cards) match the plan exactly. Both editions list the same counts under different names.                                                                                                  | 2020 almanac pp.14–18 (the number after each card name). 2025 pp.13–16. Counts add to 18 per deck.                                                                                                                                                                                                                                               |
| Knight distance rule                                 | None. A knight goes on any empty land vertex where one of the seat's roads ends. It need not satisfy the distance rule.                                                                                                                               | 2025 p.9: "Knights must connect to one of your existing roads, but do not need to follow the Distance Rule." 2020 p.9: "knights do not have to observe the distance rule".                                                                                                                                                                       |
| Acting on the activation turn                        | A knight cannot act on the turn it is activated. It can act on a later turn, and it can be activated again after acting.                                                                                                                              | 2025 p.9: "you may not activate a knight and then take an action with it on the same turn." FAQ, Knights: no chasing the robber after activating on the same turn.                                                                                                                                                                               |
| Promotion limit                                      | One promotion per knight per turn. A knight can be promoted the turn it is recruited, and a promoted knight can act if it was active before.                                                                                                          | 2025 p.9: "You may only promote a knight once per turn." FAQ, Knights: "One time at most", promoting right after building is allowed, and promote-then-act needs activation on a previous turn.                                                                                                                                                  |
| Barbarian track length                               | 7 steps. The ship starts on the start space and each ship face moves it one space. The seventh ship face lands it on the landing space and the barbarians attack. The printed piece shows the start space, six spaces between, and the landing space. | 2020 p.11 (printed track: seven circles for the ship, then the red-circled landing space). 2025 p.6: "When the ship reaches the last space on the track, the barbarians attack". The 2025 frame prints the same start-to-landing path.                                                                                                           |
| Ties in the battle                                   | A tie goes to the defenders: defense `≥` strength wins. A tie for the top contribution gives no Defender card and one progress draw each. A tie for the lowest contribution costs every tied seat a city.                                             | 2025 p.11: "greater than or equal to". 2020 p.11: "equal to or greater". Tie draws: "no one receives a VP token. Instead … each of the tied players draws a progress card from the deck of their choice." Lowest ties: 2020 p.11 "each of those players loses 1 of their own cities".                                                            |
| Pillage with no settlement piece in supply           | Turn the city piece on its side and treat it as a settlement. It must be upgraded before any other settlement.                                                                                                                                        | 2025 p.11: "turn the city piece on its side and treat it as a settlement. You must upgrade this settlement to a city before upgrading any other settlement." FAQ, Barbarians III: "Turn one of your cities on its side and treat it as a settlement until you have upgraded it".                                                                 |
| Seats with only metropolises or no city              | They cannot be pillaged and are skipped when finding the lowest contribution. The next lowest eligible seat loses a city. They still count as contributors and can win the Defender card.                                                             | 2020 p.11: "do not count any player who has no cities or any player who has only metropolises". 2025 p.11: "If that player is unable to pillage a city, then the player who contributed the next lowest … " and the White example. FAQ, Barbarians II: a seat with no city still receives the Defender card or progress card.                    |
| Do commodities count for 7 discards and stealing     | Yes to both. Progress cards never count and are never stolen.                                                                                                                                                                                         | 2025 p.7: the hand is "resource cards + commodity cards". FAQ, Commodities: discarded on a 7 "Yes", stolen "Yes"; a city wall protects them "Yes" (they count in the hand limit).                                                                                                                                                                |
| Commodity trading and harbors                        | All trades with the bank may involve commodities on either side. See [Trading](#trading).                                                                                                                                                             | 2025 p.7. 2020 p.7. FAQ, Commodities: a 3:1 harbor works for commodities.                                                                                                                                                                                                                                                                        |
| Five-six bank, decks, barbarian track, special build | Commodity bank 18 each. Eight Defender cards in all. Decks (54 progress cards) and the barbarian track are unchanged. The special build phase applies with the limits in [Five-six](#five-six).                                                       | 5–6 (2020): 18 commodity cards, 2 "Defender of Catan" cards, 6 walls, 12 knights, "barbarian tile … next to the frame", "Place the robber in either desert". 5–6 (2025): 18 commodity cards, 2 VP tokens, no progress cards.                                                                                                                     |

## Components and setup

| Item                    | Implemented                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Victory target          | 13 points, checked for a seat only during its own turn (as in base).                                                                                                            |
| Commodities             | `paper` (from forest), `cloth` (from pasture) and `coin` (from mountains). Bank 12 each, or 18 each with `five-six`. Resource banks are as in base (19, or 24 with `five-six`). |
| Progress cards          | 54 in three face-down decks: science (green), trade (yellow), politics (blue), 18 each.                                                                                         |
| Pieces per seat         | 5 settlements, 4 cities, 15 roads, 3 city walls, 6 knights (2 basic, 2 strong, 2 mighty), 3 improvement markers (one per track).                                                |
| Shared pieces           | 3 metropolises (one per track), 1 merchant, 1 barbarian ship, 1 event die, the red and yellow dice.                                                                             |
| Defender of Catan cards | 1 point each. Unlimited in play (see [Barbarians](#barbarians)). The publisher packs 6, or 8 with `five-six`.                                                                   |
| Removed                 | Development cards and the Largest Army award.                                                                                                                                   |

Setup follows base, with these changes:

- Round 1: each seat places a settlement and a road, in forward order.
- Round 2, in reverse order: each seat places a **city** and a touching road. The city still obeys the distance rule and needs no connected road. It uses a city piece and returns nothing to the settlement supply.
- Each seat then takes 1 resource per adjacent producing hex (resources only, one card per hex).
- Every improvement marker starts on the base level 0 of its track. The barbarian ship starts on the start space.
- The robber starts on the desert with the lowest hex id and is locked (our choice). The 2025 rulebook keeps the robber beside the barbarian track and puts it on the desert at the first attack, and 2020 puts it on the desert at the start. A desert produces nothing and a locked robber does nothing, so the play is identical, and one fixed start keeps genesis deterministic (the same choice as [five-six.md](five-six.md)). The two editions agree that "the robber is now active" at the first attack.
- The first turn belongs to the seat that placed the last city, which is the first seat of round 1 (2020 p.5).

## Turn structure

A turn has three phases, in this order (2025 p.6).

1. **Roll dice**. Before rolling, the active seat may play an Alchemist. Then all dice are rolled and the event die is resolved: a ship moves the barbarian ship (and may trigger an attack), a gate starts the progress card draws. Discards down to 4 progress cards for seats other than the active seat happen here, before production.
2. **Production**. On a 7: discard, then the robber step (locked until the first attack). Otherwise: production, then the Aqueduct.
3. **Action**. In any order and any number of times: trade, build (roads, settlements, cities, city walls, city improvements), recruit, activate and promote knights, take knight actions, and play progress cards. At the end of the phase the seat must hold at most 4 progress cards.

If the first attack lands on the same roll as a 7, the attack resolves first and the robber is active for that 7 (FAQ, Robber: "May I move the robber on the same turn the barbarian ship reaches Catan? Yes").

## Dice and the event die

- Production uses red plus yellow. The red die alone drives the progress card check. Beacon derivations are `red`, `yellow` and `event`, each with its own label.
- A seat that plays the **Alchemist** sets both production dice, each to 1–6, so the total can be 2–12 and can be 7. Only the event die is rolled. The chosen values apply to every seat, and the chosen red value is the one used for the progress card check (FAQ, Alchemist: "you must roll the symbol die", "the predetermined dice roll applies to all players", "Yes" to choosing 7, "No" to choosing no production).
- No progress card other than the Alchemist can be played before the roll is fully resolved, including before a 7's discards (FAQ, Engineer: no city wall before discarding on a 7).

## Production

| Terrain   | Settlement | City               |
| --------- | ---------- | ------------------ |
| forest    | 1 lumber   | 1 lumber + 1 paper |
| pasture   | 1 wool     | 1 wool + 1 cloth   |
| mountains | 1 ore      | 1 ore + 1 coin     |
| fields    | 1 grain    | 2 grain            |
| hills     | 1 brick    | 2 brick            |

(2025 p.7, 2020 p.5. FAQ, Commodities: a city on forest, pasture or mountains must take one resource and one commodity, never two resources or two of anything else.) A city that was pillaged earlier on the same turn pays as a settlement (FAQ, Barbarians III). Hexes with the robber produce nothing.

**Bank shortage** (our choice: the publishers are silent on commodities, and "Cities & Knights uses all the rules from CATAN"). The base rule is applied to each card kind on its own, including commodities. If the bank cannot cover the total demand for a kind, a sole demanding seat receives what is left and with several demanding seats none receive it. A city can therefore get its resource but not its commodity.

**Aqueduct** (Science level 3). After all production on a non-7 roll, every seat with an Aqueduct that received no card of either kind takes 1 resource of its choice from the bank. A seat that received nothing because of the robber, the shortage rule or having no building on the number also qualifies. A seat that received only a commodity does not. It never triggers on a 7 (2025 p.8: "If you receive no cards during the Production phase … (except when a 7 is rolled)"; 2020 p.8). Seats claim one at a time in turn order from the active seat, each choosing only among resource kinds the bank still holds. With none left the seat takes nothing (our choice: the publishers are silent).

## The 7 and the robber

- On a 7 nothing produces. Every seat holding more than its limit discards half its hand, rounded down. The hand is resource plus commodity cards (progress cards excluded). The limit is **7 + 2 per city wall on the board** (2025 p.8: two walls means no discard until more than 11 cards). Discards happen before the first attack too.
- The robber step follows base once it is unlocked: move to a different land hex (desert allowed) and steal 1 random card, resource or commodity, from an eligible opponent with a building on the hex. A metropolis owner can be robbed (FAQ, Robber).
- **Lock.** Before the first attack there is no robber step on a 7, no stealing, and no Bishop, chase-away or other robber move. A card that needs the robber and could only fail is not playable (see [Playing a card](#playing-a-card)).
- **Unlock.** The first barbarian attack, whatever its outcome, unlocks the robber for the rest of the game. `friendlyRobber` from base, if on, applies to every robber move.
- **Chase-away** and the Bishop use the same move-and-steal sequence as the 7, without discards.

## Trading

Progress cards can never be traded. Trades between seats may mix resources and commodities freely (2025 p.7).

With the bank, the rate for a card kind you give is the best applicable rate:

| Give                            | Rate | Condition                                                           |
| ------------------------------- | ---- | ------------------------------------------------------------------- |
| any resource or commodity       | 4:1  | always                                                              |
| any resource or commodity       | 3:1  | a settlement or city on a generic harbor                            |
| resource `r`                    | 2:1  | a settlement or city on the `r` harbor                              |
| resource `r`                    | 2:1  | the seat controls the merchant and it stands on a hex producing `r` |
| a commodity                     | 2:1  | Trade level 3 (see below), on the seat's own turn                   |
| the resource or commodity named | 2:1  | Merchant Fleet, for the rest of the turn                            |

In every bank trade you receive one card of any resource or commodity except the kind you give, if the bank holds it. Rates never combine. A 2:1 harbor is tied to its own resource, so commodities never get a 2:1 harbor rate (2020 p.7: commodities "4 of the same", "3 of any commodity" at a 3:1 harbor, and "4 of any resource for 1 of any commodity … 2:1 if you have the matching special harbor"; FAQ, Commodities: a 3:1 harbor works). The merchant trades the hex's resource only, never its commodity, and receiving a commodity is allowed (FAQ, Merchant: "Yes"). Trade level 3 ("Merchant Guild" in 2025): two identical commodities for any one other commodity or resource, only during your own turn (2020 p.8).

The special build phase (`five-six`) allows no trade at all.

## City improvements and metropolises

Each seat has three tracks, each with levels 0 to 5. The improvement for level `k` costs `k` commodities of the track's kind. Levels are bought in order and can be bought in any number per turn, on any track, whatever the event die shows (FAQ, City Improvements).

| Track    | Gate colour | Paid with | 2025 level names (1 to 5)                                   | Level 3 ability                                                         |
| -------- | ----------- | --------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| Science  | green       | paper     | School, Library, Aqueduct, Theater, University              | Aqueduct: take 1 resource when production gave you nothing (not on a 7) |
| Trade    | yellow      | cloth     | Market, Trading House, Merchant Guild, Bank, Great Exchange | Commodity trades 2:1 on your turn                                       |
| Politics | blue        | coin      | Town Hall, Embassy, Fortress, Courthouse, High Assembly     | Strong knights can be promoted to mighty                                |

Level names are cosmetic. The 2020 book calls the level-3 trade ability the "Trading House" and the level-3 blue building the Fortress. The three abilities stay for the rest of the game, including at levels 4 and 5 and after losing the last city, and every seat that reaches level 3 has them (2020 p.7; FAQ, City Improvements).

- At least one city on the board is needed for every purchase. Levels 4 and 5 also need an **available city**, which is one of your cities with no metropolis on it.
- Crane and Medicine are played as part of the purchase (see the cards).

### Metropolises

- There are three, one per track. The first seat to buy **level 4** on a track takes that track's metropolis and puts it on one of its cities. That city is worth 4 points (2 for the city, 2 for the metropolis).
- A seat may hold several metropolises, each on a different city. A metropolis cannot be pillaged. A city carrying a metropolis can also hold a city wall (FAQ, City Walls).
- The first seat to buy **level 5** on a track takes that track's metropolis. If another seat holds it at level 4, it moves to a city of the new owner (the old holder loses its 2 points and the city becomes an ordinary city). The holder's own purchase of level 5 keeps it, and from then on it cannot be taken. A seat that lost a metropolis cannot regain it, even by buying level 5 later (FAQ, Metropolises).
- Exception to the available-city rule (our choice, needed so the rule does not contradict the holder's rights): a holder buying level 5 on the track whose metropolis it already holds needs no available city, since the piece is already placed. Every other level-4 or level-5 purchase needs one. The publishers' wording ("you may not purchase the level 4 (or level 5) improvement") is unconditional, so a seat that cannot host a metropolis cannot buy level 4 even if another seat already holds that metropolis.
- Improvement levels are kept after the last city is lost. A metropolis city can never be lost, so a seat with metropolises always has a city.

## Knights

| Action                 | Cost           | Notes                                                                                                      |
| ---------------------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| Recruit a basic knight | 1 wool + 1 ore | Placed **inactive** on an empty land vertex where one of the seat's roads ends. No distance rule.          |
| Activate a knight      | 1 grain        | The same for every strength.                                                                               |
| Promote a knight       | 1 wool + 1 ore | Basic to strong, or strong to mighty (needs Politics level 3). Replaces the piece, keeps its active state. |

- Only basic knights are recruited. A seat with both basic knights on the board cannot recruit until it promotes one, which returns a basic piece to the supply. A strong knight bought directly is a recruit followed by a promotion, so it costs 2 wool and 2 ore and needs a basic knight in the supply (FAQ, Knights). A promotion also needs the next level's piece in the supply (two of each level per seat).
- A vertex is "empty" when it holds no building and no knight. Knights block settlement sites for everyone, the owner included (the owner must move the knight first, 2020 p.10). Knights of another seat stop your roads exactly like an opposing settlement: a road may end at the knight's vertex, but does not continue through it and does not connect there.
- **Readiness.** A knight can take an action only if it was active when the Action phase began and has not acted since. Recruiting, activating or promoting during the turn does not make an inactive knight ready. Promotion of a ready knight leaves it ready. A knight that acts becomes inactive and can be activated again the same turn, but it cannot act again that turn. There is no voluntary deactivation and no voluntary removal of a knight (FAQ, Knights).
- **One action per knight per turn.** The actions are move, displace and chase away the robber. The knight becomes inactive afterwards. Any number of ready knights may act in a turn. All actions are for the active seat only.
- **Promotions.** At most one promotion per knight per turn, by purchase or by Smith. A newly recruited knight can be promoted at once.

### Move

An active ready knight moves to an empty vertex reachable along the seat's own roads. The path may pass vertices holding the seat's own buildings and knights, and may not enter vertices holding another seat's building or knight. The destination must be empty and differ from the start (2025 p.9; FAQ, Knights: no moving past a foreign knight or settlement; a knight may be recruited onto a vertex between two of your roads even if both neighbouring vertices hold foreign knights). A road built this turn can be used at once (FAQ). To build a settlement on a vertex held by your own knight, move the knight away first. If it has nowhere to go, you cannot build there.

### Displace

A ready knight moves along its own roads to a vertex held by another seat's **weaker** knight (strong displaces basic, mighty displaces basic or strong, basic displaces nothing). The moving knight lands on that vertex and becomes inactive. The owner of the displaced knight then relocates it with the same rules as a move, starting from where it stood: along the owner's own roads, past the owner's own pieces only, to an empty vertex, and it may be the vertex the displacer came from if the owner's roads reach it. Its active state does not change. If there is no such vertex, the knight is removed and returns to that seat's supply (2025 p.10; 2020 p.10; FAQ, Knights). The displaced owner cannot chain a displacement with it (FAQ, Knights: displacing is for the active seat only). The displaced owner acts out of turn in a `displaced` pending frame.

### Chase away the robber

A ready knight standing on a vertex of the robber's hex may chase it, whatever its strength. The seat moves the robber and steals as on a 7, and the knight becomes inactive. Not possible before the first attack, and not possible before the roll. The robber may be placed on a hex next to an active knight (FAQ, Robber).

### Knights and longest road

Every knight, active or not, breaks opposing roads at its vertex like an opposing building: a trail may end at the vertex and never passes through it. A knight of your own never breaks your trail. Placing, moving, removing or displacing a knight recomputes the award. A road cut on both sides by opponent knights stays on the board (FAQ, Roads). Longest Road needs 5 roads, is worth 2 points and works as in base.

A knight must always stay connected, through the seat's own roads, to one of the seat's settlements or cities. Removing a road that would leave a knight disconnected is not allowed (FAQ, Diplomat). A relocated knight always lands on a connected vertex.

## Barbarians

The track is a board fixture with the ship on the start space. `knights.barbarians.step` counts ship faces since the last attack, from 0 to 7.

**Ship face.** The ship advances one step. On reaching step 7 the barbarians attack at once, before production, and nothing can be activated in response (FAQ, Barbarians I).

**Attack.**

1. **Barbarian strength `B`** is the number of cities on the board, over all seats. A city carrying a metropolis counts once (2020 p.11: "cities (including metropolises)"; the 2020 example counts a seat's lone metropolis city as 1). A city piece lying on its side is a settlement and does not count.
2. **Defense `D`** is the sum of the levels of all **active** knights on the board (basic 1, strong 2, mighty 3), including seats with no city. Every active knight takes part and no seat may hold any back (the "meanies" variant is not implemented).
3. Each seat's **contribution** is the sum of the levels of its own active knights.
4. If `D ≥ B`, the defenders win. Let `m` be the highest contribution.
   - If one seat alone has `m` and `m > 0`, it takes a **Defender of Catan** card: 1 point, kept face up, never lost. Cards are never scarce, so the count is a counter (FAQ: "Yes. Simply use any other symbol").
   - If several seats share `m` and `m > 0`, none takes a card. Each of the tied seats, in turn order from the active seat, draws 1 progress card from a deck of its choice. It may draw from a track where it has no improvement (FAQ, Barbarians II). A drawn VP card is kept and played at once (FAQ). Seats other than the active seat discard down to 4 at once, and the active seat by its turn's end.
   - If `m = 0` nobody has an active knight, which needs `B = 0` to win. Nothing is awarded (our choice: with no contribution there is no defender, and treating "everyone tied at 0" as a tie would give every seat a free card).
5. If `D < B`, the barbarians win and pillage:
   - A seat is **eligible** if it has at least one city with no metropolis.
   - Among eligible seats, find the lowest contribution. **Every eligible seat with that contribution** loses one city, so a tie costs every tied seat a city. A seat with no active knight has contribution 0. Ineligible seats (no city, only metropolises) are skipped, so the next lowest eligible seat loses a city (FAQ, Barbarians III).
   - The affected seat chooses which of its non-metropolis cities to lose (FAQ, Barbarians III). The city becomes a settlement and its city wall, if any, is removed. A city wall does not protect a city (FAQ, City Walls).
   - If the seat has no settlement piece in its supply, the city piece is turned on its side and counts as a settlement in every way: 1 point, settlement production, no wall, not a city for barbarian strength, and not pillageable again. Before that seat upgrades any other settlement it must upgrade a sideways piece, paying the normal city cost. Upgrading a sideways piece needs no city piece from the supply and returns no settlement. With several sideways pieces they may be upgraded in any order (our choice: only one is ever mentioned).
   - If no seat is eligible (every city is a metropolis), nothing is lost.
6. **Return home.** After every attack the ship goes back to step 0 and **every knight on the board becomes inactive**. The robber is unlocked if it was not already.

A pillage during the active seat's turn takes effect at once, so the pillaged city produces as a settlement on the same roll (FAQ, Barbarians III). Barbarians attack all islands at once, which matters only with seafaring.

## City walls

A wall costs 2 brick and goes under one of the seat's own cities, at most one per city and three per seat. Each wall adds 2 to the 7-discard limit. It is removed when its city is pillaged, and returns to the seat's supply. A city wall does not stop pillage and does not affect anything else (2025 p.8; 2020 p.6; FAQ, City Walls). A wall stays when a city becomes a metropolis city.

## The merchant

The single merchant piece starts off the board. Playing a Merchant card (see the trade deck) puts it on a land hex touching one of the player's settlements or cities and gives that seat control. The controller gets 1 point and the 2:1 rate for that hex's resource (never its commodity). Any Merchant card played later, by any seat including the controller, moves the piece and control to the player of that card, and the old controller loses the point (FAQ, Merchant: "No" to keeping the point). The rate belongs to the controller only. The robber and the merchant may share a hex, and the merchant can be used on the turn it is placed (FAQ, Merchant). A merchant on a hex with no resource, such as a desert, still gives the point and no rate (our choice: the publishers say "land hex", and a desert is a land hex).

## Progress cards

### Progress card draws

When the event die shows a gate of colour `C`, every seat whose level `L` on track `C` is at least 1 and whose red die satisfies `r ≤ L + 1` draws one card from deck `C`. That is a red 1 at level 1 for a 1–2 range, up to every red value at level 5. Draws happen in turn order from the active seat, one at a time (FAQ, General: if a deck is short, seats draw in order until it is empty and the rest get nothing).

### Playing a card

- Progress cards are played in the Action phase after the roll is fully resolved, in any order and number, on the same turn they were drawn. The Alchemist is played in the Roll dice phase before rolling. Nothing is played in another seat's turn or in the special build phase.
- **Victory point cards** (Printing, Constitution) are shown and kept face up as soon as they are drawn, even off turn. They never count toward the hand limit and are not in the hand for Spy.
- A played card is shown face up, resolved, and placed face down at the **bottom of its own deck**. There is no discard pile and decks are never reshuffled (FAQ, General). VP cards stay in front of their owner and leave the deck.
- A card whose effect may fail **because of information the player cannot have** may be played and still counts as played (monopolies, Commercial Harbor, and the hand contents behind Master Merchant, Wedding and Saboteur). A card that the public state shows cannot do anything cannot be played (FAQ, General: "If you know beforehand that playing the card will have no effect … no"). That covers a Mining or Irrigation with no adjacent hex of that kind, a Medicine with no settlement, a Deserter or Intrigue with no opposing knight, a Bishop before the first attack, a Diplomat with no open road, an Inventor with no valid swap, a Wedding, Master Merchant or Saboteur with no qualifying seat, and a Spy when no other seat holds a progress card (our choice: progress-card counts are public, as the size of a physical hand is).
- **Hand limit 4.** Off turn a seat over 4 discards at once. On its own turn it may go over and must be at 4 or fewer when it ends the turn (`END_TURN` fails until it discards). A discarded card goes face down to the bottom of its deck, and the identity stays hidden. A seat may not discard a card unless it is over the limit (FAQ, General: "No").
- Progress cards cannot be traded or stolen except by the Spy.

Comparisons of "more points" use public points. In this module every point is public, so the comparisons need no hidden information. Points count settlements, cities, metropolises, Longest Road, the merchant, Defender cards and VP cards.

### Card catalogue

Ids in the first column match the plan. The 2025 rulebook renamed several cards, given in the second column. All 54 are used with any player count.

**Science (green, 18)**

| Card (2025 name)       | Count | Effect and timing                                                                                                                                                                                                                   | P2P hidden information                       |
| ---------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Alchemist (Alchemy)    | 2     | Roll dice phase only, before rolling. Set both production dice, then roll the event die. See [Dice](#dice-and-the-event-die).                                                                                                       | None beyond the card's identity when played. |
| Crane                  | 2     | With a city improvement purchase: that improvement costs 1 commodity less, and level 1 becomes free. One Crane per improvement. Two Cranes in a turn may discount two different improvements, and never one twice (FAQ, Crane).     | None.                                        |
| Engineer (Engineering) | 1     | Build one city wall for free (a city without a wall, and fewer than 3 walls). Not before a 7's discards (FAQ, Engineer).                                                                                                            | None.                                        |
| Inventor (Invention)   | 2     | Swap two number tokens on land hexes, neither being 2, 6, 8 or 12, and of different values. No adjacent building is needed. Either hex may hold the robber, which stays on its hex and blocks the new number (FAQ, Inventor).       | None.                                        |
| Irrigation             | 2     | Take 2 grain for each fields hex touching at least one of your buildings. Cities do not double it. The robber does not matter (the card says nothing about it). If the bank runs short, take what remains (2025 p.13).              | None.                                        |
| Medicine               | 2     | With a city upgrade: pay 1 grain and 2 ore instead of 2 grain and 3 ore. One Medicine per upgraded settlement (FAQ, Medicine). Every other city rule applies, including a sideways piece first.                                     | None.                                        |
| Mining                 | 2     | Take 2 ore for each mountains hex touching at least one of your buildings. Cities do not double it. Short bank as for Irrigation.                                                                                                   | None.                                        |
| Printer (Printing)     | 1     | VP card: 1 point, played at once when drawn.                                                                                                                                                                                        | Revealed to all seats on draw.               |
| Road Building          | 2     | Build two roads for free, one after another, under the base road rules. The player may skip either. The card is spent.                                                                                                              | None.                                        |
| Smith (Smithing)       | 2     | Promote up to two of your knights one level each for free, active state unchanged. Basic to strong needs nothing, strong to mighty needs Politics level 3, mighty cannot be promoted. Each knight at most once a turn (FAQ, Smith). | None.                                        |

**Trade (yellow, 18)**

| Card (2025 name)             | Count | Effect and timing                                                                                                                                                                                                                                                                                                               | P2P hidden information                                                                                                                                            |
| ---------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commercial Harbor            | 2     | For the rest of the turn the player may offer each other seat, at most once each, one resource card of the player's choice, face down. The offered seat gives back one commodity card of its own choice. A seat with no commodity returns the offer. The card is spent even if nobody had a commodity (FAQ, Commercial Harbor). | The offered resource stays hidden from the recipient until the swap, the recipient's commodity choice is private, and a seat that has no commodity must prove it. |
| Master Merchant (Guild Dues) | 2     | Choose a seat with more points than you. Look at its resource and commodity cards and take any 2 of your choice.                                                                                                                                                                                                                | The target reveals its whole hand to the actor only. Two chosen cards then move, with proofs against the target's committed hand.                                 |
| Merchant                     | 6     | Take the merchant, place it on a land hex touching one of your buildings. +1 point while you control it. See [The merchant](#the-merchant).                                                                                                                                                                                     | None.                                                                                                                                                             |
| Merchant Fleet               | 2     | Name one resource or commodity. For the rest of the turn you may make any number of 2:1 bank trades giving that kind (FAQ, Merchant Fleet).                                                                                                                                                                                     | None.                                                                                                                                                             |
| Resource Monopoly            | 4     | Name a resource. Each other seat gives you 2 cards of it, or its only one.                                                                                                                                                                                                                                                      | Each seat's count of the named kind is revealed if the public bounds do not prove it, then the transfer follows (the same as the base monopoly).                  |
| Trade Monopoly               | 2     | Name a commodity. Each other seat gives you 1 card of it, if it has one.                                                                                                                                                                                                                                                        | The same as Resource Monopoly.                                                                                                                                    |

**Politics (blue, 18)**

| Card (2025 name)        | Count | Effect and timing                                                                                                                                                                                                                                                                                                                                                                                                                              | P2P hidden information                                                                                                                        |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Bishop (Taxation)       | 2     | Only after the first attack. Move the robber to a different land hex, even one with no adjacent building, and steal 1 random resource or commodity card from **each** other seat with a building there, one card per seat however many buildings it has there. Progress cards are never taken.                                                                                                                                                 | One random hidden steal per victim, proved as in base. Several victims in turn order.                                                         |
| Constitution            | 1     | VP card: 1 point, played at once when drawn.                                                                                                                                                                                                                                                                                                                                                                                                   | Public on draw.                                                                                                                               |
| Deserter (Treason)      | 2     | Choose another seat with a knight on the board. It removes a knight of its choice. You may place one of your own knights of the **same or lower level**, from your supply, on an empty vertex touching your roads. It takes the removed knight's active state, and needs no Fortress even for a mighty knight. A knight that arrives active can act the same turn. If you cannot place one, the victim still loses its knight (FAQ, Deserter). | None hidden. The victim's choice is public.                                                                                                   |
| Diplomat (Diplomacy)    | 2     | Remove one **open** road, anyone's. A road of another seat returns to that seat's supply. If it was yours, you may build one road for free on a legal edge (not the same edge). The removal may not leave a knight disconnected from a settlement or city, and may leave a building with no road. Longest Road is settled after both steps (FAQ, Diplomat).                                                                                    | None.                                                                                                                                         |
| Intrigue                | 2     | Displace an opposing knight as in a displace action, without using a knight of yours and without a strength comparison. The knight must stand on a vertex where one of your roads ends. Its owner relocates it as after any displace.                                                                                                                                                                                                          | None.                                                                                                                                         |
| Saboteur (Sabotage)     | 2     | Each other seat with as many or more points than you discards half of its resource and commodity cards, rounded down, of its own choice. The discards return to the bank.                                                                                                                                                                                                                                                                      | Each affected seat makes a private choice, revealed when the cards return to the bank (the bank counts are public).                           |
| Spy (Espionage)         | 3     | Choose another seat holding progress cards. Look at them and you may take one. A card taken can be another Spy, played at once or kept. VP cards are never in a hand.                                                                                                                                                                                                                                                                          | The target's progress cards are revealed to the actor only, per card and proved, then the chosen card moves. The target then holds one fewer. |
| Warlord (Encouragement) | 2     | Activate all your knights for free. They cannot act this turn unless they were already ready. See [Readiness](#knights).                                                                                                                                                                                                                                                                                                                       | None.                                                                                                                                         |
| Wedding                 | 2     | Each other seat with more points than you gives you 2 cards of its choice (resource or commodity), or all it has if that is fewer.                                                                                                                                                                                                                                                                                                             | Each giver's choice is private until the transfer, and the actor sees the two cards. Only the counts are visible to the others.               |

Deck order and draws are hidden. The three decks use three deck ids in the P2P deck protocol. Because played and discarded cards go back **under** the deck and a face-down discard is unknown to the others, the deck protocol needs a bottom insertion (a played card's identity is public, a discarded card's is not). That is a note for the protocol stage.

### Hidden-information summary

- **Draws** from a deck are private to the drawer, except VP cards, which are public on draw. Tied Defender draws and gate draws use the same mechanism.
- **Private reveals to one seat:** Master Merchant (a whole hand), Spy (progress cards), Commercial Harbor (the offered card at the swap).
- **Private choices by other seats:** Wedding, Saboteur, Commercial Harbor (the returned commodity), and the victim's knight choice in Deserter (which is public once made).
- **Hidden steals:** Bishop, chase-away and the 7 (random, as in base).
- **Count reveals:** Resource Monopoly and Trade Monopoly.
- **No hidden victory points** exist in this module, so victory checks and "more points" comparisons are always public.

## Victory points

| Source                                 | Points               |
| -------------------------------------- | -------------------- |
| Settlement (a sideways city piece too) | 1                    |
| City                                   | 2                    |
| Metropolis (on top of its city)        | 2, so 4 for the city |
| Longest Road                           | 2                    |
| Defender of Catan card                 | 1 each               |
| Printing, Constitution                 | 1 each               |
| Merchant (while controlled)            | 1                    |

The target is 13 (`vpTarget`). A seat wins when it has 13 or more at any moment during its own turn, checked as in base. Points gained or lost on another seat's turn are not checked until that seat's turn (2025 p.10). There is no Largest Army, and no development card gives points.

## Five-six

`knights` with `five-six` follows the special build phase rules of [five-six.md](five-six.md), plus:

- The commodity bank is 18 of each (12 from the base set, 6 from the extension), and two more Defender cards exist. The progress decks are not enlarged, and the barbarian track (7 steps) and the seat pieces (6 knights, 3 walls, 3 improvement markers) are unchanged.
- The board follows the `five-six` board rules, and the track fixture is placed as described in [hooks.md](hooks.md). The robber starts on the desert with the lowest hex id (see [Components and setup](#components-and-setup)).
- **Special build phase.** During the phase a seat may build roads, settlements, cities, knights, city walls and city improvements, and may **activate and promote** knights. It may not take knight actions (move, displace or chase away), play progress cards, or trade with seats or the bank. There are no development cards to buy, so `BUY_DEV_CARD` is not legal (5–6 (2020): "this option is no longer available").
- A knight activated in the special build phase can act on its owner's next turn, because it is then active at the start of that Action phase (5–6 (2020), the Leif example).
- The event die, progress draws, barbarian moves and attacks happen only on the active seat's roll. A seat that gains points in the phase wins at the start of its own turn, before it rolls (as in [five-six.md](five-six.md)).

## Removed rules

Development cards and Largest Army do not exist with this module. Its `devDeck` hook returns an empty deck, so no development card can be bought or played and Largest Army is never awarded. The `BUY_DEV_CARD` command must be refused with an empty deck, and the UI hides the award. "Knight" in this module always means the C&K piece, never a development card.

## Differences between the editions

Where the editions differ, the 2025 text is implemented.

| Topic                  | 2020 (fifth edition)                                                                                               | 2025 (sixth edition, implemented)                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Card names             | Master Merchant, Warlord, Spy, Deserter, Bishop, Saboteur, Diplomat, Alchemist, Engineer, Inventor, Printer, Smith | Guild Dues, Encouragement, Espionage, Treason, Taxation, Sabotage, Diplomacy, Alchemy, Engineering, Invention, Printing, Smithing |
| Deserter               | Placed knight has equal strength (a basic knight if the equal piece is unavailable)                                | Same strength **or lower**, status copied, mighty allowed without the Fortress                                                    |
| Diplomat               | An open road is a road end with nothing of the owner attached. May remove your own road and not replace it         | A road is open if an end is free and it is not on a route joining two of your buildings or knights. Own road: build one road free |
| Robber start           | On the desert                                                                                                      | Beside the barbarian track, placed on the desert at the first attack                                                              |
| Displaced knight       | Moves to any empty vertex connected by roads to where it stood                                                     | Follows the move rules (own roads, past own pieces only)                                                                          |
| Level 4 and 5 purchase | Levels beyond 3 need a city that could hold a metropolis                                                           | Same, and the text names level 5 too. A first-to-level-4 metropolis is "temporary", level 5 "permanent"                           |
| Progress hand limit    | Discard when a fifth card is drawn off turn                                                                        | Off turn at once, on turn by the end of the Action phase (also FAQ)                                                               |
| Defender reward        | 6 cards                                                                                                            | 6 tokens (FAQ: unlimited in effect)                                                                                               |
| Level 3 trade name     | Trading House                                                                                                      | Merchant Guild (Trading House is level 2)                                                                                         |
| Irrigation, Mining     | Silent on a short bank                                                                                             | Take as many as remain                                                                                                            |
| Five-six               | Special build phase                                                                                                | Paired players (not implemented)                                                                                                  |

## Differences from the stage plan

Implementers must know these differences from [13-knights-and-commerce.md](../13-knights-and-commerce.md):

- **Barbarian strength** counts a city with a metropolis **once**. The plan's "cities + metropolises" is not a double count. A sideways (pillaged, no supply) city piece is a settlement and does not count.
- **Deserter** places a knight of the same or a lower level, copies the removed knight's active state, and needs no Fortress for a mighty one. The plan said "equal strength".
- **Pillage with no settlement piece:** the city piece lies on its side, counts as a settlement, and must be upgraded before any other settlement. This adds a per-city flag to the state.
- **Metropolis:** a seat cannot regain a metropolis it lost, the metropolis is permanent once taken at level 5, and a holder buying its own level 5 needs no available city (our choice). The plan's "no level 4+ without an available city" otherwise stands.
- **Progress hand limit:** on your own turn you have until the end of the Action phase, and `END_TURN` fails while you hold 5. Off turn the discard is immediate and comes before production. The plan left both open.
- **Readiness:** a knight acts only if it was active when the Action phase began. Warlord, activation and recruiting never make a knight ready for the same turn. A Deserter knight that arrives active can act at once.
- **Displaced knight:** relocation uses the move rules (own roads, past own pieces only). If none exists it is removed.
- **Intrigue:** the target must stand on a vertex where one of your roads ends. No strength comparison applies.
- **Bishop:** not before the first attack, and one card per victim.
- **Commercial Harbor:** a turn-long window with one offer per seat, not a single sweep. A seat with no commodity returns the resource.
- **Crane and Medicine** are played as part of the purchase (our choice), and one card covers one improvement or one upgrade. Crane may make level 1 free.
- **Knights block your own settlement sites** too. A knight must be moved off a vertex before you build there.
- **Trading:** commodities take part in 4:1, and in 3:1 harbor trades. A 2:1 harbor stays tied to its resource. Trade level 3 lets you give 2 identical commodities for 1 of anything.
- **Aqueduct** needs no card of either kind (a commodity counts as production), and it works after robber, shortage or no-building outcomes.
- **Defender cards are unlimited** (FAQ), and a top contribution of 0 awards nothing (our choice).
- **Five-six:** commodity bank 18, 2 more Defender cards, no deck or track change, and the special build phase limits above.
- **The robber** is created on the desert and locked, instead of being off the board. The result is the same.
- **Level 3 names** differ between editions (cosmetic).
- The plan's card names are the 2020 names. They stay the engine ids, and the UI may show the 2025 names.

## Engine mapping and defaults

Hooks from [hooks.md](hooks.md) the module uses:

| Rule                                                               | Hook                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| paper, cloth, coin                                                 | `cardKinds`, `bankInit`                                  |
| no development deck                                                | `devDeck` (empty)                                        |
| costs (wall, knight, promote, activate, levels)                    | `costs`, `costOf`                                        |
| red, yellow, event die                                             | `diceSpec`, `onDiceResult`                               |
| city commodities                                                   | `production`                                             |
| Aqueduct                                                           | `onNoProduction`                                         |
| setup city, knight and wall placement                              | `placement.city`, `placement.settlement`, `connectivity` |
| knights breaking roads                                             | `routeGraph` (`blocked` vertices)                        |
| robber lock                                                        | `robberLike`, `stealTargets`                             |
| 7 limit                                                            | `handLimit`                                              |
| 13 points, metropolises, Defender, merchant                        | `victoryPoints`, `vpTarget`                              |
| displaced relocation, progress discards, pillage choice, tie draws | `pending`, `turnFlow`, `legalCommands`, `timeoutAction`  |

**Timeout defaults** (our choice, deterministic, for `TIMEOUT` on a module-owned pending):

- Displaced knight: the empty legal vertex with the lowest id, or removal if none.
- Pillage choice: the seat's non-metropolis city with the lowest vertex id.
- Defender tie draw: the first deck, in the order science, trade, politics, that still has cards.
- Aqueduct: the first resource in canonical order that the bank holds.
- Hidden choices (progress discard, Saboteur, Wedding, Commercial Harbor, Spy, Master Merchant): decided by the owner's client. A timeout is handled the way base handles a discard it cannot decide from public information.

## Cases the rulings above fix (for tests)

- Alchemist sets 7 before the first attack: discards happen, no robber move.
- First attack on a 7 roll: all knights go inactive, then the robber is active for that 7.
- A tie at the top of the contribution ranking, and a tie at the bottom.
- Only-metropolis and no-city seats skipped in pillage. All cities metropolises.
- Pillage with no settlement piece, then upgrading that piece before any other settlement.
- Level 4 with no available city. Level 5 by the holder with one city. Level 5 taken from a level-4 holder, and the old holder unable to regain it.
- A knight activated this turn refuses to act. A knight that acted and was reactivated refuses to act again. A Deserter knight that arrives active acts.
- Displacement chains: displaced owner with no vertex, and a vertex only reachable through an opposing knight.
- Diplomat that would disconnect a knight, and the loop cases of an "open" road.
- Aqueduct on a robber-blocked roll, a shortage-blocked roll and a commodity-only roll.
- Progress hand limit off turn, and at turn end on turn.
- A short deck at a draw with several seats entitled.

## Recorded for the seafaring combination

From 2025 p.12 and 2020 p.13, for the later combo task, not implemented here: rules for roads also apply to ships. The pirate sits on the final space of the barbarian track and enters play only after the first attack. Knights move over routes of roads and ships, may end on a sea vertex, and must stay connected, so a ship that would break that connection cannot move. A knight on a sea vertex can chase away the pirate. Taxation moves only the robber. Diplomacy on a ship places a ship. Gold fields give resources only and the merchant cannot stand on one. The barbarians attack every island at once. The winning score of a Seafarers scenario rises by 2 points.
