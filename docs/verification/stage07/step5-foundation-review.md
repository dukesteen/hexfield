# Review: hidden-steal proof and private delivery (Stage 07 Step 5 foundation)

This covers only the attached snapshot. It is not a review of the multiplayer protocol, the replay layer, `STEAL_FIXED` certification or recovery. I could not see `@cp2p/codec`, `signObject`/`verifyObject`, `parsePeerId` or `canonicalDecode`. Where a finding depends on their behaviour, I say so.

**Overall:** I found no soundness or zero-knowledge break in the transfer mathematics or the CDS composition. The findings below are about verification cost, canonical encoding, attributable verdicts and test coverage.

## Q1. Transfer mathematics: verified correct

- **Index branch statements:**
  - `L_r = idx·G − P_r` opens with blinding `−Σ_{r'<r} s_{r'}`. The prover uses `modScalar(-selectedPrefixBlinding)`, which is correct.
  - `U_r = P_r + C_r − (idx+1)·G` opens with `prefixBlinding + s_r`, which is correct.
- **Zero counts:** a branch with `n_r = 0` needs `idx ≥ p_r` and `idx ≤ p_r − 1`, so it is unsatisfiable. `createStealContribution`'s `findIndex` on the cumulative prefix never selects a zero-count type.
- **Totals and prefixes above 63:** only the distances are range-bounded, so these work. The `[40,30,20,1]` and eight-type tests exercise this.
- **One-hot:** the bit ORs plus the `Σ T − G` opening give one-hot. The branch opening of `T_r − G` then pins the true branch to `r*`. The standalone Fiat–Shamir proofs are AND-composed at the top level only. Opening and ranges share one branch challenge, and the verifier sums the branch challenges to one hash over the ordered statement and all first messages. Nothing is nested as an independent Fiat–Shamir proof under the OR.
- **Simulation:** simulated range bit commitments are `r·H` with a derived last commitment. That distribution is uniform, so it is indistinguishable from honest commitments.
- **Nonces:** every nonce binds seed, domain, the complete statement and context, and role. Standalone, composed and simulated modes use distinct domains. `respond` is single-use.
- **Assumption, not a defect:** soundness requires every `C_r` to commit to a small non-negative integer. `handSize` is not tied cryptographically to `Σ C_r`. `applyPublicResourceEffect` caps each movement at 63 but not the resulting value.
  - If a debit that the bounds cannot establish is ever applied without its range proof, some `C_r` could hold a "negative" (wrapped) value. The prefix field elements then no longer order the hand.
  - The replay layer must enforce this invariant. State it next to `verifyHiddenTransfer`.

## Findings

### M1: Receipt and dispute verification do expensive group work before cheap checks (DoS)

**Where:** `steal-delivery.ts`, in `verifyStealReceipt` and `verifyStealDispute`, both via `checkedFixed`.

**Problem:** `checkedFixed` re-runs `verifyStealContribution`, which is a full hidden-transfer verification (roughly 60 composed bit ORs plus openings, several hundred scalar multiplications). This happens before the receipt or dispute binding hash and before its signature are checked.

**Exploit:** any peer, or any relay, can send unsigned garbage `{ body: <any schema-valid body>, sig: <64 bytes> }` receipts or disputes. Each one costs a full proof verification before it is rejected with `steal-receipt-binding`. This contradicts the stage rule "check signatures, context, shape … before expensive group work".

**Smallest fix:**

- Verify the fixed contribution once, when certifying `STEAL_FIXED`. Pass a branded `VerifiedFixedSteal`, or cache the result keyed by `contributionHash` plus `operationId`.
- In the receipt and dispute verifiers, run in this order: schema, then binding hash, then signature, then the DLEQ (dispute only).
- Keep the full re-check in `createStealReceipt`, which is local and not attacker-triggered.

### M2 (conditional): Canonical string encoding is not enforced for opening scalars and operation keys

**Where:** `steal-delivery.ts`, in `openingFromBytes` and `validateStealOperation`.

**Condition:** `key32Schema` and `decodeScalar`/`decodePoint` only check the decoded length and value. A 43-character base64url string carries 2 spare bits. `steal-source.ts` explicitly round-trips `toBase64Url(fromBase64Url(x)) === x`, which suggests `fromBase64Url` may accept nonzero trailing bits. If it does, both of the following apply.

**(a) The victim can sabotage the thief's later proofs.**

- The victim seals an opening whose blinding strings are noncanonical aliases of the correct scalars.
- The ciphertext length is unchanged. `openingFromBytes` compares only the decoded values, so the thief accepts it and signs a receipt.
- `openingFromBytes` returns those strings as `StealOpening.blindings`.
- If the thief's private state stores them, the thief's later `verifyHandOpening` fails its `encodeScalar(blinding) !== encodedBlinding` check. The thief is left with a certified receipt and a hand it cannot open.
- **Fix:** in `openingFromBytes`, reject any `s` where `encodeScalar(decodeScalar(s)) !== s`, or return bigints. Also require `canonicalEncode(canonicalDecode(bytes))` to equal `bytes`.

**(b) A noncanonical recipient key stalls the steal.**

- If `thief.encryptionKey` is a noncanonical alias, `openChecked` and `createStealDispute` compare it against `encodePoint(secret·G)` and fail.
- Neither a receipt nor a dispute is then possible, so the steal stalls.
- Genesis already enforces canonical keys. Still, apply the same `encodePoint(decodePoint(x)) === x` check in `validateStealOperation`, to the encryption key and all five commitments, so the pure API cannot be misused.

### L1: A thief can sign both a receipt and a dispute, and the verdicts are not typed

**Where:** `steal-delivery.ts`, in `verifyStealReceipt` and `verifyStealDispute`.

**Receipt and dispute together:**

- `verifyStealReceipt` does not decrypt, so a dishonest thief can sign a receipt for bad bytes and later publish a valid dispute.
- This cannot frame an honest victim. A valid dispute requires a DLEQ-authenticated shared point, and the verifier decrypts deterministically with it.
- The integration must still define precedence: whichever is certified first wins, and a dispute after `STEAL_RESULT` is ignored.

**Attributable verdicts:**

- `verifyStealDispute` checks the binding before the signature, so failures fall into two groups:
  - Unattributable: `steal-dispute-binding` and schema errors.
  - Thief-signed: `steal-dispute-proof`, `steal-good-delivery`.
- Only the signed group can support a `CHEAT_PROOF` against the thief.
- **Fix:** return a typed verdict rather than relying on error codes: `valid-dispute | false-complaint(signed) | unattributable`.
- A signed false complaint necessarily reveals the stolen type publicly. The thief could disclose that anyway, so this is acceptable, but document it.

### L2: `createStealContribution` reads caller records twice

**Where:** `createStealContribution` in `steal-delivery.ts`.

**Problem:** `verifyHandOpening` validates parsed copies of the counts and blindings. The function then reads `counts[resource]` and `blindings[resource]` again from the caller's objects.

- Getters or mutation between the two reads cannot produce an unsound proof, because `proveHiddenTransfer` re-checks every opening.
- They can, however, produce a confusing failure and bypass the canonical-blinding check.

**Fix:** parse `counts` and `blindings` once with `parseCanonical` and use those copies everywhere.

### Info: open design points

- **No proof of possession for encryption keys.**
  - A seat can register an encryption key it cannot open, for example `E_B + G`, which lets colluder B decrypt everything sealed to it. It could also register a random point.
  - This only harms that seat or its collusion partner, which could share the plaintext anyway. Its only effect is a stall, and the mismatch is detected only at recovery, where the game is voided.
  - A Schnorr proof of possession bound to `(ceremonyNonce, seat, publicKey)` at consent would reject garbage keys before the deck ceremony. It is optional.
- **Protocol version.** The format change fails closed against old clients, because their strict seat schema rejects `encryptionKey`. Bump `PROTOCOL_VERSION` before any public release, as you noted.
- **Retries must reuse persisted bytes.** Contributions are deterministic only if `proofSeed(...)` receives a deterministic context, meaning the operation ID with no timestamps. Otherwise a retry creates victim equivocation, which `STEAL_FIXED` resolves but which should not occur. Persist before sending, as the design requires.

## Q2. Can signed artifacts be moved?

- **Contribution:** bound through `operationId`, which covers genesis, epoch, anchor, beacon, both signing keys, the recipient key, commitments, total and index. It is also bound through the victim's signature over the body, which includes the proof, and through the proof context and `payloadHash`.
- **Receipt:** binds the `operationId`, fixed entry, contribution, payload and transfer hashes.
- **Dispute:** its DLEQ context binds the complete receipt binding, and its statement pins `E_thief` and the ephemeral point.

I found no transplant. The concern is test coverage: most rejection tests stop at the cheap `operationId` or binding comparison. The inner verifier is never shown rejecting on its own (see the test list below).

## Q3. Privacy and source derivation

- **Ciphertext length:** fixed, with a length check on both sides. A test covers all five types.
- **Seal ephemeral:** derived per `(operationId, transfer, plaintextHash)`, so it is never reused across payloads.
- **Derivation labels:** `transferBlind`, `sealEphemeral` and `proofRandomness` are distinct labels on the same seed. The seed from `proofSeed` differs from master-derived keys by domain.
- **Encryption key domain:** binding the ceremony nonce, seat and original signing key is correct. Recovery must use exactly that tuple.
- **Thief knowledge:** the thief learns every `t_r`, but not `s_r`, so the victim's residual blindings stay hidden.
- **Memory hygiene:** bigint secrets cannot be zeroed. That is acceptable, since memory cleanup is documented as best-effort.

## Q4. False complaints

An honest recipient only disputes when the same `openSealedWithSharedPoint` path that verifiers run fails. `createStealDispute` never uses the local `openSealed` result, so honest recipients cannot make an unauthenticated or false accusation. Equivalence between the two open paths depends on the canonical recipient key string (M2b).

## Q5. Missing focused tests

1. **Real wrong-branch soundness.**
   - The existing test "valid one-hot proof for the wrong resource" reuses the honest index proof under a changed statement, so it fails on the context hash alone.
   - Instead, hand-build a CDS proof for counts `[2,1,3]` and `idx = 2` that claims branch 0 (upper distance −1). Use honest `prepareSchnorrProof` plus the lower `prepareRangeProof`, and `simulateRangeProof` for the upper range at a pre-chosen challenge.
   - Compute the Fiat–Shamir challenge with `proofChallenge('cds-or', …)` and assert rejection.
   - Repeat for a zero-count type at its boundary (`[2,0,3]`, `idx = 2`, branch 1).
2. **Inner proof binding.** Victim re-signs the body with the changed `operationId`, for example a new epoch, but keeps the old proof. Assert `steal-transfer-proof`, not `steal-contribution-operation`.
3. **Forged receipt.** Correct receipt body signed by the victim key or a random key: expect `steal-receipt-signature`. A thief-signed receipt for a different contribution with the same entry: expect `steal-receipt-binding`.
4. **False-dispute core case.** Thief signs a dispute whose shared point is `x'·eph` for `x' ≠ x`, with a valid DLEQ for `x'·G` and a decryption that fails. Expect `steal-dispute-proof`. The current test only zeroes the response.
5. **Dispute replay.** Replay a valid dispute against the same contribution under another fixed entry. Expect a binding failure.
6. **Noncanonical encodings.** Test base64 aliases, if the codec accepts them, for opening blindings, the operation encryption key and commitments, and the sealed ephemeral.
7. **Cost ordering (after M1).** A garbage receipt or dispute must be rejected without calling `verifyHiddenTransfer`. Spy on it or count calls.
8. **Genesis.** A bot seat with a missing key, and a human and a bot sharing one key, both fail with `genesis-encryption-key`.

No large random batches are needed. Each case above targets one specific verifier branch.
