# 02 — Engine Core

## Goal

Build the rules-agnostic core of `@cp2p/engine`:

- hex geometry and the board graph,
- the deterministic PRNG used **only** for genesis board generation,
- the state model with public and private parts and resource bounds,
- the input pipeline (`validate` / `apply` / `getPending`),
- the module system skeleton,
- canonical encoding plus a state-hash helper (in `@cp2p/codec`).

At the end of this stage a trivial test module can run through the pipeline. Real rules come in stage 03.

## Prerequisites

Stage 01 is complete. Re-read `00-architecture.md` §2 and §5.

## Package layout

```
packages/engine/src/
  core/
    geometry/        hex math, vertex/edge ids, board graph
    rng/             seeded PRNG (genesis only)
    types/           shared types: Seat, Resource, ResourceCounts, Result, RuleError
    resources/       ResourceCounts ops + ResourceBounds ops
    state/           GameState shape, PrivateState, helpers
    pipeline/        validate/apply/getPending/getLegalCommands dispatch
    modules/         GameModule interface, registry, composition
    events/          GameEvent types (UI-facing descriptions of what happened)
  modules/
    base/            (stage 03)
  geometry.ts        public entry point for renderer (pure geometry only)
  index.ts           public API
packages/codec/src/
  canonical.ts       canonical encoding
  hash.ts            sha256 helpers, hex/base64url
```

## 1. Hex geometry

### 1.1 Coordinates

- **Pointy-top hexes**, axial coordinates `{ q, r }` (see redblobgames "Hexagonal Grids" for conventions). Cube `s = -q - r` is derived.
- Neighbour directions (axial deltas): `E(+1,0)`, `NE(+1,-1)`, `NW(0,-1)`, `W(-1,0)`, `SW(-1,+1)`, `SE(0,+1)`.

### 1.2 Canonical vertex and edge ids

Each vertex is shared by up to 3 hexes and each edge by up to 2. For a unique id, each hex **owns** 2 vertices and 3 edges:

- Vertices owned by hex `(q,r)`: `N` (top point) and `S` (bottom point).
  - The hex's other corners map to owned vertices of neighbours:
    - `NE` corner = `S` of `(q+1, r-1)`
    - `SE` corner = `N` of `(q, r+1)`
    - `SW` corner = `N` of `(q-1, r+1)`
    - `NW` corner = `S` of `(q, r-1)`
- Edges owned by hex `(q,r)`: `NE`, `NW`, `W`.
  - `E` edge = `W` of `(q+1, r)`
  - `SE` edge = `NW` of `(q, r+1)`
  - `SW` edge = `NE` of `(q-1, r+1)`

String ids (stable and human-readable in logs): `v:q,r,N`, `e:q,r,NE`, `h:q,r`. Use negative numbers as-is (`v:-1,2,S`).

For speed, the **board graph** gives every hex, vertex and edge on a specific board a dense integer index (`HexIdx`, `VertexIdx`, `EdgeIdx`) assigned by sorting the string ids. **Public state and commands use the string ids.** Integer indices are an internal cache that is rebuilt deterministically from the board.

### 1.3 Board graph

`buildBoardGraph(hexes: HexCoord[]): BoardGraph` computes:

- `hexVertices[hex] → 6 vertex ids` (clockwise from N)
- `hexEdges[hex] → 6 edge ids`
- `vertexHexes[v] → 1..3 hex ids` (includes sea/off-board hexes if present in the hex list)
- `vertexEdges[v] → 2..3 edges`, `vertexNeighbors[v] → adjacent vertices`
- `edgeVertices[e] → [v1, v2]`, `edgeHexes[e] → 1..2 hexes`
- Only vertices and edges that touch at least one hex in the list are included.

Also export pixel helpers for the renderer (pure math, no rendering): `hexToPixel(q, r, size)`, `vertexToPixel`, `edgeToPixel(midpoint, angle)`.

### 1.4 Geometry tests (required)

- For a radius-2 hexagon (19 hexes): 54 vertices, 72 edges.
- Radius-3 hexagon (37 hexes): 96 vertices, 132 edges. (General check: `E = V + H − 1` for any simply connected hex set, by Euler's formula.)
- Every vertex has 1–3 hexes; every edge has 1–2 hexes and exactly 2 vertices.
- **Cross-check**: compute every hex corner's pixel position, dedupe by rounding to 1e-6, and assert the count and hex-membership sets match the canonical-id construction. Do the same for edge midpoints. This catches ownership-mapping mistakes.
- Property test (fast-check) on random connected hex sets: `vertexNeighbors` is symmetric; `edgeVertices` agrees with `vertexEdges`.

## 2. Genesis PRNG

- Implement `xoshiro128**` (or `sfc32`) seeded from a 32-byte seed via `splitmix32` expansion. Use integer math only, with `Math.imul` and `>>> 0`.
- API: `createRng(seed: Uint8Array)` → `{ nextU32(), int(maxExclusive) (rejection sampling, no modulo bias), shuffle<T>(arr) (Fisher–Yates, returns new array), pick<T>(arr) }`.
- **Allowed only** in `createGame` / board generation. Enforce it structurally: the RNG isn't reachable from `apply`. `apply` receives no RNG parameter, and the RNG module is imported only by `core/state/createGame.ts` and `modules/*/setup/**`.
- Export a separate `@cp2p/engine/rng` entry for seeded simulators and bots. That external use does not permit imports from engine rule handlers or the pipeline. Command enumeration accepts an injected sampler when it needs sampling.
- Tests: known-answer vectors (hard-code the first 10 outputs for a fixed seed); a distribution sanity check for `int(6)` over 600k draws (within 1% per bucket); `shuffle` is a permutation.

## 3. Shared types

```ts
export type Seat = 0 | 1 | 2 | 3 | 4 | 5;
export type Resource = 'brick' | 'lumber' | 'wool' | 'grain' | 'ore';
export const RESOURCES: readonly Resource[] = ['brick', 'lumber', 'wool', 'grain', 'ore']; // canonical order
export type ResourceCounts = Readonly<Record<Resource, number>>; // non-negative ints
export type Result<T, E = RuleError> = { ok: true; value: T } | { ok: false; error: E };
export interface RuleError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
```

Modules may add card kinds (commodities in stage 13). Design `ResourceCounts` helpers generically over a `CardKind` string union so modules can extend it: use `Record<string, number>` internally with typed wrappers.

### 3.1 ResourceBounds (public knowledge of a hand)

```ts
interface ResourceBounds {
  total: number; // always exact
  min: ResourceCounts; // guaranteed at least
  max: ResourceCounts; // at most
}
```

Invariants (assert in tests and in a debug-mode `checkInvariants`):

- `0 ≤ min[r] ≤ max[r] ≤ total`
- `sum(min) ≤ total ≤ sum(max)`

Operations (pure functions, each with unit and property tests):

| Operation                  | Effect                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gainKnown(b, counts)`     | `min += c`, `max += c`, `total += sum(c)`                                                                                                                 |
| `loseKnown(b, counts)`     | requires `canAfford(b, counts)` (else error). `min = max(0, min - c)`, `max -= c`, `total -= sum(c)`, then normalize                                      |
| `gainHidden(b, n)`         | `total += n`, `max[r] += n` for all r                                                                                                                     |
| `loseHidden(b, n)`         | requires non-negative integer `n ≤ total` (else error). `total -= n`, `min[r] = max(0, min[r] - n)` for all r, then normalize                             |
| `revealExact(b, r, count)` | requires `min[r] ≤ count ≤ max[r]`; sets `min[r] = max[r] = count`                                                                                        |
| `normalize(b)`             | tighten: `max[r] = min(max[r], total - (sum(min) - min[r]))`; `min[r] = max(min[r], total - (sum(max) - max[r]))`; iterate to a fixpoint (≤ 5 iterations) |
| `isExact(b)`               | `min == max`                                                                                                                                              |
| `canAfford(b, cost)`       | `max[r] ≥ cost[r]` for all r **and** `sum(max(min[r], cost[r])) ≤ total`. This proves that some hand consistent with public bounds can pay the cost       |

All public operations validate non-negative integer counts and preserve feasible, normalized bounds. Feasibility requires `min ≤ max` and `sum(min) ≤ total ≤ sum(max)`. Normalize after each update; normalization must reject infeasible bounds rather than return `min > max`. The maximum-only affordability check is insufficient for mixed-resource costs. For example, a five-card hand with exactly three ore and at most two each of brick and lumber cannot pay two brick plus two lumber. Add this regression and compare affordability and known losses against brute-force feasible hands for small totals.

Property test: build a random sequence of operations against a _hidden true hand_ (true hand known to the test). Assert that the true hand always lies within the bounds (soundness), and that `normalize` never excludes the true hand.

## 4. State model

```ts
interface GameState {
  // PUBLIC, replicated, hashed
  schema: 1;
  engineVersion: string; // semver of rules; genesis pins it
  config: GameConfig; // modules + options, frozen at genesis
  board: BoardState; // hexes (terrain, token), harbors, piece placements
  seats: SeatState[]; // per-seat public data (bounds, pieces left, card slots, public VP…)
  bank: Record<string, number>;
  decks: Record<string, DeckPublic>; // e.g. dev: { remaining: 25, drawn: SlotRef[] }
  turn: TurnState; // { number, activeSeat, phase: PhaseFrame[] (stack) }
  awards: Record<string, Seat | null>; // longestRoad, largestArmy…
  counters: { nextOfferId: number; nextSlotId: number; inputSeq: number };
  ext: Record<ModuleId, unknown>; // module-owned state, keyed by module id
  result: null | { winner: Seat; reason: string; atTurn: number };
}

interface PrivateState {
  // per seat, local only
  seat: Seat;
  hand: Record<string, number>; // exact cards
  slots: Record<SlotId, CardIdentity>; // identities of face-down cards held
  ext: Record<ModuleId, unknown>;
}
```

- **The phase is a stack** (`PhaseFrame[]`) so interrupts are natural: e.g. `main → roadBuilding(2 remaining)` or `preRoll → knightRobber → steal`. Each frame is `{ id: string; module: ModuleId; data: unknown }`.
- Every state object is plain JSON (no classes, Maps, undefined values or functions), so it round-trips through canonical encoding. **Omit a key** instead of setting it to `undefined`.
- Card **slots**: a face-down card in a hand is `{ slotId, deck, acquiredTurn, revealed?: CardIdentity }` in public state. The identity lives in the owner's `PrivateState` until revealed.

## 5. Inputs

```ts
type Input = CommandInput | SystemInput;
interface CommandInput {
  kind: 'command';
  seat: Seat;
  command: { type: string; [k: string]: unknown };
}
interface SystemInput {
  kind: 'system';
  type: string;
  [k: string]: unknown;
}
```

- Command types are namespaced by module when ambiguous (`base/BUILD_ROAD` internally). The wire format uses plain `type` strings that are unique across all modules, enforced by the registry at startup.
- A system input answers a `Pending` of kind `random` or `reveal`, or is a protocol-level event (`TIMEOUT`, `SEAT_STATUS`). Random and reveal inputs must match a current pending item. `TIMEOUT` must match a current player pending and its phase; `SEAT_STATUS` validates its seat and status independently.

## 6. Pipeline API

```ts
createGame(config: GameConfig, genesisSeed: Uint8Array): GameState
validate(state: GameState, input: Input): Result<void>
apply(state: GameState, input: Input): Result<{ state: GameState; events: GameEvent[] }>  // calls validate first
applyPrivate(priv: PrivateState, before: GameState, input: Input, privInput?: PrivateInputData): Result<PrivateState>
getPending(state: GameState): Pending[]
getLegalCommands(state: GameState, seat: Seat, priv?: PrivateState): LegalCommandSet
project(state: GameState, viewer: Seat | 'spectator'): PublicView   // convenience for UI
computeVictoryPoints(state, seat, priv?): { public: number; total?: number }
```

- `LegalCommandSet` lists concrete commands for discrete choices (placements) and **templates** for combinatorial ones (trades, discards), e.g. `{ type: 'DISCARD', count: 4, from: bounds }`. Stage 04 adds an enumerator for bots.
- `applyPrivate` is how the owner's client keeps the exact hand in step with public events. `privInput` carries secret data the owner learned out of band (e.g. which card was stolen from them). Only the owner (or an omniscient local driver) calls it.
- **Omniscient mode** (hotseat, simulation, audit): a `LocalGame` wrapper holds `GameState` plus every seat's `PrivateState` and asserts after each input that the true hands sit inside the public bounds.
- `LocalGame` answers local deck draws using the injected random source and the remaining card identities. These identities stay outside public state. It records all automatically submitted inputs, including victory claims, so replay uses the same deterministic pipeline.

## 7. Module system (skeleton)

```ts
interface GameModule<Ext = unknown, PExt = unknown> {
  id: ModuleId;
  version: string;
  dependsOn: ModuleId[];
  conflictsWith: ModuleId[];
  optionsSchema: OptionSpec[]; // for lobby UI + validation
  // setup
  initState?(ctx: SetupCtx): Ext; // may use genesis RNG
  modifyConfig?(cfg: GameConfig): GameConfig;
  buildBoard?(ctx: SetupCtx, board: BoardState): BoardState;
  initPrivate?(seat: Seat): PExt;
  // rules
  commands: Record<string, CommandHandler>; // validate + apply + applyPrivate
  systemInputs: Record<string, SystemInputHandler>;
  phases: Record<string, PhaseHandler>; // pending + allowed commands per phase
  hooks?: Partial<Hooks>; // see below
  victoryPoints?(state, seat, priv?): VpContribution[];
  invariants?(state): string[]; // returns violations
}
```

Hooks are ordered calls (in module dependency order, then by id) at defined extension points. The initial set, extended in stage 11:

- `afterDiceRolled(state, dice) → state`
- `computeProduction(state, roll, acc) → acc` (modules add to or modify production)
- `placementRules.{settlement,road,city}(state, seat, loc, verdict) → verdict`
- `costOf(state, buildType, cost) → cost`
- `afterBuild(state, seat, buildType, loc) → state`
- `onTurnStart / onTurnEnd`
- `robberTargets(state, seat, hex, targets) → targets`
- `handLimit(state, seat, limit) → limit`

Implement the registry, dependency topological sort, conflict detection, command-type uniqueness, and the dispatcher that routes inputs to handlers based on the top phase frame. Test it with a tiny `test-counter` module (commands `INC`/`END`, a `random` pending) that lives only in tests.

## 8. Canonical encoding (`@cp2p/codec`)

- `canonicalEncode(value): Uint8Array` = UTF-8 bytes of a JSON-like encoding with:
  - object keys sorted by UTF-16 code units,
  - no whitespace,
  - integers only (throw on non-integer numbers, NaN or ±Infinity; throw on `undefined` values),
  - strings JSON-escaped, arrays in order,
  - `Uint8Array` encoded as `{"$b":"<base64url>"}`.
- `canonicalDecode` is the inverse, used for snapshots.
- `sha256(bytes)`, `hashValue(value) = sha256(canonicalEncode(value))`, and `toHex`/`toBase64Url` helpers.
- Tests: key order independence; round trip; rejection of floats/undefined; known-answer hash for a fixed object (pin the hex string).

`@cp2p/engine` doesn't depend on codec. The protocol layer hashes `GameState` with codec. Add a test in `protocol` (or in a separate integration test package) proving `createGame` output encodes without errors, which proves it contains no floats or undefined.

## 9. Engine events (for UI and logs)

`apply` returns `GameEvent[]`: plain descriptive records such as `{ type: 'resourcesProduced', bySeat: {...} }` and `{ type: 'roadBuilt', seat, edge }`. They're derived and not replicated or hashed. The UI uses them for animations and the history panel. Define the event union in core and let modules extend it.

## Steps

1. Implement `core/types` and `core/resources` (counts + bounds) with tests.
2. Implement geometry and the board graph with the full test suite from §1.4.
3. Implement the genesis PRNG with vectors.
4. Implement canonical encoding and hashing in `@cp2p/codec` with tests.
5. Define `GameState`, `PrivateState`, `Input`, `Pending` and the event types.
6. Implement the module interface, registry, topological sort and conflict checks.
7. Implement the pipeline dispatcher: phase-stack routing, pending computation and system-input matching.
8. Implement `LocalGame` (omniscient driver) with a `LocalRandomSource` interface (dependency-injected, so tests can pass a deterministic source).
9. Write the `test-counter` module and run end-to-end pipeline tests through `LocalGame`.
10. Export the public API from `index.ts` and the geometry-only entry from `geometry.ts`. Document the API with TSDoc.

## Required tests

- Geometry suite (§1.4); PRNG vectors; bounds soundness property test; codec suite.
- Registry: dependency order, conflict detection, duplicate command type rejection.
- Pipeline: a system input with no matching pending is rejected; a command from the wrong seat is rejected; `apply` doesn't mutate its input (deep-freeze input state in tests with a recursive `Object.freeze` helper).
- Determinism: applying the same input list twice gives identical `hashValue(state)`.

## Acceptance criteria

- [ ] Geometry counts and cross-check tests pass for radius 2, radius 3 and random shapes.
- [ ] `ResourceBounds` soundness property test passes 10k runs.
- [ ] `test-counter` module plays to completion through `LocalGame` with injected randomness.
- [ ] Engine has zero dependencies and passes the purity check.
- [ ] Deep-freeze tests prove `apply` is non-mutating.
- [ ] Public API documented; `geometry.ts` entry importable by the renderer without pulling in the pipeline.
