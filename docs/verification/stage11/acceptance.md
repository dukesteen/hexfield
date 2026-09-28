# Stage 11 acceptance evidence

Stage: [11 — Module framework hardening and 5–6 players](../../11-module-framework-5-6-players.md). Dates are local time, 2026-09-28.

## Base goldens unchanged

The hook refactor keeps every base golden replay byte-identical: all 25 engine test files, including `packages/engine/test/golden.test.ts`, pass without changes to the golden data or checkpoint hashes. `ENGINE_VERSION` stays `0.1.0` and the base module stays `1.0.0`. Fixture-free boards omit `board.fixtures`, so their state hashes are unchanged.

## 50,000 six-player games

[`sim-6p-50k.json`](sim-6p-50k.json): `pnpm sim run --games 50000 --players 6 --seed 1106 --parallel 10`, started on commit `4b7a261` with invariants verified on every input.

- 50,000 of 50,000 games completed with 0 failures. The average game lasted 104.95 turns, and the dice chi-square p-value was 0.762.
- Wins by seat: 8,530 / 8,416 / 8,317 / 8,193 / 8,169 / 8,375.
- The report's `sourceUnchanged` is `false`. During the 32-minute run I edited only engine metadata and routing plumbing (`withMetadata`, `createCatalogueEngine`); no rule changed. At the user's request, follow-up confirmation runs use 5,000 games.

Confirmation run on the final stage 11 tree: [`sim-6p-5k-final.json`](sim-6p-5k-final.json), `pnpm sim run --games 5000 --players 6 --seed 1107 --parallel 8`. 5,000 of 5,000 games completed with 0 failures and `sourceUnchanged: true`, including the special-build-phase auto-end. The average game lasted 105.88 turns, and the dice chi-square p-value was 0.313. Wins by seat: 824 / 877 / 834 / 821 / 864 / 780.

## Special build phase enforcement

`packages/engine/src/modules/five-six/five-six.test.ts` covers the special build phase:

- Every other seat builds in turn order.
- For the building seat, `MARITIME_TRADE`, `OFFER_TRADE`, `PROPOSE_TRADE`, `PLAY_DEV_CARD`, `END_TURN` and `ROLL_DICE` fail with `not-pending`, as does any command from another seat.
- Road, city and development-card purchases succeed. The purchase's draw returns to the same phase.
- A timeout ends one seat's phase.
- A seat whose own hand can build nothing has its phase ended for it (the `autoInput` hook). Only the seat's own client knows its hand, so no other seat can end it.
- A seat that reaches the target wins only when its own turn begins.

The web test `apps/web/src/features/modules/five-six.test.tsx` checks that the action bar offers only builds, the purchase and _Done building_, and that the banner names the building seat.

## Compatibility matrix in the lobby and `createGame`

- `createGame`: `no` and `later` pairs become `conflictsWith`, so the registry rejects them. The seat range is checked through `seatRange`, and `engineForModules` checks catalogue versions and compatibility (`packages/engine/test/kitchen-sink.test.ts`, `five-six.test.ts`).
- Lobby: `packages/protocol/src/lobby.test.ts` shows that the lobby refuses unknown, later, duplicate, mis-versioned and seat-mismatched module sets before signing, and replicates a valid six-seat five-six config. The setup screens disable unavailable expansions and give the reason (`OnlineConfiguration.test.tsx`).

## Six-browser P2P game with audit

[`six-browser-p2p.json`](six-browser-p2p.json): `CI_BROWSER_SET=chromium CP2P_MIXED_ENGINE_ACCEPTANCE=1 CP2P_MIXED_ENGINE_MODE=signaling CP2P_MIXED_ENGINE_SEATS=6 CP2P_MIXED_ENGINE_NO_WEBKIT=1 npx playwright test tests/mixed-engine-online.e2e.ts --project chromium`, run with the local signaling server on port 8909 against the final design (structural ceremony checks, background proof pre-verification).

- Three Chromium and three Firefox contexts formed a full mesh, completed the six-seat verified genesis ceremony (34-card deck) and played a five-six game to its end.
- The test driver's 30 moves were accepted, including 12 `END_SBP`. The seats' own clients ended the other special build phases automatically, because those hands could build nothing. All six peers ended on the same head, seq 96.
- The driver's 102 `command-pending` refusals are expected: they are driver moves for a seat whose client had already sent its automatic `END_SBP`. Like `stale-head`, the driver then polls again.
- Every peer's audit reached `complete` with no audit problems. The test passed in 3.0 minutes; the run before the auto-end took 4.9 minutes (145 moves, seq 211).
- WebKit is left out because it has no local WebRTC connectivity on this machine (`CP2P_MIXED_ENGINE_NO_WEBKIT`). The four-seat mixed run with WebKit is unchanged.

## Six-peer chaos suite

[`chaos-6p/`](chaos-6p/): `node tools/sim/dist/index.js net --scenario N --seeds 1 --seed 42 --players 6` for scenarios 1–9, on the final deck-proof design. All nine ran in parallel.

| Scenario | Games | Turns | Inputs | Wall time (s) |
| -------- | ----- | ----- | ------ | ------------- |
| 1        | 1/1   | 99    | 1,127  | 362           |
| 2        | 1/1   | 99    | 1,127  | 1,685         |
| 3        | 1/1   | 99    | 1,127  | 429           |
| 4        | 1/1   | 99    | 1,127  | 367           |
| 5        | 1/1   | 99    | 1,127  | 376           |
| 6        | 1/1   | 80    | 941    | 295           |
| 7        | 1/1   | 99    | 1,127  | 364           |
| 8        | 1/1   | 99    | 1,127  | 362           |
| 9        | 1/1   | 99    | 1,127  | 378           |

Every scenario completed without divergence or failures. These runs used the build just before the special-build-phase auto-end; at the user's direction they were not repeated after it.

## Framework tests

- The kitchen-sink module calls every catalogue hook, in dependency order and independent of registration order.
- Fixtures: every board shape passes the slot rules, placement is deterministic, `NO_FIXTURE_SLOT` is raised when slots run out, and rules results are identical with and without a fixture.
- Mobile fit: `apps/web/tests/five-six-board-fit.e2e.ts` keeps all 30 land hexes and both fixture cells on screen at 390×844 and 844×390.
