# Hidden-steal review fixes

## Verdict

Within the attached files, the fix closes the chosen-point dispute oracle for hidden-steal. I found **no concrete high or medium defect in the attached code**.

There is one open condition I cannot check from these files: every other path that discloses `x·P` under the same encryption key needs the same guard. The remaining findings are low severity, plus some test gaps.

## Why the oracle is closed

**Creation side.** An honest thief only discloses `xR` through `createStealDispute`. That function goes through `checkedFixed` → `verifyStealContribution`, so the ephemeral proof of knowledge (PoK) is re-checked on the exact fixed contribution before any disclosure. This holds even if replayed state were bad.

**Copied proofs.** The Fiat–Shamir challenge covers `{recipient, sealed (R and ciphertext), sealContext, context}`. The contexts include the operation ID and transfer, so a copied `(commitment, response)` pair fails under any change. The copied-point test exercises exactly this trace.

**Altered ciphertext.** Changing the ciphertext changes the transcript. A new proof needs `log_G R`.

**Related points.** Take `R' = R_old + kG`. A PoK for `R'` requires knowing `r_old + k`, which means knowing `r_old`. Since `xR' = xR_old` only when `R' = R_old`, a fresh `R'` reveals nothing about earlier ciphertexts.

**Malformed points.**

- Ristretto has prime order, so there is no small-subgroup risk.
- `key32Schema` and `decodePoint` enforce canonical encodings.
- `readPayload` rejects an identity `R`, and the dispute rejects an identity shared point.
- An identity Schnorr commitment still forces `s = c·r`.

**Seed and nonce reuse.**

- The Schnorr nonce is `proofNonce(deriveBytes(seed, proofRandomness, T), 'schnorr', T, {G,R}, …)`.
- The challenge is a function of `(T, {G,R}, A)`, and all of these are determined by `T`.
- So an identical nonce implies an identical transcript and an identical challenge. No two-challenge leak of `r` is possible.
- Derivations are domain-separated from each other: `derive-bytes` vs `derive-scalar` info strings, and different HKDF keys (`seed` vs `entropy`). This separates them from the hidden-transfer and dispute nonces.
- Seal output is unchanged because `seal` is called first, and the pinned KAT asserts it.

**Omitting a replay registry.** I agree, and I could not construct a counterexample. With a sound PoK, whoever produced the proof knows `r`, and `xR = rE` is then computable by that party. Publishing `r` is already a publicly verifiable reveal (anyone checks `R = rG` and decrypts), so the thief-signed DLEQ adds no capability. Coalitions don't change this: whoever supplied `r` could reveal `c1` directly.

This rests on one assumption the code doesn't enforce: seal seeds must be sender-private. If any caller passes a shared or beacon-derived seed to `seal`, then `r` is known to parties who shouldn't be able to decrypt, and the argument fails. Consider documenting this on `seal` and `sealWithEphemeralProof`.

## Remaining findings

### 1. Conditional High: the same `x` disclosed elsewhere without a PoK (not verifiable here)

The fix only works if every path that discloses `x·P` under the thief's `encryptionKey` requires a PoK of `log_G P`, or uses a key dedicated to that path. This includes dispute paths, private-delivery disputes, deck partial decryption, and trade delivery (`step4-trade-delivery-design.md`).

Failing trace, if such a path exists:

1. Third party M (not the steal victim) reads `R_steal` from a certified steal contribution.
2. M places `R_steal` into its own sealed payload to the thief under protocol Y, where Y lacks the PoK check.
3. M sends garbage ciphertext.
4. The honest thief disputes under Y and reveals `x·R_steal` with a DLEQ.
5. M decrypts the steal ciphertext (the seal context is public) and learns the stolen resource.

The reverse direction is also a risk: any decryption-share API that accepts attacker-supplied `C1` and uses this same `x`.

Please attach `steal-inbox.ts`, `steal-contributions.ts`, the deck delivery or dispute code, and the trade design, or confirm that `encryptionKey` is used only by hidden-steal. Also confirm that the private driver never computes `x·R` outside `createStealDispute`.

### 2. Low: the cache key and the verifier read the input differently

`verifyStealTransfer` is exported and keys the cache on `hashValue(statement, proof, context)`, which reads the caller's objects through `canonicalEncode`. `verifyHiddenTransfer` reads them through descriptor-only readers (`readProofRecord`).

Trace, assuming `canonicalEncode` invokes getters:

1. A valid proof `P` is cached.
2. A caller passes an object whose getter-backed fields encode to `P`.
3. The cache hits and returns `true`, though the uncached verifier would reject the accessor.

This is not reachable from `verifyStealContribution`, because the proof comes from the `parseCanonical` copy and the statement is built locally. The fix is simple: inside `verifyStealTransfer`, canonical-encode once, decode a copy, hash those bytes, and verify the decoded copy. Or make the function module-private.

Other cache properties are sound:

- Entries are inserted only after successful verification.
- Keys include the full proof and the context carrying the operation ID. The statement includes `payloadHash`.
- Eviction by flooding with valid proofs costs performance only.
- The signature, ephemeral PoK, and operation checks all run before the cache lookup, so the cache does not bypass authority.

### 3. Low: `validateStealState` rebuilds `fixed` loosely

`fixed = { ...value.fixed, … }` keeps unknown keys from stored state, and `fixed.entry` is not schema-parsed.

- A missing `entry` throws outside any `try`.
- Extra keys pass here but later fail `parseFixed`'s `strictObject` inside `verifyStealReceipt`. The steal can then never complete, which is a liveness failure from corrupted state.

It fails closed on safety. The fix is to build the object explicitly, `{ operation, contribution, entry: parse(entryRefSchema) }`, as `parseFixed` does.

### 4. Not reviewable here

I did not see `log.ts`. I therefore can't confirm the claim that the validated cryptographic state feeds both receipt verification and the hand fold. `completeStealResult` trusts `steal.fixed.contribution.body.transfer` as supplied. This is correct only if the caller passes the output of `validateStealState` or `fixStealContribution`, never the raw stored value.

## Verified as described

- **Dispute verification order:** binding → recipient signature → DLEQ → reject a good opening → full contribution check. It computes only a bounded decrypt before the heavy proof, and the stored dispute binding is compared against the full `stealReceiptBinding(fixed)`.
- **Receipt verification:** it checks the binding and the thief signature before the expensive proof.
- **Transcript binding:** the ephemeral proof is bound through `contributionHash`, because the signature and receipt cover the whole body, and canonical schemas prevent malleability.

## Test gaps

1. **Creation-side refusal.** No test asserts that `createStealDispute` on the forged-ephemeral `fixed` fails without output. That check is where the oracle actually closes.
2. **Full-payload copy.** No test copies an earlier `sealed` plus `ephemeralProof`, both unchanged, into a newly signed contribution for a different operation and expects `steal-ephemeral-proof`. The existing test changes the ciphertext; this would pin the sealContext and context binding.
3. **Cache with the real body path.** No test covers a byte-identical transfer proof with a different `sealed` value. The expected result is a cache miss and rejection through `payloadHash`.
4. **Generic helper contract.** A test or doc should state that the context passed to `sealWithEphemeralProof` must bind the sender and operation. The steal path does this through the operation ID, but other callers of the crypto helper may not.
