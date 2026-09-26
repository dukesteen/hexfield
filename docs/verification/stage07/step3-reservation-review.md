# Deck reservation correction review

**Scope:** I did a read-only check of the pasted response, implementation and tests. I ran nothing. I cite functions and tests by name.

**Verdict:** Every follow-up finding is addressed. I found no remaining concrete failure within the documented helper contracts. Two low-severity notes remain, and neither affects safety.

---

## High (follow-up): reservation scope vs. secret scope — **addressed**

**Secret scope.** `source.lock(j)` derives from:

- the master
- `{definition, deckId: deckSetupId(definition), seat}`
- the position

**Reservation scope.** `prepareDeckUnlock` now uses `positionId = ${deckSetupId(validatedSetup.value.definition)}/${op.position}/${seat}` for both `deck-position/…` and `deck-unlock/…`.

The master is per local seat, so each key now covers exactly one secret `b_{seat,j}`. Both sides hash the canonical parsed definition, so they cannot drift apart through representation.

The stored value is still `deckDrawOperationId(op)`, and `op.setupHash` hashes the full locked deck. Here is the follow-up trace re-run against the new code:

1. Under S1, H reserves `(id(def), j, H) → opId(R1)`.
2. Under S2, R2 computes the same key, but `opId(R2) ≠ opId(R1)` because `setupHash` differs.
3. `reservationMatches` is false, so the call returns `deck-outbox-position`. This happens before `source.lock` or `source.proofSeed` is called.

The equivocating last locker cannot reach `h_j` a second time, whatever position it varies.

Two cases do not cause failures:

- **Unused positions.** A second setup can still get `h_k` used once for a position k that H never used under S1. That is one use per secret, which is the intended invariant.
- **Mismatched source.** The helper does not check that `source` is bound to the same definition, but a mismatched source fails closed. `signDeckUnlock` rejects the lock via `lockKey`, and the reservation that was already written belongs to the correct operation, so nothing is burned.

**Regression: "reserves the lock secret across two valid locked setups of the same definition".** This is the real attack, not a simulation:

- It replays the genuine first five passes.
- Seat 2 (the last locker and R2's drawer) re-signs a valid alternate final lock that differs only at position 2 (`43n` vs `41n`), and `applyDeckPass` accepts it.
- It asserts the same `deckSetupId`, a different `setupHash`, and the same `initialPoint` at position 1. These are the preconditions of the trace.
- It then asserts `deck-outbox-position` with zero source calls.

The old setup-hash key would have signed here, so this test would fail against the previous code. The hard-coded ids in the outbox tests were updated to `deckSetupId(...)`.

## Pre-write signer validation — **addressed**

The following all happen synchronously, before the first `await`:

- the key is type- and length-checked;
- it is copied with `slice()`;
- it is matched against the participant for `seat`.

A wrong local key therefore cannot write another seat's reservation. The test asserts `deck-outbox-key`, `records.size === 0` and zero source calls. `signDeckUnlock` rechecks the signer later, so a key mutated after the check still fails closed without burning another seat.

_Nit:_ the test counts writes but not loads. The code does no load either, but the claim "before any storage access" is only half-evidenced.

## CAS handling — **addressed**

**Reservation.** The helper loads the reservation, then inserts it with `putIfAbsent` if it is absent. A losing writer must re-read a matching winner. A missing, corrupt or non-`Uint8Array` winner fails closed: `reservationMatches` catches it, and `undefined !== null` routes into the same check.

**Unlock record.** An existing record, or a CAS winner, is returned only after `verifyDeckUnlock(op, prefix, …)` passes. That check binds `operationId`, step, seat, signature and DLEQ.

- A new test covers a validly signed winner for another operation and gets `deck-outbox-record`. This closes the follow-up's minor gap.
- Concurrent callers for the same operation produce identical bytes. The seed context `{operation, step}`, the DLEQ nonces and Ed25519 are all deterministic.

## Copied inputs — **addressed**

These are all detached before the first `await`:

- `setup`, through `validateDeckSetupState`;
- `request`, through the strict `parseCanonical` in `freezeDeckDraw`;
- `prefix`, through `verifyDeckUnlockPrefix`;
- `key`, through the checked copy.

`source` and `store` are read after awaits but are trusted local objects under the contract, and misuse fails closed. The raw-operation injection test still shows zero reads and zero secret calls.

## Forged shuffle test — **addressed**

"rejects guessed challenge openings…" now does the following:

1. Takes the round-0 bit-1 commitment `(R, Y)` from the independent `expandExplicit`, not from the verifier.
2. Pins `r = a·u⁻¹` through `R = rG`. The discrete log is unique, so this is the only scalar a bit-0 opening could use.
3. Enumerates all 24 old→new permutations with the verifier's bit-0 semantics, `Y[ρ(i)] = r·in_i`, and shows that none matches.

Numerically, `Y` contains `(99/2)·G`, while `r·in_i = (7i/2)·G`. Since `7i ≠ 99` for i = 1…4, no match is possible. That is a real demonstration that this commitment cannot answer the opposite challenge.

The earlier objection, that a verifier ignoring `out` in bit 1 would go unnoticed, is now covered in two places:

- The honest-accept tests and the explicit/compact equivalence tests would fail under that mutation.
- The claim that removing the challenge comparison breaks this test is consistent with the code.

The test exercises one round and one commitment. It is a correct instance of special soundness, not a general proof, and it does not need to be one.

## Other follow-up items

- **Reservation before signer check:** fixed, as described above.
- **Setup negatives asserting only `.ok === false`:** fixed. The wrong-signature, out-of-order, sparse and hostile cases now assert `deck-signature`, `deck-order` and `deck-pass-count`.
- **Unlock store read/write error codes:** still conflated. This is acknowledged in the response and fails closed.

## Low notes (not safety)

- **`prepareDeckPass` input check.** It calls `key.slice()` outside any `try` and without an `instanceof Uint8Array` check. A non-byte `key` makes the promise reject instead of returning a `Result`. The input is caller-local, so this affects only totality, but it differs from `prepareDeckUnlock`.
- **Response wording.** "A different request can never reuse that position's secrets" (the `deck-outbox.ts` doc comment) now holds for all setups under one definition. It is still conditional on the store sharing the master's durability lifecycle, which the response states.

## Unchanged integration requirements

These remain as stated in the brief and are not helper defects:

- certified setup authority, and one locked setup per definition;
- genesis catalogue and roster checks, and binding a ceremony to genesis;
- requests derived only from certified pending;
- the drawer reserving before `decodeDeckCard`;
- one-time replicated consumption;
- owned-slot reveal checks before votes;
- a shared durable lifecycle for source and outbox;
- M4 cost and the 3 s Chromium target.

No proof algorithm or soundness parameter changed. The shuffle KATs are unchanged.
