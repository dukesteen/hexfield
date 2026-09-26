# Stage 07 Step 4 foundation review

I found no high-severity defect in the implemented scope.

**What I checked and found consistent:**

- **Engine propagation.** Effects pass through `advance`, `finalize` and the timeout delegation, and `SEAT_STATUS` returns an empty list.
- **Handler coverage.** Every base handler that changes resources or slots emits matching effects:
  - The setup grant is limited by the bank.
  - Build and dev-card purchases use the hook-adjusted cost.
  - Production handles shortages after `computeProduction`.
  - Year of Plenty receipts are limited by the bank.
  - Trades, discards and the timeout discard record gross debits and credits.
  - Monopoly zero reveals are explicit.
  - `CARD_DEALT`, `PLAY_DEV_CARD` and `CLAIM_VICTORY` record slot changes.
- **Public and private agreement.** Each handler's `apply` and `applyPrivate` compute their amounts from the same parent-derived state.
- **Per-resource replay.** The checker replays one resource at a time, while the engine applies `loseKnown`/`gainKnown` to a whole count map. These give the same result, so this does not cause false rejections. Box bounds intersected with a fixed total are closed under exact subtraction and addition, and one normalization pass gives the exact projection.

## Confirmed defects

**1. Low: `packages/protocol/src/hand-commitments.ts:137` (`applyPublicResourceEffect`)**

- **Problem:** `effect` is read before it is validated as a plain record and outside the `try`.
- **Counterexample:** `applyPublicResourceEffect(ledger, [0,1], null as never)` throws a `TypeError` instead of returning a `Result`. A getter on `count` would also run.
- **Fix:** Parse `effect` with a strict schema through `parseCanonical`. The schema should cover `seat`, `resource`, `direction` and an integer `count` from 0 to 63. Use only the parsed copy afterward.

**2. Low: `packages/protocol/src/resource-accounting.ts:40-43` (`checkResourceCount`, used by `resource-transfer`)**

- **Problem:** A transfer with count 0 is accepted, although the engine never emits one (`resourceTransfers` filters zeros).
- **Counterexample:** A zero transfer for a seat and resource is accepted and marks that pair as moved. A later valid `resource-count-revealed` for the same pair in the same input is then rejected. It also allows several encodings of one effect list, and effect identity is planned to enter proof contexts.
- **Fix:** Require `count >= 1` for `resource-transfer`. Keep `>= 0` only for `resource-count-revealed`.

**3. Low: the checker accepts endpoint substitution and reordered legs**

- **Counterexample:** For a player trade, the list `[0→bank brick 1, bank→1 brick 1, 1→bank ore 1, bank→0 ore 1]` passes. So does the correct list with the two trade directions swapped. Bank and hand totals match in both cases.
- **Impact:** The per-owner debit obligations are unchanged, so this does not affect base security. It does mean the checker cannot confirm endpoint identity or order.
- **Fix:** Document this next to the existing net-zero limitation. Alternatively, reject seat→bank→seat pairs when a direct seat-to-seat effect is expected.

## Missing high-value tests

1. **Counter-offer confirmation.** Add `CONFIRM_TRADE` where the proposer is a non-active seat, the active seat confirms and `withSeat` is the proposer. Check the effect order and both owners' `applyPrivate` results. The plan asks for both trade forms, and the current test covers only the offer made by the active seat.
2. **Year of Plenty with a partial bank.** For example, request 2 ore when the bank has 1 ore. Expect `card-slot-revealed`, then a single bank→seat ore 1 transfer. Compare it with the private delta. The plan names this case and nothing covers it.
3. **Production shortage with several recipients.** When two seats demand more than the bank holds, expect no effect and an unchanged bank for that resource. Only the single-recipient shortage is tested.
4. **Hook-adjusted dev-card cost.** Apply `costOf` to `devCard`; only `road` is tested.
5. **Checker on real engine transitions.** Run `verifyResourceAccounting` on the real engine transition for each of these inputs:
   - A hidden `STEAL_RESULT` from an uncertain hand, so the checker covers `hidden-resource-transfer`.
   - A named steal.
   - Monopoly against an uncertain victim, with both a zero and a positive count.
   - Maritime trade, `DISCARD`, Year of Plenty, a knight play and `CLAIM_VICTORY`.

   The simplest way is to call the checker inside `applied()` in `effects.test.ts`. Also run it over the existing golden replays, without adding new random batches. At present only setup, production, purchase and deal are checked end to end.

6. **Effects against private deltas.** Add a shared helper: for each seat with a known hand, the net of its effects must equal `applyPrivate(after) − before`, per resource. The checker compares effects only with public bounds, so a mismatch between a handler's `apply` and `applyPrivate` would still pass.
7. **Hand helper edge cases:**
   - An encoding of length 43 that fails to decode, or that decodes but is not canonical.
   - A roster of the same length but different seats, such as `[0,1]` against `[0,2]`.
   - A blinding encoded as a value at or above the scalar order.
   - Missing or extra keys in `counts` or `blindings`.
   - Fractional or negative counts.
   - An opening for a seat not in the roster.
   - A debit below zero, to document that the arithmetic succeeds without authorizing anything.
8. **Goldens.** This packet does not show that existing state hashes, events or golden replays are unchanged. Please confirm that the existing golden suite passed unmodified with this change.

## Future integration notes

These are not defects in this foundation.

- **Effects have no provenance.**
  - A named `STEAL_RESULT` emits an ordinary seat→seat `resource-transfer`, identical in shape to a trade leg. Verified-mode rejection must be keyed on the input type (`STEAL_RESULT`) and on any `hidden-resource-transfer`, not on the shape of the effect.
  - A monopoly debit is authorized only by the preceding reveal for the same seat and resource. Derive that pairing from engine output, never from peer metadata.
- **Obligations must use parent bounds, not checker intermediates.** The checker's sequential replay lets a credit fund a later debit, as in maritime get-after-give or the trade recipient's leg. Proof derivation should sum gross debits per seat and resource across the whole input. It should then compare that sum with the parent minimum, or with a verified exact reveal, before any credit.
- **Public bounds are sound only if hidden transfers are proven.** Monopoly excludes seats whose maximum is 0, and range proofs are skipped when the parent minimum covers the debit. Both rely on the minimum and maximum bounds staying sound, which requires Step 5 to prove every hidden transfer before any bound derived from one is trusted.
- **Card identity in `card-slot-revealed` is the claimant's assertion.** `PLAY_DEV_CARD` and `CLAIM_VICTORY` take `card` from the command. Deck proofs must bind it to the slot. Also, `deck: 'dev'` is hard-coded in `devcards.ts` (`playDevCard.apply`) and `victory.ts:49`. Use the slot's actual `deck` before expansions add other decks.
- **Effect objects share references.** `exchangeBank` reuses one endpoint object across every effect it emits, and `advance`/`finalize` pass the handler's array through unchanged. Deep-copy or freeze the effect list before hashing it into proof contexts.
- **Checker limits are base-specific.** The limits of 64 effects, counts of 63 and bank keys equal to `RESOURCES` should come from module configuration before another module is enabled in verified mode.
- **Timeout discards need no proof, but must still pass validation.** `TIMEOUT` in the discard phase works only for exact hands, where the minimum covers the debit. It should still go through the same command-validation and ledger fold as `DISCARD`.
