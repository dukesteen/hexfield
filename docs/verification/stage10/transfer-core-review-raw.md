# Hexfield v4 seat-transfer review

## Proven bugs

### 1. High: a stale recovery root lets an old, replaced human key reclaim the seat

**Where:** `transfer-membership.ts`, in `expectedReplacements` (the `returnRoots.find` lookup) and in `advanceTransferRecovery`.

**Cause:** Return roots are never retired. The lookup matches any root whose `departedSeat` is the seat and whose `activation` is not null. Nothing ties `statement.recovery` to the latest recovery for that seat, or to anything after the last human activation. `currentController.activatedAt` is never compared with `root.activation`.

**Trace:**
1. Seat 2 is human with key `K1`. The `K1` device is stolen. Recovery `R1` is authorized and activated, so seat 2 becomes a bot hosted by H. Root `R1` records `lastHumanGameKey = K1`.
2. The real owner returns through the unanimous `humanApprovals` path with new key `K2`. Seat 2 is human again, and root `R1` stays in `returnRoots`.
3. `K2` later times out. Recovery `R2` runs and seat 2 is a bot again. Root `R2` records `K2`.
4. The thief builds a return authorization with a fresh anchor (after the `R2` barrier) and `recovery = {R1.finalAuthorization, R1.activation}`, signed by `K1` under `TRANSFER_RETURN_INTENT_DOMAIN`. The checks pass:
   - `controller.kind === 'bot'`
   - the root is found
   - `eligible[0]` is seat 2, because `R1.affectedSeats[0]` is the departed seat
   - `signed(..., root.lastHumanGameKey = K1)` succeeds
5. The quorum certifies an honest-looking authorization. Activation gives seat 2 to the `K1` holder.

The intent barrier does not help, because `K1` signs a fresh statement.

**Fix:** When a return activates, and whenever a newer root for the same `departedSeat` is created, remove or mark the old root consumed. Then require the root to be the latest unconsumed root for that seat.

### 2. Medium: activation ignores the signed `validUntilSeq`

**Where:** `transfer-membership.ts`, `activate`.

**Cause:** `validUntilSeq` is only checked in `authorize`, against the authorization entry's own sequence number. An authorization certified at seq 50 with `validUntilSeq = 110` can be activated at seq 5000. The owner's signed expiry therefore limits only inclusion, not the handover.

**Consequence:** A pending authorization can wait indefinitely, and it blocks recovery for that whole time. A destination device compromised long after the owner's consent window can still attest a fresh `checkDigest`. A quorum that does not include the owner can then certify the activation.

If expiry is meant to cover the handover, add `entry.seq <= approved.validUntilSeq` to activation. If it is only meant to cover inclusion, document that the owner's intent has no end date after authorization.

### 3. Low: `transferEncryptionKey` freshness is not tracked across transfers

**Where:** `transfer-membership.ts`, `validateFreshKeys`.

**Cause:** The `reserved` set contains `usedPublicKeys`, device peers, genesis `encryptionKey`s and masters. It never contains earlier `statement.destination.transferEncryptionKey` values, including those of cancelled authorizations. A later authorization can reuse a previous destination's encryption point, even though the error text says the key "must be fresh".

**Impact:** Private material could be encrypted to a key a past device controls. Exploiting this needs the destination to sign, so the impact is limited. Still, the stated invariant is not enforced.

**Fix:** Add the encryption keys from all `transfer.authorizations` to `reserved`.

### 4. Low: the master is copied into an unwipeable string

**Where:** `transfer-material.ts`, `validateMaterial`.

**Cause:** `toBase64Url(seat.master)` creates a string copy of every master secret. The function explicitly skips a canonical round-trip to avoid leaving encoded secret copies, but this call does the same thing, and the "owns buffers to wipe" contract cannot cover a string.

**Fix:** Make `verifyRevealedMaster` accept bytes.

## Depends on omitted code (recovery types and validator)

### 5. Recovery amendments and non-authorize/activate recovery kinds

**Where:** `transfer-membership.ts`, `advanceTransferRecovery`.

- **Amendments:** The `previous !== null` branch only updates `finalAuthorization`. It keeps the root's `departedSeat`, `lastHumanGameKey`, `affectedSeats` and the route that was nulled at root time. If an amendment can change `departedSeat` or the replacement set:
  - **Different departed seat:** The wrong seat's route stays null. That still-active human then fails `validateTransferOwnedMaterial` and cannot do a `'live'` transfer. The actually recovered seat has no root, so it can never return.
  - **Different replacement set:** A stale `affectedSeats` lets a return take bots that the final amendment left with host H. The `hostSeat` filter only guards this partly.
  
  Fix: re-derive these fields from the amended statement, or assert they are unchanged.
- **Other recovery kinds:** Any recovery change other than `recovery-authorize` or `recovery-activate` (for example a cancel) hits the final `failure(...)`. That would make such an entry invalid in `log.ts`. Also, the route is nulled when recovery is authorized, not when it activates. If a recovery can end without activating, the human who stays active keeps a null route permanently.
- **Unverified games:** `log.ts` now returns a failure for every recovery entry when `context.transfer` is missing. That is correct only if recovery is restricted to verified games.

## Checked and found sound

- **Intent barrier:** Anchor, barrier and cancel races hold. Any certified membership entry kills older intents, and cancel and activate are mutually exclusive through the exact parent and exact `pending` match.
- **Key reservation:** Game and bot keys are reserved at authorization and stay reserved after a cancel. Device keys cannot alias game keys.
- **Hosted set at activation:** The roster and old-key recheck hold, because a pending transfer blocks both recovery and other transfers.
- **Retirement:** The seat-and-key voter match in `replicated-log.ts`, together with `restoreRetiredSafety`, correctly retires `K1` after a live transfer.
