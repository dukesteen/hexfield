# Base rules as implemented

The base module supports two through four seats. Its defaults and extensions are recorded in each game's `base` options. This document records the behavior implemented by the module; the project's engine specification remains authoritative where it defines online or deterministic-play behavior beyond the tabletop rules.

The component counts, costs, production, setup-resource timing, distance rule, trade rates, development-card timing, and victory-point sources were cross-checked against the [publisher's base-game rules and almanac](https://www.catan.com/sites/default/files/2021-06/catan_base_rules_2020_200707.pdf). Board balancing, hidden-hand bounds, automated victory claims, and the deterministic-input model are project rules.

## Components and costs

The island has 19 land hexes: four each of forest, pasture, and fields; three each of hills and mountains; and one desert. Forest produces lumber, pasture wool, fields grain, hills brick, and mountains ore. The 18 numbered tokens are `2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12`. There are nine harbors: four generic 3:1 harbors and one 2:1 harbor for each resource.

The bank starts with 19 cards of each resource. Each seat starts with five settlements, four cities, and 15 roads. The development deck contains 14 knights, five victory-point cards, two road-building cards, two year-of-plenty cards, and two monopoly cards.

| Action           | Cost                               |
| ---------------- | ---------------------------------- |
| Road             | 1 brick, 1 lumber                  |
| Settlement       | 1 brick, 1 lumber, 1 wool, 1 grain |
| City             | 2 grain, 3 ore                     |
| Development card | 1 wool, 1 grain, 1 ore             |

## Board generation

`mapLayout` selects one of three modes. `standard-fixed` requires a supplied board with the standard 19 coordinates, terrain and token counts, nine harbor positions and kinds, no starting pieces, and the robber on the desert. The maps package supplies an original fixed board. `random` shuffles the component sets without balancing token adjacency. `balanced-random` shuffles the same sets and uses deterministic backtracking to place tokens.

Balanced layouts prohibit adjacent red numbers (6 and 8) and adjacent duplicate numbers. With `strictBalance`, 2 and 12 may not touch, and the total pip weight by terrain is capped at 14 for the four-hex resource terrains and 11 for three-hex terrains. Token search is capped at 10,000 attempts per terrain layout; balanced generation retries at most 100 terrain layouts before returning `BOARD_GENERATION_FAILED`. The desert receives no token and holds the robber at genesis.

## Setup and placement

The engine receives the starting seat as a random system input. Setup places one settlement and a touching road for each seat in forward seat order, then repeats in reverse order. Settlements in setup need an empty land vertex and the distance rule but do not need a connected road. A seat receives one resource from each adjacent producing hex after its second settlement.

During play, a road must use an empty edge connected to the seat's road network or one of its buildings. A road cannot continue through an opponent's building. A settlement must be on an empty land vertex, satisfy the distance rule, and touch the seat's road. A city replaces the seat's own settlement and returns that settlement piece to supply. Every placement is limited by the pieces remaining in the seat's supply.

## Turn flow, sevens, and the robber

The active seat rolls in `preRoll`. On a non-seven, production resolves before `main`. On a seven, each seat holding more than `discardLimit` cards discards half its hand, rounded down. All required discards resolve before the active seat moves the robber to another land hex. The desert is a legal destination. If an opponent has a building on the destination and a nonempty hand, the active seat chooses an eligible victim. The engine then receives the steal result as a system input.

`friendlyRobber` removes hexes adjacent to any seat with at most two public points. If that leaves no destination, every different land hex becomes legal. Knight cards use the same move-and-steal sequence without the seven's discard step. A victim must have a settlement or city touching the destination, must not be the active seat, and must have at least one resource card.

## Production and bank shortage

On a non-seven roll, every matching land hex without the robber produces one card per adjacent settlement and two per adjacent city. Shortage is evaluated independently for each resource. If the bank can satisfy the total demand, it pays every seat. If it cannot, a sole demanding seat receives the remaining stock; if multiple seats demand that resource, none receive it for that roll. Public resource bounds and each owner's private hand are updated together.

## Longest Road and Largest Army

Longest Road requires at least five segments. The engine measures the longest trail in a seat's road graph: it may revisit vertices but cannot reuse an edge. It cannot pass through an opponent's building, though a trail may end there. The first qualifying seat takes an unheld award; another seat must strictly exceed the current holder. If the holder is cut, a tied maximum keeps the award; otherwise a unique qualifying maximum takes it, and a tied maximum among other seats or no qualifying length leaves it unheld.

Largest Army requires at least three knights played. An unheld award goes to the first qualifier, and a new seat takes it only by strictly exceeding the current holder's knight count.

## Development cards and victory

The deck has 14 knights, five victory-point cards, two road-building cards, two year-of-plenty cards, and two monopoly cards. Buying a card costs one wool, one grain, and one ore. The public state records a face-down slot and the owner receives the card identity privately. A card cannot be played during the turn it was acquired. Each seat may play at most one non-point card per turn, including a card played before rolling.

A knight moves the robber and may steal from an eligible opponent. Road building opens a temporary phase for up to two free legal roads; the player can skip either placement, and the phase ends when no legal road or piece remains. Year of plenty requests exactly two cards, of one or two resource types. For each requested type, the bank supplies the smaller of the requested amount and its stock. The bank does not substitute another type. Monopoly names one resource; each opponent transfers all cards of that type. Opponent counts are revealed before the transfer when the public bounds do not already prove the count is zero.

Settlements score one public point and cities score two. Longest Road and Largest Army each score two public points. Victory-point cards contribute one hidden point each and are never played. The default target is 10. Public points reaching the target end the game after an input on that seat's turn. A hidden-point win requires `CLAIM_VICTORY` with enough owned victory-point slots. The claim is allowed during the active seat's turn, including an interrupt phase.

## Options

| Option           | Default           | Implemented behavior                                                                                                                                                          |
| ---------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vpTarget`       | 10                | Integer target from 3 through 20.                                                                                                                                             |
| `discardLimit`   | 7                 | On a seven, a seat over this hand size discards half its total, rounded down.                                                                                                 |
| `friendlyRobber` | `false`           | Restricts robber destinations adjacent to seats with at most two public points unless no permitted destination remains.                                                       |
| `mapLayout`      | `balanced-random` | `standard-fixed`, `random`, or `balanced-random`.                                                                                                                             |
| `strictBalance`  | `false`           | Enables the 2/12 adjacency and per-resource pip caps for balanced generation.                                                                                                 |
| `playerTrades`   | `true`            | Enables player offer, response, confirmation, and cancellation commands.                                                                                                      |
| `diceMode`       | `random`          | `random` requests two dice faces; `balanced` draws an ordered pair from a public 36-pair deck. When six or fewer remain, the next roll resets the full deck before drawing.   |
| `turnTimer`      | `null`            | Optional positive safe-integer seconds for `preRoll`, `main`, `discard`, and `robber` phases. The engine defines deterministic timeout actions; the transport owns the clock. |
| `hideBankCounts` | `false`           | UI preference only; it does not alter engine state or rules.                                                                                                                  |

## Trading

A maritime trade exchanges resources with the bank at 4:1, 3:1 with a generic harbor, or 2:1 with the matching resource harbor. A command may include several outgoing resource types. Each outgoing amount must be a multiple of its rate, and the total requested output must equal the converted amount. The bank must hold every requested resource, and a trade cannot return the same type it gives.

When `playerTrades` is enabled, the active seat can offer resources to selected opponents or all opponents. Recipients may accept or decline. The active seat completes an accepted offer with `CONFIRM_TRADE`; the engine checks both parties can still pay at confirmation. A non-active seat may send a counter-offer to the active seat, which the active seat can confirm directly. Each seat may have one open offer; making another replaces that seat's previous offer with a new id and clears all earlier responses. The active seat can cancel any offer. A proposer can cancel their own offer, while a recipient who accepted can withdraw that acceptance, which records a decline. Open offers close at end of turn. An offer made unaffordable by later hand changes remains visible as invalid. A response pending has the `mainSec` deadline; a proposal-only pending has no response deadline.

## Development-card shortage interpretation

Year of Plenty requests exactly two resource cards, each of which may be the same or a different type. The bank returns the available amount of each requested type; it does not substitute an unrequested type. This partial-fulfillment behavior is the project's interpretation of its specification, not a claim about the publisher's tabletop rule.

## Timers, random outcomes, and hidden transfers

`turnTimer` stores optional positive safe-integer durations for `preRoll`, `main`, `discard`, and `robber`. The engine does not run a clock. `preRollSec` applies to `preRoll`, `mainSec` to `main` and `roadBuilding`, `discardSec` to `discard`, and `robberSec` to `moveRobber` and `steal`. A `TIMEOUT` input rolls during `preRoll`, picks the first legal robber hex that does not touch the active seat when possible, chooses the first eligible victim, ends the active seat's main turn, skips the road-building remainder, or declines a pending trade response. For a timeout discard, it sorts resource piles once by their starting counts, largest first, with ties in canonical resource order. It empties each pile before moving to the next until it has discarded half the starting hand. A zero-card discard is skipped. A timeout cannot determine a discard from public bounds alone when resource identities remain hidden, so the owner's private state or escrow must supply it.

The engine does not generate mid-game randomness. Dice, development-card draws, and steal results arrive as system inputs. In balanced-dice mode the public deck contains all 36 ordered dice pairs. It resets to all pairs when six or fewer remain at the next roll, then removes the selected pair. A local driver may resolve random inputs with a private source; online play can use the protocol's randomness and hidden-draw mechanisms. A known steal transfers an exact resource. A hidden steal updates public hand bounds by removing and adding one unknown card, while private states receive the actual card separately.

## Rule test map

| Rule family                                                   | Focused tests                                                                                                                                                               |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Board generation, token balance, and harbor layout            | `packages/engine/src/modules/base/setup/board/index.test.ts`, `packages/maps/src/index.test.ts`                                                                             |
| Setup and placement                                           | `packages/engine/src/modules/base/base.test.ts`, `packages/engine/src/modules/base/placement/index.test.ts`, `packages/engine/src/modules/base/test/negative-rules.test.ts` |
| Options and base invariants                                   | `packages/engine/src/modules/base/test/options-invariants.test.ts`                                                                                                          |
| Production, development cards, trading, and victory           | `packages/engine/src/modules/base/rules.test.ts`                                                                                                                            |
| Seven, robber, discards, steals, and timeouts                 | `packages/engine/src/modules/base/test/robber-timeout.test.ts`                                                                                                              |
| Legal command lists and hidden choices                        | `packages/engine/src/modules/base/test/legal.test.ts`                                                                                                                       |
| Awards                                                        | `packages/engine/src/modules/base/awards/index.test.ts`                                                                                                                     |
| Full-game replay and options                                  | `packages/engine/src/modules/base/test/scenario.test.ts`                                                                                                                    |
| Engine validation, invariants, and local private-state checks | `packages/engine/src/core/pipeline/engine.test.ts`                                                                                                                          |
