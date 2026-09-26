# Certified hidden-steal lifecycle review

I found one real privacy break and two liveness and performance problems. I found no way for a sender to choose the index, ciphertext binding, keys or parent commitment. I also found no way to move resources twice, reuse the beacon, or sign a second result.

## Findings

### H1 — A malicious victim can make an honest thief reveal the decryption key for an earlier sealed payload

**Where:** `verifyStealContribution` (`steal-delivery.ts`), `produceStealResponse` (`verified-session-driver.ts`), `createStealDispute` and `verifyStealDispute`.

The victim chooses `sealed.ephemeral` freely. The only check on it is `decodePoint(..., { nonIdentity: true })`. The transfer proof binds `payloadHash`, but nothing proves the victim knows the ephemeral scalar. The honest thief's driver disputes automatically whenever the opening fails. The dispute then publishes `K = x_T·R` for whatever `R` the victim chose.

`openSealedWithSharedPoint(sealed, recipientKey, sharedPoint, context)` needs only `K` plus public inputs. So publishing `K` decrypts any payload sealed to the thief under that same `R`.

**Trace (at least 3 seats):**

1. Steal #1: victim W, thief T. W seals with `R1`. The steal is fixed, T sends a receipt, and the result is certified. The log now holds `sealed1 = {R1, c1}` and the public context `{steal-seal-v1, opId1, transfer1}`.
2. Steal #2: victim V, thief T. V builds an honest transfer and proof. V sets `sealed = {ephemeral: R1, ciphertext: <random bytes of STEAL_OPENING_BYTES>}`. `proveHiddenTransfer` binds this payload hash, `verifyStealContribution` passes, and `steal-fixed` certifies.
3. On T's honest client, `createStealReceipt` decrypts garbage and fails with `steal-opening*`. `createStealDispute` then publishes `K = x_T·R1`, and the dispute is valid and gets certified.
4. Any peer runs `openSealedWithSharedPoint(sealed1, E_T, K, context1)`. This reveals W's stolen resource and T's transfer blindings from steal #1.

This attacks honest W and honest T, not just the dishonest party. V pays only a stalled steal, since exclusion does not exist yet.

The same problem gets much worse once escrow shares are sealed to `E_T` (§7). V could harvest shares one steal at a time. It also turns T into a repeatable static-DH oracle on points V chooses.

**Smallest fix:**

- Add a Schnorr proof of knowledge of the ephemeral scalar to the contribution body, for example `ephemeralProof`. Bind it to `{ steal-ephemeral-v1, operationId, transfer }`.
- Verify it in `verifyStealContribution` after the signature check and before the transfer proof. This needs `seal` to expose `r`, or a `sealWithProof` helper in `@cp2p/crypto`.
- A victim that knows `r` could already decrypt anything sealed under `R`, so revealing `K` then leaks nothing new.
- For defence in depth, the driver should refuse to dispute if `R` matches any earlier certified ephemeral addressed to this seat.
- Add a regression test: steal #2 reuses steal #1's ephemeral and is rejected at `steal-fixed`.

### M1 — Every 2 s pulse repeats full transfer-proof verification on the serialized queue

**Where:** `ReplicatedLog.prepareSteal`, `prepareStealContribution` and `prepareStealResponse`.

`pulse()` calls `offerAvailableInput(true)`, which calls `prepareSteal(true)`. Retransmit mode skips the `sentStealStage` guard. So every pulse reloads the stored record and verifies it again:

- **Victim, before the fixed entry:** `contributionRecord` → `verifyStealContribution` does one full proof verification.
- **Thief, after the fixed entry:** `fixedSteal()` → `verifyStealContribution`, then `responseRecord` → `verifyStealReceipt` → `verifyStealContribution`. That is two full proof verifications.

Your own Node figures put each verification at about 0.5–0.9 s. So while waiting on an offline peer, a node spends roughly 50–90% of every 2 s on the replica queue.

That queue is also where votes, proposals and heartbeats run. The queue caps are 8 messages per peer and 32 in total, and anything over is dropped silently. The 750 ms and 1 s consensus timeouts will escalate rounds. A stall that is legitimate by design, such as an unresponsive counterparty, becomes a liveness problem for every peer involved.

**Fix:** Keep the verified outgoing message per stage in memory, as `{ stage, bytes }`. Verify the stored record once, on the first load in each process. Rebroadcast the cached bytes on retransmit without calling the store or the verifiers.

### M2 — The certified fixed contribution is re-verified many times per entry

**Where:**

- `verifyStealReceipt` and `verifyStealDispute`, which call `verifyStealContribution`
- `recoverStealTransferOpening`, `openStealContribution` and `verifyStealResult` in `committedEntry`

When `fixed` comes from replayed `CryptoContext`, its proof was already checked when `steal-fixed` certified. Even so, one `STEAL_RESULT` on a node that owns the thief pays a full transfer verification in each of these places:

- the inbox (`rememberResponse`)
- `deriveCandidate`
- proposal validation
- certified validation
- the driver's `verifyStealResult`
- `openStealContribution`

The victim's owner pays once more in `recoverStealTransferOpening`. Restore pays all of this twice, because `P2PSession` replays privately and then `ReplicatedLog.restore` replays again. `rememberAccusation` and `SNAPSHOT_REQ` also replay the full prefix.

`verifyStealDispute` also runs the expensive contribution check before the cheap `openDisputed`. A dishonest thief can therefore force one full verification per distinct good-delivery dispute that passes DLEQ. Strikes bound this to 5 per peer.

**Fix:**

- Add internal variants that assume a certified `FixedSteal` and check only schema, binding, signature and DLEQ/opening. Use them in `verifyStealResult`, `StealInbox` and the driver.
- Keep the fully verifying exports for any `FixedSteal` that is not certified.
- In `verifyStealDispute`, call `openDisputed` before any contribution check.

### L1 — `validateStealState` does not bind a stored dispute to the fixed contribution

The replayed state is currently the only source, and snapshots are compared rather than installed, so this is not exploitable today. Still, a `StealState` with a dispute taken from another fixed entry passes validation. Compare `hash(dispute.body.binding)` against `receiptBody(fixed)` there, since Stage 10 may install snapshots.

### L2 — Minor inconsistencies

- In `validateNextEntry`, `verifyStealResult` reads `context.crypto?.steal`. `completeStealResult` uses the transition-validated `committedCrypto.steal`. They are equivalent today; use the validated copy in both places.
- `steal-replica.test.ts` passes `deckContributions: new MemoryStealDeliveryStore()`. It works through structural typing, but it looks unintended.

## Checked and found sound

1. **Substitution:** The operation is rebuilt from `beacon.fixed` together with genesis keys, `crypto.hands`, the victim's public total and the epoch. The index, keys and commitments never come from the sender. `STEAL_RESULT` is routed before `entryInput`, so `verifySystem` and `allowStub` cannot bypass it. `entryInput` also has a `steal-result-unverified` guard. `DICE_RESULT` or `beacon-fixed` cannot stand in for the steal.
2. **Stale, duplicate or conflicting responses:**
   - The receipt binds the operation ID, which includes the beacon-fixed anchor, plus the fixed entry's `seq` and `hash`.
   - `completeStealResult` requires exactly one engine effect, `hidden-resource-transfer` for count 1, and it passes accounting.
   - `consumeFixedBeacon` then clears both `steal` and `beacon.fixed`, so a replay fails with `steal-result-state`.
   - A certified dispute blocks the result. Receipt-then-dispute from a dishonest thief is resolved by certified ordering, as documented.
3. **Races, disposal and restart:**
   - Contributions, receipts and disputes are all deterministic in master, ceremony nonce, seat, signing key and operation ID or fixed entry. A lost `putIfAbsent` race therefore produces identical bytes.
   - The key is copied before any `await`, and `disposed` is checked after it.
   - The driver's fold is atomic, and the openings are checked after the fold.
   - Replay reconstructs the victim's opening from its derivation and the thief's from decryption.
4. **Blame:** An honest thief never signs a receipt for bad delivery. A dishonest thief cannot forge a dispute against an honest victim, because the DLEQ is sound. Strikes only follow messages that fail under the certified operation, and retries of an honest message are always valid. Everything except H1 is either self-harm (a knowing bad receipt halts only the thief's client) or a stall.
5. **Amplification:** The operation ID and fixed-entry gates run before any proof work. Signatures are checked before proofs. Each inbox slot holds one item. Strikes bound invalid-but-signed traffic. The remaining cost is the self-inflicted work in M1 and M2.

## Future work, not bugs in this change

- A certified dispute stalls the game permanently, because `beacon.fixed` and `cryptoPending()` block everything. This is the planned exclusion and recovery step.
- `operationFromBeacon` requires `fixed.operation.epoch === epoch`. A future membership change during a steal must re-anchor the operation rather than fail every transition.
- Escrow sealing to `E_i` would turn H1 into share exfiltration, so fix H1 before Step 7.
- Also still open, as you noted:
  - counterparty spending proofs
  - audit and reveal
  - real WebRTC and lobby
  - protocol versioning, including changes to the transfer-seed derivation that would break victim replay
  - the Chromium 300 ms target, which M2 makes harder to meet

## Test gaps worth adding

- Ephemeral reuse across two steals (H1).
- A dispute path through the live replica, including restore of a stored dispute.
- A spy test confirming that pulse retransmit does not call `verifyHiddenTransfer`.
- A count of transfer verifications per `STEAL_RESULT` commit.
