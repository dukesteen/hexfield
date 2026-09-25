# Stage 07 preflight review

**Scope.** This is a design review of the published doc at `53c33a2` and the seven proposed corrections. It is not a security certification. **Proven** means the defect follows from the text as written. **Test** means the question can only be settled by implementation evidence.

## Blocking issues

### B1. The steal-index range is too narrow for real hand sizes (proven; breaks completeness)

§4 sets κ = 6 because per-type counts are at most 24. The §5 index proof reuses κ for `idx − p_r` and `p_r + n_r − 1 − idx`, and those values are bounded by the **total** hand size, not the per-type count.

- The base bank is 19×5 = 95 cards. The 5–6 player bank is 24×5 = 120. Commodities push the total higher.
- **Attack:** a hoarding seat with 64 or more cards is robbed. An honest victim cannot build the true-branch proof, so the steal stalls. That becomes a takeover, and the takeover still cannot prove it. The game pauses permanently.
- **Fix:** use two widths, both derived from the manifest config:
  - `κ_type ≥ ⌈log2(maxPerType+1)⌉`
  - `κ_hand ≥ ⌈log2(maxHandTotal+1)⌉`, which is 7 for 5–6 player base and 8 with commodities.
- Soundness still depends on every committed `n_r` being a true small integer. That holds inductively only if every loss is range-proven or bounds-proven. Keep that invariant explicit.

### B2. The beacon participant set is evaluated too late (proven; gives a 1-bit bias)

§2 defines participants as "human seats not marked as abandoned." It also claims the outcome stays fixed after recovery. Both cannot be true unless the set is frozen.

- **Attack:** the Byzantine seat reveals last. It computes `R_k` from the other reveals, dislikes the result, and disappears.
  - If round k's participant set is evaluated after abandonment, its value is dropped and `R_k` changes.
  - It has chosen between two outcomes.
- **Fix:** the certified entry that binds round k to an operation also freezes the participant list for that round. A recovered seat's `x_k` is supplied from the recovered master. Round k is consumed once and is never rebound or reused, even if the operation is cancelled.

### B3. Honest seats must not reveal before a certified binding exists (spec gap; exploitable if pipelined)

Nothing in the doc forbids revealing `x_k` early, for example to prefetch the next roll.

- **Attack:** honest seats have pre-revealed `x_{k}`. The Byzantine player now knows `R_k` before choosing an action. It can play a knight so that round k becomes the steal index instead of the dice roll, or the reverse.
- **Fix:** an honest seat reveals `x_k` only after a certified entry binds `k → opId` (plus request type and frozen participant set). Persist "revealed k" before sending.

### B4. Steal delivery fails after application, and the fix needs certified fixation (proven for the published §5; partially fixed by correction 3)

The published §5 applies `T` first and disputes afterwards, with no rollback. If the opening is bad, the honest thief's commitment contains blindings it does not know, so it can never prove spends of that card. Correction 3's receipt fixes the ordering, but two problems remain:

- **"First contribution" is undefined under equivocation.** The victim can sign two distinct contributions for the same opId: the same type but different `t` or ciphertext, sent to different peers. Validators cannot agree on which was first.
- **Binding the receipt to the parent hash hurts liveness.** Unrelated certified control entries (chat, heartbeats, `CHEAT_PROOF`, membership) advance the parent. That invalidates receipts and forces re-signing.
- **Fix: two-step certification.**
  1. `STEAL_FIXED { opId, contributionPayloadHash }` is certified once the public proofs verify. A second distinct signed payload for the same opId is equivocation evidence.
  2. `STEAL_RESULT` is certified once a receipt binds `opId + STEAL_FIXED entry hash + payload hash + ciphertext/T hashes`.
  - Only control entries may appear between the two. The engine pending blocks game commands.
  - The receipt binds the payload hash, excluding the signature, so a recovered bot can re-sign identical deterministic bytes after the old key is frozen.

### B5. Ceremony abort-and-retry grinding (proven if any randomness is visible before final consent)

Correction 1 puts "board commitments" in the manifest, and §7 restarts the ceremony on a bad share.

- **Attack:** the Byzantine human sees the board layout, starting seat, or any other random result during the ceremony. It then withholds consent or sends a bad share. The ceremony restarts and the outcome is rerolled.
- **Fix:**
  - No random outcome may be computable by anyone until the final genesis consent certificate exists. The board and starting seat come from post-genesis beacon rounds only.
  - Any abort, including one triggered by a false accusation, makes **all** seats resample their masters and nonces.
  - Otherwise the published share from the aborted run, plus the old shares held by people no longer in the manifest, weakens the threshold of honest dealers who reuse their master.

### B6. Two simultaneous departures deadlock t-of-t escrow (proven; liveness, not safety)

In a 6-human game (quorum 4), two humans X and Y can depart and the remaining four can still certify removal. But:

- Recovering X needs Y's share, or Y's recovered equivalent.
- Recovering Y needs X's share.
- Neither can ever be recovered.

**Fix:** specify the outcome deterministically: pause, then void by unanimous vote of the live humans. Do not describe takeover as available in this case. The same deadlock applies to bots whose escrow holders include both departed humans.

### B7. Escrow mismatch lets one player void a game on demand (proven; the cheat table overclaims)

A Byzantine seat in a game with 4 or more humans can escrow a master that does not match its keys. Later, at a moment of its choosing (for example right after seeing an unfavorable `R_k`), it withholds its reveal and leaves. Recovery then finds the mismatch and the game is voided.

It cannot change the outcome's value, but it controls whether the result stands. The table row "Withheld reveal → recovered, same outcome" is false in this case. Revise it to: "same outcome, or void if escrow mismatch; never a reroll."

This limitation is inherent to HKDF derivation. Disclose it rather than trying to fix it.

### B8. Reusing a deck ID reproduces the same shuffle (proven)

§3 derives `a_i`, `π_i` and `b_{i,j}` from master plus `deckId` alone.

- A reshuffle under the same deckId uses identical permutations and keys from every seat, so the deck comes back in the same order. Everyone who saw revealed cards knows the new layout.
- **Fix:** labels include a certified deck epoch or opId.

### B9. Sealing without AEAD is only safe where a public check exists (proven for the expansion text)

- **Covered cases:** steal openings are checked against `T`, and escrow shares are checked by Feldman.
- **Gap:** "seal card identities to the actor" (Spy, Master Merchant) has no stated integrity relation.
- **Fix, either of:**
  - Seal together with a DLEQ tying the identity to the lock layer.
  - Use AEAD with ciphertext-bound disputes.
- **In every case:**
  - Reject an identity ephemeral key or identity `E_i`.
  - Derive the ephemeral scalar from `master + opId + recipient + plaintext hash`, so the keystream is never reused if an operation is re-sealed.
  - Reject noncanonical scalars inside decrypted plaintext.

### B10. The threat model overclaims confidentiality (proven; doc-level)

"Unless all other players collude" does not hold in these cases:

- A bot host sees the hands of all its bots.
- The thief and victim each learn transfer contents, including each other's blinding components.
- Recoverers see the recovered seat's hand.
- A recovery exposes the departed seat's shares of every other seat, including bots.
- With n = 1 there is no fairness at all. The single human holds every beacon chain and every deck layer, so it can precompute all future dice. It should be labeled as equivalent to `LocalRandomSource`.

Also state the cascade invariant explicitly. The quorum table already keeps at least 3 original humans live, and at 3 or more no single live human can hold every share of another live seat. Enforce it anyway: reject a recovery that would leave fewer than 3 live original humans, and test it.

## Assessment of the corrections

### 1. Ceremony binding

Correct, and it removes the circularity. Remaining gaps:

- **Nonce freshness:** every human contributes to the ceremony nonce, or verifies that its own contribution is included in `ceremonyId`. See also B5 on restarts.
- **Proof of possession:** Schnorr PoP for `masterPub` and `E_i`, bound to `ceremonyId`. Reject duplicate or identity keys across seats and roles.
- **Manifest completeness:** the manifest carries the protocol version and every parameter: κ values, λ, L, deck lists and card tables, hash-to-group DSTs, bank sizes, modules, quorum table, escrow eligibility, bot→host map, and Shamir x-coordinates (distinct and nonzero). Otherwise a downgrade is possible.
- **Typed signatures:** each signature carries a type tag (consent, contribution, receipt, vote, certificate), so bytes signed in one role never verify in another.
- **Transcript root:** a Merkle tree with domain-separated leaf and node hashes, length-prefixed canonical leaves, and no duplicates.
- **Long-lived operations:** bind to `opId = H(certified request entry)` plus the full statement hash, not the moving parent (see B4). Keep parent binding for commands.

### 2. Crash and idempotency — essential requirements

1. **Master first.** The master and signing keys are durable before `masterPub` or the manifest signature leaves the device. Everything else must be re-derivable from master plus certified log: dealt identities, received openings (by re-decrypting ciphertext in the log), and escrow shares from the genesis ciphertexts. Losing the master is treated as departure.
2. **One slot, one payload.** Keep a write-ahead outbound log keyed by `(genesisDigest, epoch, opId, kind, ordinal)`, storing the payload hash and bytes. It is committed with strict IndexedDB durability before signing. After a restart, resend exactly those bytes. Never sign a second, different payload for a slot.
3. **Determinism.** Every nonce, blinding, permutation, ephemeral key and proof-randomness value is a pure function of master and the exact bytes of the full statement. Regeneration after a crash is then byte-identical, which gives a second line of defense against equivocation.
4. **Single writer.** Hold a per-seat Web Lock across tabs and devices.
5. **No rollback.** Refuse to restore a snapshot older than the last persisted outbound record. Use a monotonic counter.
6. **Pure state.** Engine state and CryptoContext are a pure fold over certified history. Snapshots store both hashes and are replay-verified.
7. **Deduplication.** Deduplicate inbound messages by `(opId, sender, kind, payloadHash)`. Conflicting payloads for the same slot become equivocation evidence.
8. **Coordinator restart.** The coordinator rebuilds outstanding operations by scanning the certified log. It holds no authoritative in-memory state.
9. **Private failures.** Private-state inconsistency fails closed: stop voting and signing for that seat, emit a diagnostic, never fork, then re-derive from master plus log.

### 3. Steal receipt

With B4's certified fixation this meets proof-before-application. The public proofs cover everything publicly checkable. The receipt is issued by the only party that can check the opening, and the party that is harmed if it's wrong. Neither reveals the card.

How to describe the behaviors:

- **Voluntary bad ACK:** "A receipt is the thief's binding acceptance. Any later inability to open is self-inflicted. It is handled as the thief refusing or timing out on future proof obligations (discards, monopoly reveals, spends outside bounds), and it is never grounds for accusing the victim."
  - A Byzantine thief can use this to create a future stall. That adds no power beyond plain refusal.
  - If one human hosts both endpoints, it is a no-op, because the host knows `t`.
- **Selective refusal:** "Refusal stalls with a fixed outcome. The thief has already learned `r*`, and refusing neither undoes that nor changes `T`, `idx` or the card."
- **Valid dispute:** blocks `STEAL_FIXED → STEAL_RESULT`. Specify whether the victim may reissue **only the ciphertext** for the same `T`; I recommend yes. With derived `t`, recovery of the victim can always produce the opening. If the victim used underived `t`, recovery fails and the game is void.
- **Invalid dispute:** rejected and turned into a `CHEAT_PROOF`. The dispute DLEQ must bind opId, the ephemeral key and the ciphertext hash.
- **Membership changes:**
  - `E_thief` must survive takeover. It is derived from the recovered master and must not be rotated, even though the signing keys are.
  - A contribution or receipt signed by a key that is later frozen is valid only if it was referenced by a certified entry before the freeze. Otherwise the recovered bot regenerates and re-signs the same payload.

### 4. Bot escrow

- **Confidentiality:** consistent. No single non-host human learns the bot's secret, and the host already knows it.
- **Liveness:** weaker than ordering. One withholding holder stalls, which is acceptable under "agreement over availability."
- **Requirements:**
  - The bot master is sampled independently, never derived from the host's master.
  - Escrow is absent whenever fewer than 4 humans start. With 2 humans the threshold would be 1.
  - Shares are released to all live original humans rather than only the new host. The recovery-consistency check needs the master, and a sole recoverer could falsely claim a mismatch (voiding the game) or falsely claim consistency.
- **Disclosure:** the last releaser learns the result first. That asymmetry is inherent.

### 5. Shuffle proof

The equivalence holds exactly when `u ≠ 0`.

- **Scalar checks:**
  - Reject `u = 0` and `u ≥ ℓ`. Do not rely on library behavior for `inv(0)` (test noble).
  - Reject `r = 0`.
  - Require `A` and every `out_j` to be non-identity.
- **Permutations:** validate `ρ` and `τ` as bijections of `[0, m)` with the exact length. Test with non-involutive permutations so a direction bug in `τ⁻¹` cannot hide.
- **Comparisons:** compare canonical encodings of computed points. Hash exactly those bytes.
- **Big win:** both openings let the verifier recompute `R` and `Y`. Use challenge form: the proof is `(c, responses)`, and the verifier recomputes every `R_i` and `Y_i` and checks `H(statement, R, Y) == c`. That is about 4 KB per proof instead of about 57 KB, which removes the 256 KiB concern entirely.
- **Precomputation:** all bases are fixed per pass: `in` for bit 0, `out` and `A` for bit 1. Key the caches by `(opId, pass)`.
- **Nonce reuse:** reusing `(r, ρ)` under both bits reveals `a = u·r` and `π = τ∘ρ`. The randomness must be derived from a superset of the challenge's statement bytes.
- **Margin:** λ = 64 is the entire margin against grinding. Record that in DECISIONS.md.

### 6. Fiat-Shamir and CDS

The general rules are sound. For the hidden steal:

- **One transcript.** Include the full statement: every `T_r`, `C_r` and `P_r`, `idx`, `κ_hand`, opId and `ceremonyId`. Hashing only the commitments is the Frozen Heart forgery.
- **One-hot branch.** Branch `r` must contain knowledge-of-`t` openings for `T_r − G = t_r·H` and for `T_{r'} = t_{r'}·H` for every `r' ≠ r`. That is what "same one-hot branch" means.
  - The separate bit-OR one-hot proof is then redundant. Drop it, or include it in the same transcript so it cannot be spliced from another `T`.
- **Challenges.** Every sub-proof in a branch shares that branch's `c_b`. Each nested bit-OR splits `c_b = c_b0 + c_b1`. The verifier checks `Σ c_b = c mod ℓ` and rejects noncanonical scalars.
- **Simulated branches.**
  - Bit commitments in simulated branches must still satisfy the weighted-sum equation the verifier checks. Pick κ−1 random bit commitments and solve for the last one using the inverse of its weight `2^{κ−1}`.
  - Alternatively, prove the sum relation as a Schnorr proof on the blinding difference.
  - Simulated sub-proofs take the branch challenge as input.
- **Nonces.** Derive them per `(branch, subproof, bit)`, and never share them across branches.
- **Card points.** They must come from hash-to-group. If any implementation uses `c·G`, then `Z = c·B` identifies the card immediately. Add a known-answer test.

### 7. Audit

Agreed. Report `{ movesVerified, auditStatus: 'complete' | 'partial', missingSeats }`, where `ok` is true only when the audit is complete. The acceptance criterion "1,000 honest games → ok" must exclude games that end with withheld secrets. The fairness indicator should read "moves verified," not "fair."

## Needs implementation tests (not proven defects)

- Timing budgets for the shuffle (6×25) and the steal (8 types, κ_hand = 8). The steal is roughly 300 sigma sub-proofs, so 300 ms in JS is uncertain. Do not claim either budget without benchmarks.
- noble's behavior on `inv(0)`, identity encodings and noncanonical encodings.
- Actual IndexedDB durability under crash injection.
- Statistical tests of the CDS simulator: branch indistinguishability across all 8 positions of `r*`.
- A completeness test at maximum hand size.
- Equivocation detection end-to-end.
- Double-departure deadlock handling.
- Rejection of a recovery that would leave fewer than 3 live humans.
- Ceremony restart resampling.

## Corrected contract (short)

1. **Ceremony.**
   - `ceremonyId = H(domain, manifest)`, with the manifest carrying all parameters and each human's nonce contribution.
   - PoP for every public key. Typed signatures.
   - No randomness is observable before the genesis consent certificate.
   - Any abort resamples every seat.
2. **State.**
   - Engine state and CryptoContext are a pure fold over certified history.
   - Every signed contribution binds opId (the certified request hash) plus the full statement hash, so `CHEAT_PROOF` validity is independent of context.
3. **Beacon.** Round k is bound, with its participant set frozen, by a certified entry before any honest reveal. Rounds are single-use. Recovered values fill in for withheld ones.
4. **Deck.**
   - Labels include a deck epoch.
   - Every scalar and point is non-identity.
   - Permutations are validated.
   - The shuffle proof uses challenge form.
5. **Hands.** Separate `κ_type` and `κ_hand`, both taken from config. Every loss is range-proven or bounds-proven.
6. **Steal.** `STEAL_FIXED` (public proofs) → thief receipt → `STEAL_RESULT`. Disputes are resolved before the result. Receipts bind payload hashes. Enc keys survive takeover.
7. **Escrow.**
   - t-of-t over original humans, excluding the host for bots, and only when 4 or more humans start.
   - Release only against a freeze certificate, to all live humans.
   - Double departure means pause, then void.
   - A mismatch voids the game, which is disclosed as a single-Byzantine power.
8. **Crash safety.** Master durable first. Write-ahead, one payload per slot. Deterministic derivation. Single writer. No snapshot rollback.
9. **Audit.** Report "moves verified" separately from a complete versus partial omniscient audit.
10. **Disclosures.** Bot hosts, steal endpoints, recovery exposure and cascade, n = 1 has no fairness, and the rage-quit oracle: the last revealer always sees the outcome first and can pause or void, but never reroll.
