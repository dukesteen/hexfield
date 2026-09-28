# 11 — Module Framework Hardening & 5–6 Players (`five-six`)

## Goal

1. Harden the module system from stage 02, so the large expansions (stages 12–15) can be added without touching base code except through declared hooks.
2. Implement the `five-six` module (5–6 players) as the first real expansion. It validates the framework end to end: engine, UI, lobby, bots, P2P.

## Prerequisites

Stage 10 is complete (the full P2P base game is robust).

## Part A — Framework hardening

### A1. Audit base for hard-coded assumptions

Search `modules/base` and `core` for, and replace with, config- or hook-driven values:

- player counts and seat loops,
- the 19-hex board,
- `RESOURCES` used where "card kinds" are meant,
- costs,
- piece limits,
- the bank size,
- the dev deck composition,
- VP target,
- hand-limit logic,
- robber-only thinking (the pirate will come),
- "one dice pair" (knights module adds an event die),
- terrain → resource mapping (gold, commodities),
- production amounts (a city producing a commodity),
- turn flow (a special build phase gets inserted).

Record each change in DECISIONS.md.

### A2. Final hook catalogue

Extend the hook list from stage 02. Each hook has a precise signature, a documented call site, and an ordering (dependency order, then module id). Hooks return new values; they never mutate.

| Hook                                               | Purpose / used by                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `boardSpec(cfg)`                                   | provide the board shape, tile bag, token bag, harbor slots, fixture slots (five-six, seafaring scenarios) |
| `boardFixtures(cfg, board)`                        | declare board fixtures that sit on the board, e.g. the knights barbarian track (A2a)                      |
| `cardKinds()`                                      | add card kinds (commodities)                                                                              |
| `bankInit(cfg)`                                    | bank sizes                                                                                                |
| `pieceLimits(cfg)`                                 | add piece types (ships, knights, walls)                                                                   |
| `costs(cfg)`                                       | add or modify build costs                                                                                 |
| `diceSpec(state)`                                  | which dice are rolled (knights: + event die)                                                              |
| `onDiceResult(state, dice)`                        | pre-production effects (barbarians, progress cards)                                                       |
| `production(state, roll, acc)`                     | modify/add production                                                                                     |
| `onNoProduction(state, seat)`                      | aqueduct-like effects                                                                                     |
| `placement.<pieceType>(state, seat, loc, verdict)` | legality chains                                                                                           |
| `connectivity(state, seat)`                        | which pieces connect for building and longest route (ships)                                               |
| `routeGraph(state, seat)`                          | graph for longest road / longest trade route                                                              |
| `robberLike(state)`                                | list of movable blockers (robber, pirate) with legal hexes                                                |
| `stealTargets(state, seat, blocker, hex)`          |                                                                                                           |
| `handLimit(state, seat)`                           | city walls                                                                                                |
| `turnFlow(state)`                                  | insert phases, e.g. special build phase                                                                   |
| `victoryPoints(state, seat, priv?)`                | contributions                                                                                             |
| `vpTarget(cfg)`                                    | scenario overrides                                                                                        |
| `legalCommands(state, seat, priv, acc)`            | enumerate module commands                                                                                 |
| `timeoutAction(state, pending)`                    | module-specific auto-actions                                                                              |
| `renderHints(state)`                               | tells the UI about module-specific overlays and fixture state (e.g. the barbarian ship's step)            |

### A2a. Board fixtures

Some expansions put a physical piece on the board that isn't a playable hex. The first is the knights **barbarian track**: in the physical game it's a piece two hexes long, printed with the ship's path. It replaces one sea-frame hex, so it touches the land, and sticks straight out from the island by one more hex. Model and draw it as part of the board, not as a HUD widget.

- A **fixture** is `{ id, module, footprint: HexCoord[], orientation, art }`. The footprint is a list of edge-adjacent hex positions; the barbarian track uses 2.
- Each board shape in `@cp2p/maps` declares **fixture slots**, where fixtures may go. A 2-hex slot has:
  - an **anchor** hex: a sea-frame hex that touches at least one land hex and has no harbor. The fixture replaces this frame hex,
  - an **outer** hex: the neighbour of the anchor directly outward from the island, beyond the frame (normally empty space),
  - a fixed position per board shape (not random), so the same layout always looks the same. The harbor slots for that board shape must not use the anchor hex.
- `boardFixtures(cfg, board)` returns the fixtures for the game. At genesis they are assigned to slots in declaration order, and the placement is part of the board and the state hash. Genesis fails with `NO_FIXTURE_SLOT` if a board has too few slots. Scenario boards (A5) declare their own slots.
- Fixtures are **not** hexes for any rule. For rules, the anchor still counts as the frame hex it replaced: land edges and vertices next to it stay coastal. No harbor, ship or pirate can ever be on a fixture hex, and production and the robber ignore it. The module keeps the fixture's live state in its own module state; e.g. the ship's step lives in the knights state, not in the board.
- Every board shape that can be combined with `knights` in the compat matrix (A3) must declare at least one slot that fits a 2-hex fixture: base, `five-six`, and later the seafaring scenario boards.

`packages/engine/src/modules/compat.ts` declares allowed combinations, and the lobby uses it to disable invalid choices:

|           | five-six | seafaring | knights                   | frontier           | explorers     |
| --------- | -------- | --------- | ------------------------- | ------------------ | ------------- |
| five-six  | —        | ✓         | ✓                         | ✓ (per scenario)   | ✗ (initially) |
| seafaring | ✓        | —         | ✓ (combined rules, later) | ✗                  | ✗             |
| knights   | ✓        | ✓ (later) | —                         | ✓ (some scenarios) | ✗             |
| frontier  | ✓        | ✗         | ✓                         | —                  | ✗             |
| explorers | ✗        | ✗         | ✗                         | ✗                  | —             |

"Later" combinations are disabled until explicitly implemented and tested. The combined rules must then be written in `docs/rules/combos.md`.

### A4. Module UI extension points

- The web app gets a matching registry `uiModules[id]` with optional: `PlayerPanelExtras`, `HudWidgets` (e.g. the barbarian attack countdown when the track is scrolled out of view), `BoardFixtures` (the art and live-state renderer for each fixture id), `ActionBarItems`, `Dialogs` for module phases, `LogFormatters`, `RenderLayers` (renderer plugin interface), `LobbyOptionOverrides`.
- The renderer supports plugin layers with a z-index and a render-model slice.
- Fixtures get their own layer, drawn above sea/background and below terrain: sea/background → fixtures → terrain → …. The sea-frame tile isn't drawn on the anchor hex; the fixture art replaces it and extends into the outer hex. Fixture pieces in the layer (e.g. the barbarian ship) are drawn in the pieces band so they sit on top of the printed track.
- Fixtures count towards the board bounds for camera fit and pan clamping, so fitting the board always shows them.
- Fixtures are hit-testable: tapping one opens its module dialog (for the barbarian track: step, strength vs. active-knight defence, per-player contribution).

### A5. Scenario abstraction

A **scenario** = module list + board definition (fixed or generator) + option overrides + scenario-specific rules module (optional) + VP target. Scenarios live in `@cp2p/maps` as data plus an optional small engine module (`scenario:<id>`). The lobby lists scenarios by the modules they need.

### A6. Framework tests

- A "kitchen-sink" test module exercising every hook, to confirm call order and composition. It also declares a 2-hex fixture.
- Fixture tests: every board shape passes the slot rules in A2a (the anchor is a harbor-free frame hex touching land; the outer hex is directly outward and outside the frame); fixture placement is deterministic from genesis; a fixture changes no rules result (placements, robber targets and production are identical with and without it).
- Base-only golden replays still pass **unchanged** after the refactor (no hash changes; if hashes do change, a reason must be recorded and `engineVersion` bumped).

## Part B — `five-six` module

### Rules

| Item              | 5–6 players                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Land hexes        | 30: 5 hills, 5 mountains, 6 forest, 6 pasture, 6 fields, 2 desert `[VERIFY]`                                                                   |
| Number tokens     | 28 `[VERIFY distribution]`                                                                                                                     |
| Harbors           | 11: 5 generic 3:1 (4 + 1 extra), one 2:1 per resource, plus 1 extra 2:1 wool `[VERIFY]`                                                        |
| Bank              | 24 per resource                                                                                                                                |
| Dev deck          | 34: 20 knight, 5 VP, 3 road building, 3 year of plenty, 3 monopoly                                                                             |
| Per player pieces | unchanged                                                                                                                                      |
| Board shape       | an elongated hexagon (rows of 3-4-5-6-5-4-3 land hexes) `[VERIFY]`. Define the exact coordinates in maps, including a 2-hex fixture slot (A2a) |

- **Special build phase (SBP)**: after the active player ends their turn, each other player in turn order gets an SBP. They may build and buy development cards, but **not trade** (neither player nor maritime) and **not play** development cards. The SBP ends with `END_SBP` (or a timeout). Then the next player's turn begins.
  - Colonist-style option `specialBuildPhase: true` (default for 5–6), plus an alternative option `pairedPlayers` `[VERIFY]` kept out of scope for now; record it in DECISIONS.md.
  - Implement SBP via the `turnFlow` hook as a sequence of `sbp { seat }` frames.
- Balance constraints apply to the larger board (no adjacent 6/8, etc.).
- Colours: add 2 player colours to the colour-blind-safe palette (6 total, each with a distinct pattern).
- Longest road, largest army: unchanged.

### UI

- The larger board must fit on mobile, including a declared fixture. Test the camera fit.
- The SBP UI: a banner "Special build phase: <Name>", an action bar limited to builds and buying.
- The lobby allows 5–6 seats when `five-six` is enabled (auto-enabled when the seat count is > 4).

### P2P

- 6 peers: 15 connections. Run the chaos suite with 6 peers.
- The beacon needs up to 6 reveals. Deck unlock chains are 5 hops; measure the latency.

### Bots

RandomBot must handle the SBP. Enumerator support for the `sbp` phase.

## Steps

1. A1 audit + refactor (goldens unchanged).
2. A2 hooks + the kitchen-sink tests.
3. A3 compat matrix + lobby integration.
4. A2a fixture model, slots for the base and `five-six` boards; A4 UI registry + renderer plugin layers, including the fixture layer.
5. A5 scenario abstraction in maps + the lobby scenario picker.
6. `five-six` board spec, deck, bank, harbors.
7. The SBP via `turnFlow`.
8. UI + lobby + colours.
9. Simulation: 50k 5- and 6-player games; 6-peer chaos suite.
10. `docs/rules/five-six.md` with every `[VERIFY]` resolved.

## Acceptance criteria

- [ ] Base goldens unchanged after the refactor (or the change is justified and versioned).
- [ ] 50k simulated 6-player games without invariant violations.
- [ ] A 6-browser P2P Playwright game completes, and the audit passes.
- [ ] The SBP is enforced (trading and dev-card plays rejected in the SBP; builds and buys allowed).
- [ ] The module compatibility matrix is enforced in the lobby and in `createGame`.
