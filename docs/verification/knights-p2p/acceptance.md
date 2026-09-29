# Knights progress cards over verified P2P: acceptance evidence

Scope: [13 — Knights and commerce](../../13-knights-and-commerce.md), the P2P requirements for the progress-card private flows. Design: the decisions log entry "Knights progress cards over the verified P2P protocol". Dates are local time, 2026-09-29.

## Certified four-seat game with every progress card

`packages/protocol/src/knights-progress-game.test.ts` plays a four-seat knights game through the real in-memory network (two human sessions hosting the other two seats, real deck ceremony for the three progress decks, real proofs), with a test-only `quick-win` module that lowers the victory target to 11 and a genesis that gives every seat level 3 on each improvement track and frees the robber, so gate faces deal cards to most seats at most rolls and steals loosen public hand bounds. A scripted policy plays each progress card at its first legal chance and answers everything else like a random bot.

- The first game ends in victory and `auditCertifiedGame` returns `ok`, `complete`, no violations, no input errors.
- Every one of the 23 cards a hand can hold was played in a certified entry (the Printer and the Constitution are shown on the draw and never sit in a hand). A card that dealing or targets left out of the first game is chased in further games that stop at its play; the test fails if any card is missing.
- The same games answer, through signed `SEAT_INPUT` envelopes, every victory check, deal of a returned card, Spy show and take, and Master Merchant show and take, and play Wedding, Saboteur, Commercial Harbor, both monopolies, Bishop and Deserter.

## Cheater suite

Same file, run on the certified entries of that game (one observed replay keeps each entry's parent context; a forgery is the signer's own entry with its proof tampered and re-signed at the same parent). Each honest entry validates first; each forgery is refused on its move and its signer is the certified offender (`verifyCheatProof`, kind `command-proof`):

- a Spy request whose lock does not belong to the held card, and one that skips a card of the target;
- a Spy unlock with a point the target did not compute, and one that shows fewer cards than the target holds;
- a Master Merchant take with a tampered proof of the target's debit;
- a Wedding gift of a card never held (a kind swapped in), and a gift of the wrong size (refused by the engine);
- a drawer that says `none` about a Printer or Constitution, pasting another drawer's denial proof, and one that sends no proof;
- two plays with their deck proofs swapped.

`packages/crypto/src/dleq-or.test.ts` covers the OR proof (every branch, no true branch, wrong context, altered proof), `preproof.test.ts` the Harbor debit pre-proof, and `turn-timeout-private.test.ts` the timed defaults for the private choices.

## Chaos suite on a knights four-seat game

[`chaos-4p/`](chaos-4p/): `node tools/sim/dist/index.js net --scenario N --seeds 1 --seed 42 --players 4 --map knights --security verified` for scenarios 1 to 9, run one at a time. Games play to the default 13-point target with the explorer bots, so they include progress flows (109 progress plays and 114 seat-signed answers in the full-length runs), Wedding gifts, Saboteur discards, Harbor swaps, monopolies, hidden steals and pillage.

| Scenario | Games | Turns | Inputs | Wall time (s) | Progress plays | Seat-signed answers | Audits complete |
| -------- | ----- | ----- | ------ | ------------- | -------------- | ------------------- | --------------- |
| 1        | 1/1   | 190   | 1,592  | 1,020         | 109            | 114                 | 4               |
| 2        | 1/1   | 122   | 912    | 4,171         | 47             | 32                  | 4               |
| 3        | 1/1   | 150   | 1,108  | 861           | 45             | 40                  | 4               |
| 4        | 1/1   | 190   | 1,592  | 968           | 109            | 114                 | 4               |
| 5        | 1/1   | 186   | 1,554  | 1,249         | 81             | 85                  | 4               |
| 6        | 1/1   | 77    | 650    | 374           | 22             | 13                  | 3               |
| 7        | 1/1   | 190   | 1,592  | 968           | 109            | 114                 | 4               |
| 8        | 1/1   | 190   | 1,592  | 965           | 109            | 114                 | 4               |
| 9        | 1/1   | 190   | 1,592  | 1,045         | 109            | 114                 | 4               |

Every scenario completed without divergence or failure. Scenario 6 excludes seat 0 as a Byzantine proposer, so three peers audit. Two harness gaps showed up and were fixed: the network driver did not pick a choice owed off turn (a Wedding gift for two seats at once), and the excluded seat's stand-in actor did not answer requests only that seat can answer (a Spy's take). The scenario 6 run in the table is after the second fix; the other scenarios ran before it, which does not touch their paths.

## Not covered

- The `'hidden'` variants of Wedding, Master Merchant and Commercial Harbor are refused in a verified game; kinds moved by those cards are public.
- A hand a target seals to a Master Merchant is checked only by the merchant, so a bad seal stalls that play (no dispute record).
- The Commercial Harbor debit pre-proof is unit-tested and takes part in the games whenever public bounds do not vouch for the offered card; no test forces that case end to end.
