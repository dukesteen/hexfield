# Stage 07 review: master commitments and escrow distribution

## Verdict

I found no break in the checks this slice claims to perform, based on the source provided. The immutable roster, the all-other-humans threshold, dealer and holder order, exactly one ACK per holder, one polynomial per dealer, and the rule that both consent and admission must run escrow validation all hold. Envelope authentication happens before the ciphertext is opened, and ACKs cannot be moved to another envelope.

There are four small defects in this slice. There are also several integration requirements that must be met before recovery is enabled. The most important is manifest authentication before dealing (C1), which is not optional hardening.

## Confirmed correct

- **Roster** (`escrow-roster.ts`): holders are the original humans only, minus the dealer or the bot's host. The Feldman index is `seat+1` and the threshold is the holder count. Rosters are derived only from genesis, so bots never add holders.
- **Mandatory checks**:
  - `signVerifiedGenesis` runs masters, then escrow, then decks, and signs only after all three pass.
  - `validateGenesis` verifies signatures, then masters, then escrow, and only then calls `verifyCommitments`. A callback returning success cannot bypass a missing transcript, and the test confirms the callback is never reached.
- **Envelope checks** (`parseAndCheckEnvelope`): it checks the roster and binding fields, then the dealer signature, then the canonical ciphertext of exact length, then the points, and only then the ephemeral Schnorr proof. The proof transcript binds the sealed bytes, the recipient, dealer, holder, index, threshold, masterPub, commitments and shareHash.
  - Copying `R` from another sealed payload, whether another dealer's or another ceremony's, fails because the copier cannot know `r`.
  - A dealer that reuses its own `R` only exposes data it already knows.
- **Holder acceptance order**: recipient and signing keys are checked first, then the ciphertext is opened, the plaintext hash is compared to the signed `shareHash`, the payload fields are compared, and the Feldman equation is checked. Only then is the ACK signed.
- **ACK binding**: the ACK covers `ceremonyId`, dealer, holder, index, masterPub, shareHash and the hash of the whole signed envelope. That rules out moving an ACK to another dealer, holder, ciphertext or polynomial.
- **Full-threshold Feldman with `F_0 = masterPub`** means the shares can only interpolate to the dlog of masterPub. A dealer cannot pass off a key it does not know.
- **`verifyRevealedMaster`** rejects zero and out-of-field scalars. It checks masterPub, the encryption key (derived in the original signing-identity domain), the epoch-0 beacon tip, and every shuffle and lock key of every original deck. The ledger must match `genesisDigest` and the committed `finalStateHash`.

## Demonstrated defects in this slice

### D1. Degree-deficient Feldman polynomials are accepted (low)

- **Where:** `parseAndCheckEnvelope` calls `decodePoint(commitment)` without `nonIdentity`, and `verifyFeldmanShare` also accepts identity points.
- **Trace:** A dealer publishes `commitments = [masterPub, 𝟙, 𝟙]`. Every share then equals `master`, every holder's check passes, and every holder signs an ACK. Each holder now holds the dealer's full master, even though genesis records a 3-of-3 escrow.
- **Impact:** Mostly self-harm, since a dealer can always leak its own master. However, genesis then misstates the threshold that the lobby discloses, and holders are given the dealer's encryption key without asking for it.
- **Fix:** Require every `F_k` for `k ≥ 1` to be a non-identity point. An honest `deriveScalar` never produces zero, so honest dealers are unaffected. Rejecting only the top coefficient is enough to enforce the exact degree; rejecting all of them is simpler.

### D2. Per-envelope helpers trust a caller-supplied `expectedMasterPub` (low–medium, API footgun)

- **Where:** `createEscrowShareEnvelopes`, `verifyEscrowShareEphemeralProof` and `acceptEscrowShare` compare against the caller's value and never against `genesis.commitments.masters[dealerSeat]`.
- **Evidence:** The test helper `deliveryFor` passes `expectedMasterPub: envelope.body.masterPub`, which is a value the dealer chose. A holder coordinator written the same way would sign an ACK for a share of some other secret.
- **Impact:** `validateGenesisEscrow` catches the mismatch when genesis is assembled, so the practical cost is a stall. But the holder may have persisted a useless share.
- **Related gap:** None of these helpers call `validateGenesisMasters`. A draft with no masters produces `deckCeremonyId(... masters: [])`, and the helpers would deal and accept under it.
- **Fix:** In the three helpers:
  1. Run `validateGenesisMasters(genesis)`.
  2. Take the dealer's masterPub from its output.
  3. Reject any caller-supplied value that differs, or remove the parameter.

### D3. Master distinctness compares encoded strings without enforcing canonical base64url (low, depends on `fromBase64Url` leniency)

- **Where:** `validateGenesisMasters` builds a `Set` of `masterPub` strings. `key32Schema` checks only that the value decodes to 32 bytes.
- **Contrast:** `validateGenesisEncryption` does enforce `encodePoint(decodePoint(k)) === k`.
- **Trace:** If `fromBase64Url` ignores the two trailing pad bits, a copied master with altered trailing bits passes as "independent". I don't see further escalation, because every later comparison is against a canonical string, but it contradicts the stated check.
- **Fix:** Apply the same re-encode equality check. Better still, make `key32Schema` and `signature64Schema` canonical everywhere. This also removes the risk that a relayer re-encodes `sig`, which changes `envelopeHash` and breaks the ACKs.

### D4. Work amplification and work order in aggregate verification (low)

- **Where:** For each of up to 30 deliveries, `validateGenesisEscrow` calls:
  - `verifyEscrowShareEphemeralProof` and `verifyEscrowShareAck`;
  - each of which re-runs `checkedVerifiedGenesis` (a full canonical re-encode and parse of genesis, which contains the transcript itself), `validateGenesisEncryption`, `deriveEscrowRosters` (with `parsePeerId` for every seat) and `deckCeremonyId`.

  That is about 120 full genesis parses. Cheap cross-envelope checks (holder order, commitment equality) also run only after that envelope's signature and Schnorr verification.

- **Exposure:** At consent the draft has no signatures yet, so a hostile coordinator can make every honest signer do this work on a draft close to 256 KiB.
- **Fix:**
  1. Parse genesis, masters, rosters and `ceremonyId` once.
  2. Pass that checked context to internal helpers.
  3. Do a structural pass over all deliveries first: holder seats and order, identical `commitments` strings, `threshold`, `commitments[0]`.
  4. Only then verify signatures, Schnorr proofs and ACKs.

## Concerns conditional on unseen callers or future integration

### C1. Unauthenticated manifest lets an attacker obtain a dealer's full master (high, required before any online dealing)

`createEscrowShareEnvelopes` deals the real master to whatever roster and encryption keys appear in the `genesis` it is given.

**Trace:** A malicious coordinator shows dealer D a draft containing D's real masterPub, three attacker "humans", and attacker encryption keys. D seals all three shares to the attacker, who interpolates D's master. The honest ceremony then fails on a `ceremonyId` mismatch. If D does not discard that master and deals it again under the real manifest, D's master is compromised for the whole game.

**Required fix:**

- Before dealing, verify every human's signature over the frozen manifest `ceremonyId`, as §"Certified context" requires.
- Durably record `masterPub → ceremonyId`, and refuse to deal one master under a second ceremony.
- A disputed or aborted attempt must retire the master. The same rule applies to bot dealers.

### C2. Entropy lifecycle

The dealing entropy derives the coefficients `c_1…c_{t−1}`. If it leaks, anyone who also holds one share recovers the master (`master = s_j − Σ c_k j^k`), so the effective threshold drops to 1.

- Derive the entropy from the retained master using a dedicated label bound to `ceremonyId`. The registry currently has no `escrow-entropy` label. Do not store it separately.
- Zero it once genesis is certified.
- Drawing fresh entropy on a retry leaks nothing, because any `t−1` holders remain one equation short. But it produces conflicting ACK sets and a stall.

### C3. `verifyRevealedMaster` checks only the epoch-0 beacon tip

If a seat installed a `beacon-extension` tip that does not derive from its master, recovery passes this check, and the recovered bot then cannot reveal for the frozen operation. The result is a stall, where the policy calls for voiding the game.

**Fix:** Before activation, take the certified `BeaconState` and check that the derived chain for the current `chainEpoch` and `length` reproduces the current `tip` at `index`.

### C4. The key-consistency check does not cover the private-hand openings a recovered bot needs

Transfer blindings used as a steal victim are HKDF-derived and cannot be proven. The thief's openings arrive sealed and are acknowledged by the thief. A departed seat that used non-derived blindings, or acknowledged unusable openings, leaves a hand that cannot be opened, so the recovered controller cannot produce range or count proofs.

**Fix:** Recovery must reconstruct and open every committed hand vector, and void the game on failure, before the second (activation) certificate.

### C5. Failure classification needs to be explicit

The recovery flow must void the game only for encryption, beacon, shuffle or lock key mismatches after an authorized reconstruction that matches masterPub. It must not void for:

- `master-public-key` (a bad share or reconstruction bug);
- `master-deck-context` or `master-deck-pending`;
- the catch-all `master-reveal`.

Expose a typed result that separates "seat violation" from "input or context error", so a caller cannot void on a thrown exception.

### C6. Released shares must be re-verified at recovery

`recoverSecret` does not authenticate shares. Recovery must check each released share against the genesis envelope's `shareHash` and Feldman commitments before interpolating. A released share that fails is a holder fault, not a dealer violation.

## Missing meaningful tests

**Escrow validation**

- Identity or low-degree commitments `[M, 𝟙, …]` are rejected. This currently fails (D1).
- `acceptEscrowShare` rejects when the caller's `expectedMasterPub` differs from `genesis.commitments.masters`, and when the draft has no masters. This currently fails (D2).
- Two `masterPub` strings that decode to the same point are rejected, if `fromBase64Url` is lenient (D3).
- A non-empty escrow list with fewer than four humans is rejected.
- `validateGenesisEscrow` rejects a stub genesis that carries escrow.
- An ACK moved between the alternate and original envelopes of the same dealer and holder is rejected (envelope-hash binding).
- An ACK carried over from a different `ceremonyNonce` is rejected.
- A ciphertext that is canonical base64url but truncated is rejected.
- An ephemeral point plus proof copied from dealer 1's envelope into dealer 0's envelope to the same holder is rejected.

**Consent and admission**

- `validateGenesis` and `signVerifiedGenesis` fail with one corrupted ACK or envelope inside an otherwise complete four-human transcript. Current tests cover only a missing transcript.
- A complete signed genesis with at least four humans and a bot (escrow plus decks) is accepted end-to-end.

**Recovery path**

- Holders re-open their shares from the genesis ciphertexts, the shares are interpolated, and the result passes `verifyRevealedMaster`, for a human dealer and for a bot dealer.
- `master-deck-pending` is returned for an incomplete ledger.
- Keys are checked for a non-zero participant index and for more than one deck.
- A beacon-extension mismatch is detected once C3 is implemented.

**Entropy**

- All-zero entropy is rejected.
- Different entropy produces different commitments with an unchanged `F_0`.
- The caller's entropy buffer is not mutated.
