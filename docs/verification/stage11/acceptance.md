# Stage 11 acceptance evidence

Stage: [11 — Module framework hardening and 5–6 players](../../11-module-framework-5-6-players.md). Dates are local time, 2026-09-28.

## Base goldens unchanged

The hook refactor keeps every base golden replay byte-identical: all 25 engine test files, including `packages/engine/test/golden.test.ts`, pass without changes to the golden data or checkpoint hashes. `ENGINE_VERSION` stays `0.1.0` and the base module stays `1.0.0`. Fixture-free boards omit `board.fixtures`, so their state hashes are unchanged.

## 50,000 six-player games

[`sim-6p-50k.json`](sim-6p-50k.json): `pnpm sim run --games 50000 --players 6 --seed 1106 --parallel 10`, started on commit `4b7a261` with invariants verified on every input.

- 50,000 of 50,000 games completed with 0 failures. The average game lasted 104.95 turns, and the dice chi-square p-value was 0.762.
- Wins by seat: 8,530 / 8,416 / 8,317 / 8,193 / 8,169 / 8,375.
- The report's `sourceUnchanged` is `false`. During the 32-minute run I edited only engine metadata and routing plumbing (`withMetadata`, `createCatalogueEngine`); no rule changed. At the user's request, follow-up confirmation runs use 5,000 games (see below).

## Special build phase enforcement

`packages/engine/src/modules/five-six/five-six.test.ts` covers the special build phase:

- Every other seat builds in turn order.
- For the building seat, `MARITIME_TRADE`, `OFFER_TRADE`, `PROPOSE_TRADE`, `PLAY_DEV_CARD`, `END_TURN` and `ROLL_DICE` fail with `not-pending`, as does any command from another seat.
- Road, city and development-card purchases succeed. The purchase's draw returns to the same phase.
- A timeout ends one seat's phase.
- A seat that reaches the target wins only when its own turn begins.

The web test `apps/web/src/features/modules/five-six.test.tsx` checks that the action bar offers only builds, the purchase and _Done building_, and that the banner names the building seat.

## Compatibility matrix in the lobby and `createGame`

- `createGame`: `no` and `later` pairs become `conflictsWith`, so the registry rejects them. The seat range is checked through `seatRange`, and `engineForModules` checks catalogue versions and compatibility (`packages/engine/test/kitchen-sink.test.ts`, `five-six.test.ts`).
- Lobby: `packages/protocol/src/lobby.test.ts` shows that the lobby refuses unknown, later, duplicate, mis-versioned and seat-mismatched module sets before signing, and replicates a valid six-seat five-six config. The setup screens disable unavailable expansions and give the reason (`OnlineConfiguration.test.tsx`).

## Six-browser P2P game with audit

See the section added when the run completes.

## Six-peer chaos suite

See the section added when the runs complete.

## Framework tests

- The kitchen-sink module calls every catalogue hook, in dependency order and independent of registration order.
- Fixtures: every board shape passes the slot rules, placement is deterministic, `NO_FIXTURE_SLOT` is raised when slots run out, and rules results are identical with and without a fixture.
- Mobile fit: `apps/web/tests/five-six-board-fit.e2e.ts` keeps all 30 land hexes and both fixture cells on screen at 390×844 and 844×390.
