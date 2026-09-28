# Module hook catalogue

Stage 11 fixes the hooks through which expansion modules change the rules. The types live in `packages/engine/src/core/modules/types.ts` (`Hooks`) and the composition in `core/modules/registry.ts`.

## Ordering and composition

Hooks run in module order: dependency order first, then module id. `createRegistry` computes that order once, so it never depends on the order modules are passed in. There are two kinds of hook:

- **Accumulator hooks** take the value built so far as their last argument and return a new value. The first module receives the caller's starting value. Where base owns the default, base passes its own constant as that starting value, so a hook only needs to express a change. For example, `bankInit` starts from the 19-card base bank, and `five-six` maps each kind to 24.
- **State hooks** take and return the whole `GameState`.

Hooks never mutate their arguments. The kitchen-sink test in `packages/engine/test/kitchen-sink.test.ts` checks that every hook below is called, that a dependency's hook runs before its dependent's, and that registration order has no effect.

## Catalogue

| Hook                                                       | Kind        | Starting value at the call site      | Call site                                                                                          |
| ---------------------------------------------------------- | ----------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `seatRange(config, acc)`                                   | accumulator | `{ min: 2, max: 6 }`                 | `createGame` config check. Base narrows it to 2–4; `five-six` to 5–6.                              |
| `boardSpec(config, acc)`                                   | accumulator | `null`                               | Base `buildBoard` (generator and fixed-board validation) and genesis fixture placement.            |
| `boardFixtures(config, board, acc)`                        | accumulator | `[]`                                 | `createGame`, after every `buildBoard`. Declarations are assigned to slots in order.               |
| `cardKinds(acc)`                                           | accumulator | base resources                       | Base public and private supply invariants.                                                         |
| `bankInit(config, acc)`                                    | accumulator | base bank (19 each)                  | Base `initializeState`; base supply invariants.                                                    |
| `pieceLimits(config, acc)`                                 | accumulator | 5 settlements, 4 cities, 15 roads    | Base `initializeState`; base piece invariants.                                                     |
| `devDeck(config, acc)`                                     | accumulator | 25-card base composition             | Base `initializeState`; deck invariant; `devCardCatalogueFor` for the P2P deck ceremony.           |
| `costs(config, acc)`                                       | accumulator | base cost table                      | `buildCost`, before `costOf`.                                                                      |
| `costOf(state, buildType, cost)`                           | accumulator | the `costs` entry                    | `buildCost` for every build and purchase, including legal-command enumeration.                     |
| `diceSpec(state, acc)`                                     | accumulator | two six-sided dice, no extra dice    | The `dice` phase random request (random mode).                                                     |
| `onDiceResult(state, dice)`                                | state       | —                                    | `DICE_RESULT`, before production or the 7 branch. Also used for the owner's private production.    |
| `production(state, roll, acc)`                             | accumulator | base demand by seat                  | `productionPayments`, before the per-resource bank-shortage rule.                                  |
| `onNoProduction(state, seat)`                              | state       | —                                    | `DICE_RESULT` on a non-7 roll, for each seat that received nothing.                                |
| `placement.settlement / road / city(state, seat, loc, ok)` | accumulator | base legality                        | Setup placements, builds, free roads and legal-command enumeration.                                |
| `connectivity(state, seat, acc)`                           | accumulator | the seat's road edges                | Road and settlement connection checks and enumeration.                                             |
| `routeGraph(state, seat, acc)`                             | accumulator | the seat's roads, opponent buildings | Longest-road length and award recomputation.                                                       |
| `robberLike(state, acc)`                                   | accumulator | the robber and its legal hexes       | `MOVE_ROBBER` validation, enumeration and the timeout robber choice.                               |
| `stealTargets(state, seat, blocker, hex, acc)`             | accumulator | occupied opponents with cards        | After a blocker moves.                                                                             |
| `handLimit(state, seat, limit)`                            | accumulator | `discardLimit` option                | The 7 branch of `DICE_RESULT`.                                                                     |
| `afterBuild(state, seat, type, loc)`                       | state       | —                                    | After every placement and build.                                                                   |
| `onTurnStart(state, seat)` / `onTurnEnd(state, seat)`      | state       | —                                    | `END_TURN` and the end of setup.                                                                   |
| `turnFlow(state, acc)`                                     | accumulator | `[]`                                 | `END_TURN`. Non-empty frames run between turns above a base `turnEnd` marker.                      |
| `pending(state, acc)`                                      | accumulator | the top phase's pending list         | `getPending`, so a module can allow its commands in another module's phase.                        |
| `victoryPoints(state, seat, priv, acc)`                    | accumulator | `[]`                                 | `computeVictoryPoints`. Base contributes hidden victory-point cards.                               |
| `vpTarget(config, acc)`                                    | accumulator | base `vpTarget` option               | Public victory check, `CLAIM_VICTORY` and the automatic hidden claim.                              |
| `legalCommands(state, seat, priv, acc)`                    | accumulator | the top phase's legal set            | `getLegalCommands`, before the final validation filter.                                            |
| `timeoutAction(state, request, acc)`                       | accumulator | `null`                               | `TIMEOUT` when a module owns the top phase. The returned command is dispatched as the auto-action. |
| `renderHints(state, acc)`                                  | accumulator | `[]`                                 | UI only, through `engine.hooks.renderHints`. Never read by rules.                                  |

## Turn flow

`END_TURN` asks `turnFlow` for frames. With none, the next turn starts at once, as it did before stage 11. Otherwise, base replaces the ending phase with a `turnEnd` marker and pushes the frames so the first one is on top. The owning module leaves its frame with `finishTurnFlowFrame`. When only the marker is left, the next seat's turn begins in the same input. While the marker is on the stack, nobody can win or claim victory: the ending seat's turn is over and the next seat's has not begun. The next seat's public points are checked when its turn begins.

## Board fixtures

A fixture is `{ id, module, slot, footprint, orientation, art }` in `board.fixtures`. The field is present only when a module declares a fixture, so boards without fixtures hash exactly as before. Rules never read fixtures. The anchor stays a sea-frame hex for every rule, and robber, harbor and production code only look at land hexes and harbor edges. A board with too few slots fails genesis with `NO_FIXTURE_SLOT`.

A slot's anchor is a sea-frame hex that touches land and has no harbor. Its outer hex is the next hex straight out from a land hex through the anchor, and lies beyond the frame. `boardShapeProblems` checks every shape. The fixed slots are:

| Shape      | Slot         | Anchor   | Outer    |
| ---------- | ------------ | -------- | -------- |
| `standard` | `north`      | `h:0,-3` | `h:0,-4` |
| `five-six` | `north-west` | `h:1,-4` | `h:1,-5` |
