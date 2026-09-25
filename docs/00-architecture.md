# 00 — Architecture & Invariants

Every stage depends on this document. Read it before starting any stage.

## 1. Product summary

- A browser game (installable PWA) for 2–6 players in the hex-settlement trading genre, with expansion modules: 5–6 players, seafaring, knights & commerce, frontier scenarios, explorers.
- **No game server.** Game state lives only on the players' devices. The only infrastructure is optional:
  - a tiny **signaling** service that swaps WebRTC connection offers and never sees game data,
  - public/self-hosted **STUN/TURN** for NAT traversal (TURN relays encrypted bytes it can't read).
- Fully serverless play is also supported, via copy-paste or QR connection codes.
- Also playable offline as hotseat and against bots.

## 2. Core architectural decisions

### 2.1 Deterministic engine + replicated input log

- Every peer runs the same **pure, deterministic** rules engine.
- Game progress is an ordered, hash-chained **log of inputs**. An input is either a player command ("build road at edge 47") or a system input ("dice result = 3,4").
- `state_N = fold(apply, genesisState, inputs[1..N])`. Two honest peers with the same log **always** produce byte-identical public state. Peers compare `SHA-256(canonical(publicState))` to catch desyncs.

### 2.2 The engine never produces its own randomness mid-game

This is the most important change from a naive design. If dice or deck order came from a shared seed, **every peer could predict future dice and cards.** So:

- The **board layout** comes from a genesis seed that all players produce jointly (commit-reveal in the lobby). Board layout is public, so that's fine.
- **Every mid-game random outcome** (dice, dev-card draws, steal index, fog tiles, fish tokens, starting player…) enters the engine as a **system input** produced _outside_ the engine:
  - Local/hotseat mode: a `LocalRandomSource` using a CSPRNG.
  - P2P mode: a joint **randomness beacon** (hash-chain commit-reveal) for public randomness, and **mental poker** (commutative encryption) for hidden draws. See stage 07.
- The engine _requests_ randomness by exposing a pending `random` requirement. It never calls `Math.random`, `crypto`, `Date` or anything else non-deterministic.

### 2.3 Public state vs private state

- **Public state** is replicated and hashed. Every peer has an identical copy. It contains everything all players are allowed to know: board, pieces, bank, card _counts_, resource _bounds_ per player, face-down card slots, awards, turn/phase.
- **Private state** is per seat and held only by that seat's owner. It contains exact resource hand, identities of held dev/progress cards, secret keys, salts, and the private halves of commitments.
- In the base game, resources only move secretly through **steals**. The public state therefore tracks each player's resources as **bounds** (`min[r]`, `max[r]`, exact `total`), and validates spends against the bounds. When no hidden transfers happened, `min == max`, so validation is exact. In P2P mode, anything the bounds can't prove is proven **on the move itself**: each seat's hidden hand is also held as public Pedersen commitments, and spends, count reveals and steals carry zero-knowledge proofs that every peer checks before accepting the entry (stage 07). After the game, every secret is revealed for the omniscient replay and a defence-in-depth re-check.
- In local/hotseat mode, secret inputs carry their values publicly (e.g. the steal result names the resource), so bounds are always exact.

### 2.4 Pending-input model

The engine is a state machine. At any moment `getPending(state)` returns the list of inputs the game is waiting for:

```ts
type Pending =
  | { kind: 'player'; seat: Seat; allowed: CommandType[]; deadline?: TimerSpec }
  | { kind: 'random'; request: RandomRequest } // e.g. dice 2d6, draw from deck 'dev'
  | { kind: 'reveal'; seat: Seat; request: RevealRequest }; // e.g. monopoly count reveal
```

The UI, bots, the network layer and the simulator all drive the game off this one function.

### 2.5 Modular rules

- The base game is itself a module (`base`). Expansions are modules that add state, commands, phases and hooks through a typed `GameModule` interface (defined in stage 02, hardened in stage 11).
- The module list and options are part of the **genesis**, so they can't change mid-game.

### 2.6 Replicated log ordering and strict agreement

- A deterministic **sequencer** proposes signed commands and system inputs. Peers validate them and commit through signed prevote and precommit rounds with persistent locks, as specified in stage 06.
- Ordering tolerates at most one Byzantine human voter. For one through six human voters, commitment requires 1, 2, 3, 3, 4, 4 votes respectively. Bots do not vote. Hidden-information privacy has a separate threshold in stage 07.
- The voter set comes from the certified log, never a peer's online list. Two- and three-human games pause when one required voter is unavailable. Four-human games can continue with three cooperative voters when the pending input and cryptographic protocols permit it.
- Votes, locks and committed entries survive restarts. The UI applies committed state only. Invalid proposals and censorship cause proposer rotation; membership changes need the agreed reconfiguration procedure.

## 3. Package map & dependency direction

```
apps/web ─────────────┬──────────────┬────────────┬──────────┬─────────┐
   │                  │              │            │          │         │
   ▼                  ▼              ▼            ▼          ▼         ▼
@cp2p/renderer   @cp2p/p2p     @cp2p/storage  @cp2p/bots  @cp2p/maps  (react ui)
   │                  │              │            │          │
   │                  ▼              │            │          │
   │            @cp2p/protocol ◄─────┘            │          │
   │             │    │     │                      │          │
   │             │    │     ▼                      │          │
   │             │    │  @cp2p/crypto              │          │
   │             │    │     │                      │          │
   │             │    ▼     ▼                      │          │
   │             │  @cp2p/codec                    │          │
   ▼             ▼                                 ▼          ▼
            @cp2p/engine   ◄───────────────────────┴──────────┘
                 │
                 ▼
             (nothing)
apps/signaling  → depends on nothing from the workspace except @cp2p/codec types (optional)
tools/sim       → engine, bots, codec, maps, protocol (for network chaos sims)
```

Rules (enforced by dependency-cruiser in CI, stage 01):

- `@cp2p/engine` has **zero runtime dependencies**: no browser APIs, no Node APIs, no npm packages.
- `@cp2p/codec` depends only on `@noble/hashes`.
- `@cp2p/crypto` depends only on `@noble/curves`, `@noble/hashes` and `@cp2p/codec`.
- Nothing below `apps/web` imports React.
- `@cp2p/renderer` imports only engine _types_ and geometry helpers, never engine mutation functions.
- Inside `@cp2p/engine`, `src/modules/<id>/**` may import from `src/core/**` and from modules it declares as dependencies, never from sibling modules it doesn't declare.

## 4. Technology choices

| Concern                 | Choice                                                                                   | Reason                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language                | TypeScript 5.x, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`       | Safety for a large rules codebase                                                                                                                                                                                                                                                                                                                    |
| Package manager         | pnpm workspaces                                                                          | Monorepo                                                                                                                                                                                                                                                                                                                                             |
| Runtime for tools/tests | Node 22 LTS                                                                              |                                                                                                                                                                                                                                                                                                                                                      |
| Build                   | Vite (app), `tsup` or `tsc -b` (packages)                                                |                                                                                                                                                                                                                                                                                                                                                      |
| Unit/property tests     | Vitest + fast-check                                                                      |                                                                                                                                                                                                                                                                                                                                                      |
| E2E                     | Playwright                                                                               | Multi-browser P2P tests                                                                                                                                                                                                                                                                                                                              |
| Lint                    | oxlint                                                                                   | Very fast, ESLint-compatible rule set, type-aware rules                                                                                                                                                                                                                                                                                              |
| Format                  | oxfmt (Oxc formatter; Prettier-compatible output)                                        | Same toolchain as oxlint. Fall back to Prettier only if oxfmt lacks a needed feature — log it in DECISIONS.md                                                                                                                                                                                                                                        |
| Boundaries              | dependency-cruiser                                                                       | Enforce §3                                                                                                                                                                                                                                                                                                                                           |
| UI                      | React 19                                                                                 |                                                                                                                                                                                                                                                                                                                                                      |
| Routing                 | TanStack Router (file-based routes via `@tanstack/router-plugin/vite`, **hash history**) | Type-safe routes, params and search params. Hash history keeps the app working on any static host and offline in the PWA without server rewrites. Integrates with TanStack Query loaders                                                                                                                                                             |
| Live game/UI state      | Zustand                                                                                  | The game session _pushes_ state (log entries, peer events). That's synchronous client state, not server data, so it stays in Zustand stores fed by `GameSession.subscribe`                                                                                                                                                                           |
| Async data              | TanStack Query (React Query)                                                             | For everything _pulled_ asynchronously: IndexedDB reads/writes (game history, saved maps, replays, settings), TURN-credential endpoint fetch, signaling-server health check, connectivity diagnostics, heavy replay/audit computations in workers. Gives caching, loading/error states and invalidation after mutations. **Not** for live game state |
| i18n                    | i18next + react-i18next                                                                  | Namespaced JSON translation files, ICU-style plurals via `i18next-icu` (or i18next's built-in plural rules), lazy-loaded locales                                                                                                                                                                                                                     |
| Board rendering         | PixiJS v8                                                                                | WebGL/WebGPU 2D, good on mobile                                                                                                                                                                                                                                                                                                                      |
| Hashing/signatures      | `@noble/hashes` (SHA-256), `@noble/curves` (Ed25519, ristretto255)                       | Audited, deterministic, identical in Node and browsers                                                                                                                                                                                                                                                                                               |
| Runtime validation      | Valibot                                                                                  | Never trust peer input. Tree-shakeable and much smaller than alternatives. Used for wire messages, lobby messages, imported saves/replays/maps and settings                                                                                                                                                                                          |
| Persistence             | IndexedDB via `idb`                                                                      |                                                                                                                                                                                                                                                                                                                                                      |
| QR                      | `qrcode` (generate), `BarcodeDetector` with `jsQR` fallback (scan)                       |                                                                                                                                                                                                                                                                                                                                                      |
| Compression             | `CompressionStream('deflate-raw')` with `fflate` fallback                                | Connection codes, map strings, snapshots                                                                                                                                                                                                                                                                                                             |
| PWA                     | `vite-plugin-pwa`                                                                        |                                                                                                                                                                                                                                                                                                                                                      |
| Signaling server        | Cloudflare Worker + Durable Object (primary) _or_ Node `ws` (self-host)                  | Tiny and cheap                                                                                                                                                                                                                                                                                                                                       |

## 5. Determinism rules (engine)

1. No floats in state. All quantities are integers. Probabilities are never computed inside `apply`.
2. No `Math.random`, `Date`, `performance`, `crypto`, timers or I/O.
3. No iteration over `Map`/`Set`/object keys where order affects results, unless keys are sorted first. Store collections as arrays sorted by a stable id, or as records whose consumers sort keys.
4. `apply` never mutates its input. Use structural copying (Immer is **not** allowed in the engine because of the zero-deps rule; write small helpers or clone on write).
5. Any new value (piece id, offer id, card slot id) is derived from state counters, never from randomness or time.
6. Every command type's validation is total: it returns a typed `RuleError` and never throws for bad input. A throw means an engine bug.
7. Canonical encoding (stage 02/06) is the only serialization used for hashing.

## 6. Security model (what we protect against)

| Threat                                                                    | Protection                                                                                                 |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Illegal move (build without resources, wrong turn, illegal placement)     | Every peer validates every input. Rejected immediately.                                                    |
| Forged command from another player                                        | Ed25519 signatures per seat                                                                                |
| Predicting or biasing dice                                                | Hash-chain commit-reveal beacon (stage 07)                                                                 |
| Knowing or biasing card draws                                             | Mental poker with per-card locking keys and verifiable shuffles (stage 07)                                 |
| Lying about a hidden hand                                                 | Bounds validation plus per-move proofs over committed hands; caught on that move                           |
| Sequencer censorship or misbehaviour                                      | Broadcast submits, timeout, re-election, signed proof of misbehaviour                                      |
| Player leaving permanently with secrets                                   | Threshold key escrow among the other players (stage 07/10)                                                 |
| Collusion of all other players                                            | **Not protected** (inherent to P2P card games with escrow)                                                 |
| Modified client reading its own private data (e.g. its own card-counting) | Out of scope: that information is legitimately available                                                   |
| Last-revealer abort (refusing to reveal a beacon value)                   | Cannot change the fixed outcome. Recovery needs authorized escrow and a safe quorum; otherwise play pauses |

## 7. Glossary

- **Seat**: a player position in a game (`0..5`). The engine only knows seats. The protocol maps seats to peer public keys.
- **Peer**: a device/browser instance with an Ed25519 identity key.
- **Command**: a signed intent from a seat (`BUILD_ROAD`).
- **System input**: a non-player input (`DICE_RESULT`, `CARD_DEALT`, `TIMEOUT`), produced by the protocol from beacon/deck/timer rules and verifiable by every peer.
- **Input**: command or system input. Engine function `apply(state, input)`.
- **Entry**: an input wrapped with `seq`, `prevHash`, `term` and signatures in the replicated log.
- **Genesis**: entry 0. It contains config, modules, seats and keys, the board seed and cryptographic commitments.
- **Pending**: what the engine currently waits for.
- **Bounds**: public min/max knowledge of a player's resource counts.
- **Beacon**: joint randomness from hash-chain reveals.
- **Deck protocol**: mental-poker shuffle/deal/reveal for hidden draw piles.
- **Committed hand**: public Pedersen commitments to a seat's per-type card counts, updated every move and backed by per-move proofs.
- **Audit**: end-of-game re-verification after all secrets are revealed. A safety net and the basis of the omniscient replay; fairness is already verified move by move.

## 8. Naming (non-infringing)

| Concept           | Name used in code/UI                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| Resources         | `brick`, `lumber`, `wool`, `grain`, `ore`                                                                     |
| Terrains          | `hills`, `forest`, `pasture`, `fields`, `mountains`, `desert`, `sea`, `gold`, `fog`, `lake`                   |
| Development cards | `knight`, `roadBuilding`, `yearOfPlenty`, `monopoly`, `victoryPoint`                                          |
| Modules           | `base`, `five-six`, `seafaring`, `knights` (Knights & Commerce), `frontier` (frontier scenarios), `explorers` |
| App title         | configurable `APP_NAME` constant (placeholder: "Hexfield")                                                    |

## 9. Repository layout (target)

```
apps/
  web/                 React PWA
  signaling/           optional signaling service
packages/
  engine/              rules engine: src/core, src/modules/<id>
  codec/               canonical encoding + hashing
  crypto/              signatures, commitments, beacon, deck protocol, escrow
  protocol/            messages, log, sequencer, session, in-memory transport
  p2p/                 WebRTC transport + signaling adapters
  storage/             IndexedDB persistence
  renderer/            PixiJS board renderer
  bots/                bot players
  maps/                map/scenario definitions + map codec
tools/
  sim/                 headless simulation / chaos CLI
docs/                  these documents + DECISIONS.md, STATUS.md, rules/
```
