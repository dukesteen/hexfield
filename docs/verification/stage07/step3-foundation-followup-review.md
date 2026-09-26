# Deck foundation correction review: follow-up

**Scope:** read-only check of the response against the pasted source and tests. Nothing was run. I cite function names rather than line numbers.

**Verdict:** M3 is closed. H2 is closed within the helper contract. H1 is closed only for requests that share one locked setup. A remaining helper defect lets two valid locked setups under the same deck definition bypass the position reservation. That rebuilds the original H1 oracle, so it keeps H1's severity. The new tests reach the intended checks, except the forged-shuffle test, which cannot detect the property it claims to test.

---

## High: H1 remains open across conflicting locked setups

**Where:** `prepareDeckUnlock`, specifically `positionId = ${op.setupHash}/${op.position}/${seat}`, which is used for both `deck-position/…` and `deck-unlock/…`.

**The mismatch:**

- The secret being guarded, `b_{i,j} = source.lock(j)`, depends only on `(definition, seat, position)`.
- The reservation depends on `setupHash`, which hashes the whole locked deck.
- A peer that locks after an honest seat can create a second valid locked deck for the same definition without that seat signing anything new.
- `prepareDeckPass` does not prevent this. The honest seat's single stored lock pass is valid in both histories.

**Failing trace (2 seats; H = seat 0 and M = seat 1; order: shuffle H, shuffle M, lock H, lock M):**

1. The shuffle passes and H's lock pass are shared. Each is signed once, as the pass outbox requires.
2. M sends two valid final lock passes, `L_M` and `L′_M`, for the same pre-lock state. They differ only at some position `k ≠ j`. Both replay through `applyDeckPass`, giving locked setups S1 and S2 with `D1[j] = D2[j]` but `setupHash1 ≠ setupHash2`.
3. Under S1, request R1 names H as drawer of position j. H reserves `(setupHash1, j, H) → R1`. M unlocks, and H decodes `P_c`.
4. Under S2, request R2 names M as drawer of position j, and H is unlocker step 0.
5. `prepareDeckUnlock(S2, R2, …)` looks up `(setupHash2, j, H)`, finds it empty, reserves it and signs `h_j⁻¹·D2[j] = m_j·P_c`.
6. M removes its own layer and learns H's card.

This is exactly the "conflicting valid setup predecessors" case. The doc comment's claim that "a different request can never reuse that position's secrets" is false across setups.

It needs the same integration slip as the original H1: H must accept S2 as a verified setup. That is why it keeps H1's severity rather than being rated lower.

**Fix shape (no code):** key both the reservation and the unlock record by `deckSetupId(definition)`, position and seat. `prepareDeckPass` already uses that key.

- The stored value is still the full `deckDrawOperationId`, which covers `setupHash`.
- R2 would therefore mismatch R1's reservation and fail without reading secrets.
- Add a test using two locked setups that differ only in the last locker's pass at another position.
- The hard-coded `positionId` strings in `deck-draw.test.ts` will need updating.

Everything else in H1 checks out for a single setup:

- **Changed drawer, slot or parent:** fails on the reservation before `source` is touched. The tests cover this for both a former drawer and a former unlocker.
- **Concurrent calls, same operation:** the reservation compare-and-swap (CAS) and re-read agree, and both callers produce identical deterministic bytes. The loser returns only the verified winner.
- **Concurrent calls, different operations:** exactly one reservation wins. The loser fails before `lock()` or `proofSeed()` is called, including when the winning record is missing.
- **Drawer and waiting seats:** they reserve and return `null`. The tests assert zero source calls.
- **Retries:**
  - A crash between reserving and writing the unlock re-signs the same bytes.
  - A stored unlock is re-verified against the current prefix. The prefix point is unique, so a valid equivocated prefix still accepts it.
- **Raw operation injection:** `strictObject(requestFields)` rejects the extra keys before storage or secrets are touched.
- **Mutable inputs:**
  - `setup`, `request` and `prefix` are detached before the first await.
  - `key` and `source` are read later, but they fail closed: `signDeckUnlock` rechecks the signer.

## H2: closed within the helper contract

- **Record key.** Records are keyed per definition, seat and phase. A stored pass is accepted only if `applyDeckPass(state, pass)` succeeds, so a competing predecessor fails with `deck-operation` → `deck-outbox-record`.
- **Concurrency.** Concurrent writers with different histories may each compute an output in memory, but only a verified stored winner is returned.
- **Mutable inputs.** The signer is copied and checked before any storage access, and the state is detached before the first await.

Residual items that are not defects in this helper:

- `signDeckShuffle` and `signDeckLock` are still exported with unbound secrets. The guard applies only when callers go through `prepareDeckPass`.
- The empty-store reproduction test also shows that the guard is only as durable as the store. A restored master with a lost outbox can sign for a different history. The coordinator must keep the outbox in the same durability domain as the master.

## M3: closed

- `decodeDeckCard` and `revealStatement` read only `verified.setup`.
- The proxy test reaches the right paths. Descriptor-based validation sees the real table, while `[[Get]]` would have returned `forged-kind`. The old code fails this test and the new code passes.

## Tests: do they reach the intended checks?

The following reach the intended checks:

| Test                        | Check reached                                | Why                                                                                                                                                                                                  |
| --------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replayed unlock proof       | `verifyDleq` → `deck-unlock-proof`           | Same statement (same position, lock and initial point, so the same point), with only the context's `operationId` changed                                                                             |
| Setup negatives             | Each asserted code, in `applyDeckPass` order | Covers `deck-shuffle-proof`, `deck-lock-proof` (swapped proofs and swapped outputs), `deck-operation`, `deck-points` (identity output) and `deck-key` (identity shuffle key and duplicate lock keys) |
| Factory end-to-end          | Old→new composition                          | Correctly checks `second[first[i]] === 0`; the store holds the expected three records                                                                                                                |
| Literal-permutation fixture | Mapping at every position                    | `[0, 2, 1]` is the right mapping                                                                                                                                                                     |

**Low: the forged-shuffle test does not test soundness.** In "rejects guessed challenge openings…", every round is bit 1. The verifier rebuilds bit-1 commitments from the output itself, so every opening is consistent by construction. The only check that can fail is the final eight-byte comparison against `0xFF…`, a 2⁻⁶⁴ event. As a result:

- The test would still pass if bit-1 reconstruction ignored `out` entirely.
- It would pass with a true statement.
- It never exercises bit 0.

A meaningful version for m = 4, given the test knows `a`, would:

1. Prepare bit-1 commitments for the false output.
2. Show that no `(r, ρ)` over the 24 permutations, with `R = rG`, reproduces the committed `Y` from the input.

That demonstrates that a mismatched guess cannot be answered. Soundness evidence currently comes only from the explicit-transcript equivalence tests.

Minor gaps:

- Some setup negatives still assert only `.ok === false`: the wrong signature, the out-of-order actor, and the sparse and hostile lists.
- No test covers a CAS winner that is validly signed but belongs to another operation. Only corrupt bytes are covered.

## Low / notes

- **Reservation before signer check.** `prepareDeckUnlock` writes the reservation before checking that `key` belongs to `seat`, unlike `prepareDeckPass`. A caller that passes the wrong seat, for example on a bot host that shares one store, can permanently burn another local seat's position. That affects liveness only.
- **No release path for reservations.** This is correct for safety. It does mean that calling `prepareDeckUnlock` on a proposal rather than a certified request lets a sequencer stall a position forever. The coordinator must invoke it only from certified pending requests.
- **Unlock store error codes.** A read failure is still reported as `deck-outbox-write`. The response already acknowledges this, and it fails closed.

## Missing integration (not helper defects)

- Accept exactly one certified locked setup per definition. Once the High item is fixed, the helper also defends against a second setup.
- Compare the catalogue and roster to genesis, and tie a ceremony setup to its genesis.
- Derive the request from certified pending, and consume positions once and in order in the replicated ledger.
- Make the drawer call `prepareDeckUnlock` before `decodeDeckCard`. Decode and reveal do not consult the reservation.
- Bind the reveal to the certified `CARD_DEALT`. A strictly later anchor is necessary but not sufficient.
- Check owned-slot reveal proofs before votes.
- M4 re-validation cost and the three-second Chromium target both remain open, as the brief states.
