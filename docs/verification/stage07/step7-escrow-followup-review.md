# Escrow follow-up review: distribution fixes D1–D4 and `escrow-dispute.ts`

## Verdict

The four fixes hold against current source. The new dispute helper keeps its main disclosure guarantee: no shared point is computed or published until the dealer signature, the full envelope binding and the sender's ephemeral-scalar proof all pass.

- Recipient DLEQ is oriented correctly and bound to the complete signed envelope.
- Acceptance and dispute share one plaintext/hash/Feldman validator.
- A good opening is never blamed on the dealer.

There is one real defect in the new code: a caller-supplied proof seed can leak the holder's encryption secret. There are also two policy gaps and several regressions that do not actually test the check they are named for.

## D1–D4 against source

**D1: holds; its regression does not isolate it.**

- `parseAndCheckEnvelope` now decodes every coefficient with `nonIdentity`.
- In `escrow-distribution.test.ts` ("rejects a signed degree-deficient Feldman polynomial"), the dealer re-signs changed `commitments` but keeps the old `sealed` and `ephemeralProof`.
- `escrowDeliveryContexts` binds `commitments` into the proof context. So if you delete the `nonIdentity` loop, the test still passes, because it fails at `escrow-ephemeral-proof`.
- Fix: build the deficient case properly.
  1. Take `[M, c1·G, 𝟙]`.
  2. Compute the share from the degree-1 polynomial `m + c1·x`.
  3. Hash it, then `sealWithEphemeralProof` it with contexts built from the deficient body, and re-sign.
  4. Assert a coefficient-specific code. Right now the catch-all returns `escrow-envelope`, so a dedicated `escrow-coefficient` code would make the assertion meaningful.
- Without the fix, `acceptEscrowShare` would accept this share.

**D2: holds.**

- `checkedContext` runs `validateGenesisMasters`.
- `matchesMaster` gates creation, envelope checks, acceptance and `checkAck`.
- The 78n/78n test is discriminating.
- Still missing: a direct test that `acceptEscrowShare` and `verifyEscrowShareEphemeralProof` fail with `genesis-masters` on a draft that has no `masters`.

**D3: the check exists; its regression does not reach it.**

- `${masterPub}=` is 44 characters, so `key32Schema`'s `v.length(43)` rejects it before the re-encode comparison ever runs.
- The meaningful case is a 43-character string whose last character differs only in the 2 padding bits, for example the last character changed from `A` to `B`.
- Add that as a codec known-answer test (`fromBase64Url` must throw) and as a `validateGenesisMasters` case.
- I cannot verify the "`fromBase64Url` is already canonical" claim, because the codec source was not provided.

**D4: holds.**

- The structural pass in `validateGenesisEscrow` covers holder order, dealer, threshold, length, `commitments[0]` and polynomial hash. It runs before `prepareEscrowVerifier` and before any signature, Schnorr or ACK work.
- Full genesis parsing now happens a constant number of times (about 6), no longer once per delivery.
- The mixed-polynomial-plus-forged-signature case discriminates on error code.
- The detached-context test also discriminates, because `checkedVerifiedGenesis` and `validateGenesisMasters` both copy through `parseCanonical`.

## `escrow-dispute.ts`

### Verified properties

- **Create path:** `checkedDelivery` → `parseAndCheckEnvelope` checks, in order:
  1. manifest master
  2. roster and binding
  3. dealer signature
  4. exact ciphertext length
  5. nonidentity points
  6. `verifySealedEphemeralProof`

  After that it checks the holder seat, the recipient secret (a zero or noncanonical scalar is rejected or caught) and the signing key. Only then is `K = x·R` computed.

- **Good openings stay private:** if `openDisputed(...).ok` is true, the helper returns `escrow-good-delivery` and discloses nothing.
- **Verify path:**
  - It checks the holder signature and `ceremonyId`, then the envelope under `signed.body.dealerSeat`, then `holderSeat` and `envelopeHash` equality.
  - The DLEQ statement is `(G, E_holder, R, K)` with context `binding(envelope)`. That context carries `envelopeHash`, which covers the whole signed envelope including the dealer signature.
  - It then requires that the opening fails.
- **Copied `R`:**
  - Copying `R = E_2` is rejected at `escrow-ephemeral-proof`, which blocks the `x₁·E₂` DH-oracle trace.
  - Copying `R` together with its proof from another envelope also fails, because the proof transcript binds the recipient, the sealed bytes and the seal context.
- **No false dealer blame:**
  - `K` is DLEQ-authenticated, so `openSealedWithSharedPoint` yields exactly the bytes that `openSealed` yields for the holder.
  - `recipient` equals `encodePoint(xG)`, which was checked.
  - Both paths call `readEscrowShareOpening`.
  - So a delivery accepted by the holder can never be publicly judged bad, and the reverse is also true.

### N1. Caller-supplied `proofSeed` can leak the holder's encryption secret (medium)

- **Where:** `createEscrowShareDispute` takes `input.proofSeed` with no constraints and passes it straight to `proveDleq`.
- **Why it matters:** the DLEQ nonce is `proofNonce(seed, 'dleq', context, statement)`. If the seed is public or predictable, anyone holding the published complaint can compute the nonce `k` and then `x = (s − k)/c`. The test's constant `fill(96)` shows the API permits this.
- **What `x` exposes:** `E_holder` for the whole attempt. That includes every other dealer's share sealed to that holder in this ceremony attempt, not just the disputed one.
- **Minimal fix:** remove the parameter and derive the seed privately, then clear it:
  ```ts
  const seed = deriveBytes(
    scalarToBytes(input.recipientEncryptionSecret),
    DERIVATION_LABELS.proofRandomness,
    { ...context, sharedPoint, role: 'escrow-dispute' },
    32,
  );
  try {
    proof = proveDleq(
      statement(envelope, sharedPoint),
      input.recipientEncryptionSecret,
      seed,
      context,
    );
  } finally {
    seed.fill(0);
  }
  ```
  Alternatively, require a master-derived source analogous to `StealSecretSource.proofSeed('dispute', …)`.
- **Missing regression:** two calls produce identical proofs, and the API accepts no external seed.

### N2. Any authenticated disclosure must retire every dealer in the attempt (policy for C1)

- **A valid complaint discloses `K`:**
  - The complaint's `K` makes that one holder's share public, so it is not only a proof of dealer fault.
  - From then on, the remaining `t−1` holders can reconstruct that dealer's master without the complainer.
- **N1 widens this:** with the seed flaw, the exposure extends to every dealer's share sent to that holder.
- **Does not apply here:** a false complaint cannot reach publication through `createEscrowShareDispute`. A hand-built one would still publish a good share.
- **Rule for C1:** retirement on abort must cover all dealing masters of the attempt, not only the accused dealer. It should also apply when a verified-false complaint has been broadcast.

### N3. Outcome typing and the raw-genesis reads in `verifyEscrowShareDispute` (low)

- **Error codes stand in for outcomes:** a verified false complaint returns the ordinary failure code `escrow-good-delivery`. It is correctly reachable only after the holder signature and DLEQ pass, so it is sound evidence against the holder. But nothing in the types separates it from `escrow-dispute-proof` or `escrow-signature`, which are not accusations.
  - Fix: return a typed result, `{ kind: 'dealer-fault' } | { kind: 'false-complaint', holderSeat } | invalid`. A caller must never accuse on the catch-all path.
- **Raw genesis is read outside the checked context:** `genesis.seats.find` (which picks the key the signature is checked against) and `deckCeremonyId(genesis)` both read the caller's object directly.
  - Build one checked context first, the same way `prepareEscrowVerifier` does, and take the holder key and `ceremonyId` from it.
  - This matches the D4 detached-context claim.

## Scope check

- Nothing here authorizes release or recovery or activates a voter. The dispute helper is pure; networking and the abort transition remain with the ceremony integration.
- `createEscrowShareEnvelopes` still takes caller `entropy`. `DERIVATION_LABELS` has no escrow-entropy label, which is consistent with C1/C2 still being separate work.
- Note for C2: the same seed also derives the seal ephemerals through `sealEphemeral`. Leaking it therefore decrypts every share, which is worse than the coefficient-only leak described earlier.
- Confirm that `index.ts` does not expose `createEscrowShareEnvelopes` or `createEscrowShareDispute` to app or worker entry points until C1/C2 land. That file was not provided.
- C3–C6 are unchanged: `verifyRevealedMaster` still uses a catch-all `master-reveal` and checks only the epoch-0 tip.

## Missing meaningful regressions

1. **Dealer signature before disclosure.** `createEscrowShareDispute` on a bad-share envelope with a zeroed or forged dealer signature must fail with `escrow-signature` and produce no complaint. `verifyEscrowShareDispute` must also reject a valid holder complaint paired with a forged-signature envelope. This is the headline guarantee and nothing tests it directly.
2. **Complaint identity and binding.**
   - A complaint signed by holder 2 but claiming `holderSeat: 1` must fail with `escrow-dispute-signature`.
   - A holder-1-signed complaint with `dealerSeat` changed to 2 against dealer 0's envelope must be rejected.
   - A complaint bound to the alternate envelope of the same dealer and holder must fail on `envelopeHash`.
3. **Copied `R` plus proof** from dealer 1's envelope to the same holder must be rejected. The current test copies only `R`.
4. **Context isolation.** The `ceremonyNonce` case fails at the first `ceremonyId` check. Add a case with an unchanged ceremony where the envelope's holder `encryptionKey` binding differs.
5. **Discriminating tests for D1, D3 and N1**, as specified above.
6. **Aggregate coverage from the first review, still absent:**
   - a non-empty escrow list with fewer than four humans is rejected;
   - `validateGenesis` rejects one corrupted ACK inside an otherwise complete transcript;
   - a four-human-plus-bot genesis with escrow and decks is accepted end-to-end.
