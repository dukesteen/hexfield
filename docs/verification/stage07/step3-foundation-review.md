# Deck protocol foundation review: Stage 07 Step 3, part 1

**Scope:** read-only review of the pasted files. I did not run or change anything. Line numbers are given only where I could count them reliably from the pasted text; otherwise I cite the function name.

**Verdict:** The core algebra is correct. That covers the shuffle proof, the lock DLEQ, the unlock DLEQ, the reveal DLEQ, and how their contexts and statements are bound. I found no soundness regression from the window-4 precomputation.

The two most serious problems are not in the maths. They are in how secrets are derived and how the outbox is keyed:

- Deterministic setup secrets are bound only to the deck definition.
- The unlock outbox is keyed by operation, not by deck position.

Each one can turn a single malicious peer into a decryption or permutation oracle unless integration adds guards that this packet could provide more cheaply itself. Test coverage has several gaps where a negative test stops at the signed envelope before reaching proof verification.

---

## High

### H1. `prepareDeckUnlock` works as an unlock oracle for any `initialPoint`, and the outbox does not enforce one unlock per position

**Where:** `deck-outbox.ts:39` (id `deck-unlock/${opId}/${step}`), `prepareDeckUnlock`, `signDeckUnlock`.

The function takes a `DeckDrawOperation` and checks only its shape and prefix:

- `validateDeckDrawOperation` does not re-derive `initialPoint` from the setup.
- `signDeckUnlock` checks only that `lock·G == participant.lockKey`, and that key is public.

The brief lists operation authority as a caller check. But this function is the last point before a secret scalar is applied, and its outbox key does nothing to limit one unlock per position.

**Failing trace (3 seats; the honest seat H drew position j):**

1. After H's draw is certified, `Z = b_{H,j}·P` is public.
2. Attacker M builds `op'` from the genuine operation:
   - `seat = M`
   - `initialPoint = Z`
   - participants copied from the real operation, so H's `lockKey = B_{H,j}` is included
   - new `slotId` and `anchor`
3. `op'` passes `validateDeckDrawOperation`, and H is now a non-drawer at some step.
4. If integration ever lets `op'` through, H's `prepareDeckUnlock` signs `b_{H,j}^{-1}·Z = P`, so M learns H's card.
5. The outbox id differs from H's earlier records because the operation id differs, so the store does not stop it.

**Same-position case:** the same thing happens with a legitimately certified second request for position j that names a different drawer, for example after a replay bug or a parent change. The ids differ, so both unlocks are signed.

**Suggestions (API shape, not code):**

- Make the unlock entry point take `(verifiedSetup, request)` and call `freezeDeckDraw` itself.
- Key the immutable record by `(setupHash, position, seat)`.
- Refuse, rather than return, a stored record whose operation differs.

That gives defence in depth for "ordered one-time draw consumption" at the only place a secret is used.

### H2. Setup secrets ignore the pre-pass state and there is no setup outbox, so a peer who equivocates can recover π_i

**Where:** `deck-source.ts` (`shuffle`, `permutation`, `lock` use `domain = {definition, deckId, seat}`); `signDeckShuffle` and `signDeckLock` in `deck-setup.ts` (these return unpersisted passes; persistence is left to a doc comment).

`a_i`, `π_i` and `b_{i,j}` are identical for every input state under one definition. Proof nonces do change with the statement, so the proofs themselves are safe. The raw shuffle output is not.

**Failing trace (2 seats, seat 0 malicious):**

1. Seat 0 sends seat 1 a valid shuffle pass producing state S with points X.
2. Seat 0 later sends a second valid pass, for example after a claimed reconnect, producing S′ with X′ = X with positions 0 and 1 swapped.
3. `deckPassOperationId` differs, so seat 1 has no reason to refuse and signs both.
4. `out = π₁(a₁X)` and `out′ = π₁(a₁X′)` differ exactly at positions `π₁(0)` and `π₁(1)`.
5. After about m/2 such equivocations, seat 0 knows all of π₁ and also knows π₀. That gives the full σ, so seat 0 can decode every card seat 1 draws.

Equivocation on the lock pass is similar. It gives a chosen-input oracle `X ↦ (b_{1,j}/a_1)·X`. With X built from seat 1's own shuffle outputs, that yields `b_{1,j}·k·P_c` for known k.

**Suggestions:**

- Add an immutable signed-pass record keyed by `(deckSetupId, seat, phase)` that refuses a second `operationId`, mirroring the unlock outbox.
- Optionally, also bind derivation to the pass `operationId`. This is safe for restoration because the certified pre-pass state is deterministic.
- As it stands, the stated guarantee "persistence-before-return" holds for unlocks only.

---

## Medium

### M1. Test negatives often stop at the envelope, and error codes are not asserted

**`deck-draw.test.ts`, "binds unlocks to operation, position, slot, anchor, epoch and genesis":**

- All five cases fail at `deck-unlock-order`, because the signed body's `operationId` differs.
- None of them reaches `verifyDleq`. So the DLEQ context binding (`unlockContext`) is never shown to matter.
- Missing case: re-sign the old body and proof with the new `operationId`, using the unlocker's own key. This models a malicious unlocker replaying a proof. It should return `deck-unlock-proof`.

**`deck-setup.test.ts`:**

- Every negative asserts only `.ok === false`.
- The substituted, re-keyed and altered-lock cases do happen to reach `verifyShuffle` or `verifyDleq`, but a regression that rejected them earlier would still pass.
- Assert `deck-shuffle-proof` and `deck-lock-proof`.

**Error codes never exercised:**

- `deck-operation`: needs a pass signed for state S with the same next actor, applied to S′.
- `deck-points` and `deck-key` for shuffle and lock passes: identity output, identity `publicKey`, duplicate `lockKeys` in a row.
- No lock-pass substitution case: swap `output[0]` and `output[1]` with correct proofs, re-signed. This is the table's "re-keyed/substituted card in locking pass" row at the protocol level.

**The "substituted" shuffle test does not test substitution:**

- Reordering a valid output is still a permutation of `a·in`. It is rejected only because the transcript binds the order.
- The crypto-level "substituted" and "rekeyed" cases likewise reuse `validProof`, so they also only test binding.
- A soundness-style test would use a cheating prover that prepares every round for a guessed bit (for example, all bit-1 openings consistent with a substituted output) and show that it is rejected unless the challenge matches the guess.

**`deck-setup.test`, "rejects ... before proof work":** it does not demonstrate the "before proof work" part. Nothing observes that verification was skipped.

### M2. No end-to-end or restoration test through `createDeckSecretSource`

- `prepareDeckUnlock` tests use a fake source.
- Setup tests use literal scalars.
- Nothing checks that `source.permutation()` (old → new) matches how `signDeckShuffle` and `proveShuffle` interpret a permutation. They are consistent by inspection, but untested.
- Nothing checks that a recreated source plus a fixed `proofSeed(role, context)` reproduces **byte-identical** signed passes. That is the retransmission requirement.

### M3. `decodeDeckCard` and `revealStatement` read the card table from the raw `setup`, not the validated copy

**Where:** `deck-draw.ts`, `identityPoint(setup, …)` and `setup.definition.cards.find(…)`.

- `verifiedReceipt` validates a copy inside `freezeDeckDraw`, but the lookup then re-reads the caller object.
- `canonicalEncode` reads property descriptors, while later code uses `[[Get]]`. A Proxy whose `get` trap disagrees with its `getOwnPropertyDescriptor` trap could therefore pass validation and then supply a different `card` kind or `ceremonyId`.
- The setup is local and trusted, so this is low exploitability. It is still inconsistent with the "parse, then use the copy" rule applied everywhere else.

### M4. Verification cost on each command before voting

`verifyDeckReveal` (and `decodeDeckCard`) re-runs `validateDeckSetupState` on every call. That means:

- up to 128 × 7 ristretto decodes, each with a sqrt;
- up to 5 signature checks and 5 DLEQ checks;
- a linear pass of hash-to-curve over the card table.

This is bounded but repeated on the voting path. A receipt verified once in `CryptoContext` would avoid it. Replay has a similar cost: `applyDeckPass` validates the state three times per pass (on entry, inside `deckPassOperationId`, and on return), and `initDeckSetup` hashes to curve twice.

---

## Low

- **Reveal parent can equal the draw anchor.** `revealStatement` accepts `anchor.seq === operation.anchor.seq`, and the draw-context test relies on this. A real reveal must come after the certified `CARD_DEALT`, but neither the receipt nor the context binds that entry. Consider requiring a strictly later parent, or binding the deal entry.
- **Ceremony decks have no draw-parent check.** For `creation.kind === 'ceremony'`, `freezeDeckDraw` accepts any `genesisDigest`, epoch and anchor. Nothing ties the genesis to `ceremonyId`. This is a caller check, but worth documenting beside the certified branch.
- **No domain tag on `setupHash`.** `setupHash = toHex(hashValue(deck))` has no domain, unlike `deckSetupId` and `deckPassOperationId`. The setup proof contexts `{operationId, phase, seat[, position]}` also lack the explicit `domain` field that the unlock and reveal contexts carry. Collisions are implausible because `operationId` is itself domain-hashed, but this is inconsistent.
- **Outbox error codes are conflated.** A throwing `store.load` is reported as `deck-outbox-write`. Separate read failures from write failures for diagnostics.
- **Deck participants are not tied to the manifest.** Nothing ties deck participants and their keys to the manifest's per-game keys. `ceremonyId` binds the manifest hash, but the roster match is implicit.

---

## Mathematics checked and found sound

**Shuffle proof, bit 1.** The prover sets `τ[ρ(i)] = π(i)`. The verifier computes `Y_{ρ(i)} = u⁻¹·out_{π(i)} = r·in_i` and `R = u⁻¹A = rG`. This matches bit 0.

**Shuffle special soundness.** Two openings of one round give `a = u·r` and `out_{τρ(i)} = a·in_i`. Together with the bijection checks and the distinctness and non-identity checks on both sides, the proof is also a proof of knowledge of `a`. So the shuffle key cannot be copied from another seat.

**Lock DLEQ.** `log_{X_j}(out_j) = log_{A_i}(B_{i,j})` with `B = b·G` and exponent `b/a`, so `D[j] = ∏b·P`. Per-row distinctness of lock keys is enough. Equal keys across seats would need knowledge of another seat's `b`.

**Unlock DLEQ.** `log_{Z_i}(Z_prev) = log_G(B)`. `Z_i` must be non-identity, so it is uniquely `b⁻¹·Z_prev`. Because the prefix is fully verified, an honest unlocker only ever strips its layer from `∏b·P`. The oracle in H1 exists only through a forged `initialPoint`.

**Reveal DLEQ.** `Z = b·P_id` and `B = b·G`. Card points are distinct, so at most one identity satisfies this. The context binds:

- the draw operation id, which covers setup, position, slot, owner, ordered keys and initial point;
- the identity;
- the full command, nonce, anchor and epoch.

**Nonce safety.** All DLEQ and shuffle nonces derive from (seed, context, statement). Reusing a nonce therefore implies an identical challenge. Reusing a seed across positions or states is safe.

**Mutable inputs across awaits in `prepareDeckUnlock`.**

- The operation and prefix are detached by `parseCanonical` before the first await.
- `key` and `source` are read after the await, but mismatches fail closed through the signer check and the `deck-outbox-source` error.
- Concurrent callers produce identical bytes, because Ed25519 is deterministic and the seed is deterministic.
- A value is returned only after `putIfAbsent` succeeds, or after the winning record is re-verified.

**Malformed input.** Every public entry point I traced is total on hostile values. The byte cap applies before decoding, holes, accessors and proxies are rejected, and signatures are checked before group work in `applyDeckPass` and `verifyDeckUnlockPrefix`.

## Shuffle optimisation

- **No soundness change.** The rounds, challenge truncation, transcript contents and verification equations are unchanged, and the three hash KATs pin the prover bytes.
- **Verifier coverage.** The KATs do not cover the verifier. Its behaviour is covered by the independent explicit-transcript test and the accept tests, which is adequate. A 25-card or 128-card KAT would close the size gap cheaply.
- **Secret safety.** `precompute(4, false)` builds tables only for public points. `multiply` stays on Noble's constant-time wNAF path with fake additions, and prover secrets (`r`, `u`) never go through `multiplyUnsafe`.
  - Indexing arrays by the secret `ρ` (in `permute`) leaks through memory access, as it did before. That is inherent in JavaScript and unchanged by this work.
- **Caches.** Noble keys the window tables in module-level `WeakMap`s on per-call decoded point objects. They are collectable once the call returns, so no unbounded cache is introduced. `MAX_CARDS = 128` is enforced before precomputation.
- **Headroom for the open 3 s target.** Verifier response scalars are public, so a variable-time or multi-scalar verify path is permissible there, but only there. Removing the triple state validation in replay also helps.
- **Target status.** Nothing in the packet claims the 3 s target is met, which matches the brief.
