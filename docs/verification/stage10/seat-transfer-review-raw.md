# Seat-transfer design review

I reviewed only the supplied text and excerpts. I ran nothing and inspected no other files.

The biggest problems are findings 1 and 2. A return to the device the human originally used can't be stored, and a pending transfer has no certified way to end. Section A lists design flaws, Section B lists what the current source can't yet do, and Section C lists claims I couldn't check.

## A. Flaws or ambiguities in the proposed design

### 1. A return (or same-device re-key) to the original device is blocked by the import rule
**Section:** Private delivery and destination import, fourth paragraph.
**Trace:**
- The design allows "A destination device key may be the last certified human device for that seat." This is also the main case in stage 10 §3.4: the human returns "with their device storage intact".
- That device already has a journal for this `gameId`. `openOnlineGame` binds it to `online-game/${digest}/keys`, whose bytes include the retired voting key.
- The design then says: "Reject an existing local game record bound to a different key rather than overwriting it."
- `IndexedDbProtocolJournal.initialize` and `load` also throw when the stored binding doesn't match. The record key depends only on the genesis digest, so a second binding can never live alongside the first.
- Result: the return can never reach readiness on its own device.

**Minimal correction:** Add one explicit case, done in one transaction under the writer lease. An existing record may be superseded if the verified certified prefix shows that (a) its bound key is this seat's controller key retired by the named recovery or transfer, and (b) the certified `transfer-authorize` names this device and the new key. Keep the old safety bytes only as an archive and never reuse them.

### 2. A pending transfer has no certified exit, and recovery during a pending transfer is undefined
**Section:** Signed evidence (the "Reject … pending recovery/transfer" rule) and Routing/crash order.

**Trace A (no exit):** Take a four-human game.
1. The owner's `transfer-authorize` is certified.
2. The destination loses storage before readiness, or never comes back.
3. The only ways out are an amendment (`previous`) or activation. An amendment needs a fresh owner intent or lost-key approvals for a new destination, and activation needs the lost destination.
4. If the owner is also gone, the pending transfer blocks everything else.

**Trace B (recovery during pending):**
- The existing `validateRecoveryTransition` knows nothing about `TransferState`, and the design only forbids the other direction.
- If `recovery-authorize` for the owner is certified while the transfer is pending, recovery raises the epoch and freezes the seat.
- Transfer activation then fails the epoch or generation check. The earlier disclosure permission stays recorded unless something clears it.

**Minimal correction:** Add a `transfer-cancel` membership variant, certified by the current quorum, that clears `pending`. Also define exactly how recovery interacts with a pending transfer. Either reject recovery while a transfer is pending (and rely on cancel), or let recovery-authorize atomically cancel a pending transfer that touches the departed seat or its hosted bots.

### 3. Return anchoring breaks when the recovery authorization was amended
**Section:** Signed evidence, return mode. "Replay the certified parent of that recovery authorization…"

**Trace:**
1. `recovery-authorize` is certified at seq 10, with parent 9.
2. An amendment is certified at seq 12 with `previous = 10`.
3. Activation is certified at seq 14. `activate` writes `completed.authorization = pending.entry`, which is 12.
4. At 12's parent, `authorize` has already set the seat to `kind: 'bot', status: 'pending-recovery'` with a changed `hostSeat`. The seat has no human controller there, and its device route may already be gone.
5. A check for "the human game key at the parent" therefore fails, or passes only by accident on the unchanged `publicKey`.

**Minimal correction:** `recovery.authorization` names the final amendment, so it matches `completed`. Replay should follow `previous` through `RecoveryState.authorizations` back to the root authorization (the one with `previous === null`) and read the controller and route at the root's parent.

### 4. A return can name a seat other than the departed human
**Section:** Return mode.

**Trace:**
- Human H hosts genesis bot X. H departs, so recovery affects both H and X.
- A return statement with `seat = X` and `recovery = H's recovery` meets "active recovered bot" plus "names the completed authorization…".
- H's retired key or device can then sign `returnIntent`. X becomes a human voter while H stays a bot.

**Minimal correction:** Require `seat === root.statement.departedSeat`. The same rule settles which recovery to name when a seat was recovered twice (see finding 5).

### 5. Which bots a return includes is ambiguous after later recoveries or re-keys
**Section:** Return mode: "still a bot under the relevant recovered ownership" and "moves a bot to another owner".

**Trace 1:** A departs, and A and A's bot Y go to host H. H then departs, so a second recovery moves A and Y to host C. Is a host change caused by recovery a "move to another owner" that removes Y? It's also unclear whether A itself stays returnable.

**Trace 2:** H does a live transfer. Y gets a fresh key but keeps `hostSeat` H. The design doesn't say whether a re-key under the same host counts as a move.

**Minimal correction:** State the rule exactly. A seat is eligible if all of these hold:
- it is in the root recovery's `replacements`;
- it is currently an active bot;
- no certified `transfer-activate` since that recovery's activation has changed its `hostSeat` to anything other than the recovery-assigned host chain.

Recovery-caused host changes and same-host re-keys keep a seat eligible. Add tests for both traces.

### 6. The approval and intent signatures bind the exact head, so a return may never be certifiable
**Section:** Signed evidence: "All signatures cover the whole statement, including the parent…"

**Trace:**
- In return mode the recovered bots keep playing automatically, so the head moves with every bot action.
- `humanApprovals` are explicit UI approvals, requiring every current human in the no-key return. `returnIntent` and lost-key approvals likewise come from people, not automation.
- Any certified entry between collecting the signatures and proposing the authorization makes all of them invalid. Recovery avoids this only because its host and key signatures are automated.

**Minimal correction:** Have human-facing signatures bind a stable anchor instead of `parent`: `{genesisDigest, epoch, controller activatedAt refs, recovery ref, destination, replacements}` plus a bounded `validUntilSeq`. The certificate on the authorization entry still binds it to the exact parent. Alternatively, pause engine progress while authorization signatures are collected.

### 7. The rules for a new destination device contradict one another
**Section:** Signed evidence: "Validate … against every genesis and current device identity" and "a new device identity is allowed only through explicit current-human approval."

**Problems:**
- The last device is itself a genesis device identity. Read literally, "validate against" rejects the permitted case.
- It's unclear whether live `ownerIntent` counts as "explicit current-human approval". The chosen policy says no separate approval is needed, but the device clause says one is.
- In return mode the returning human isn't a current human. So a return to a new device would always need unanimous approval, even with a surviving game-key intent. The design doesn't say whether that is intended.

**Minimal correction:** Spell out the rule per mode:
- `destination.devicePeer` must differ from every *other* seat's current route and from every game key.
- Live: `ownerIntent` authorizes a new device.
- Return: a game-key `returnIntent` authorizes a new device. A device-key intent authorizes only that same device (see finding 8).

### 8. Device-key return intent conflicts with the stage-10 §1 invariant
**Section:** Return authentication versus 10 §1: "loading an old identity backup cannot recreate permission to vote."

**Trace:**
- A device identity key can be exported in an identity backup.
- With `signer: 'last-human-device'` alone, together with the ordinary certificate and cooperating recoverers, whoever holds that backup can create a new voting key for the seat.

**Minimal correction:** Choose one:
- Allow a device-key intent only when the destination is that same device and it presents intact journal evidence. Otherwise require the game key or unanimous approval.
- Or amend §1 to say explicitly that the identity key can authorize a return.

### 9. The lost-key live path has no absence precondition and no valid envelope signer
**Section:** Signed evidence (lost-key) and Private delivery.

**Problems:**
- **No valid envelope signer.** The envelope is signed "using the current authorized source controller key". In lost-key mode that key is the lost one, so no valid `TransferPrivateEnvelope` can exist, and it's unstated where the masters come from.
- **No absence check.** Nothing requires the owner to be absent or out of contact. In a four-human game where the seat's master is already known to the recoverers (a seat that was recovered and then returned), three humans can move a present owner's seat to a new device they control. That device then holds a voting human seat, not a bot, with no takeover timeout.
- **Approver set unclear.** The approval text doesn't say whether the owner seat is excluded.

**Minimal corrections:**
- Define the envelope signer for lost-key mode: the seat's certified device route key, or an explicit rule that `verifyRevealedMaster` alone is the integrity check.
- Exclude the source seat from the approvers.
- Require either a signature from the seat's certified device route or a certified `SEAT_OFFLINE` older than the genesis takeover `afterSeconds`.

### 10. The destination can sign key possession before its keys are durable
**Section:** Crash order.

**Trace:**
1. The destination signs `destinationGameSig` and `replacementKeySigs`.
2. It crashes before persisting those secrets.
3. The authorization is certified naming keys nobody holds, and only an amendment or cancel (finding 2) can clear it.

The design persists the destination key only "before releasing readiness".

**Minimal correction:** Persist the destination game key, the bot keys and the device binding before sending any possession signature.

### 11. Keys named in a superseded authorization are not reserved
**Section:** Signed evidence: `usedPublicKeys` is appended only at activation.

**Trace:**
- Recovery reserves its keys at authorization.
- Under this design, the keys from an amended or cancelled transfer authorization stay unreserved. That destination may already hold masters, since authorization is the disclosure gate.

**Minimal correction:** Append the destination and replacement keys to `usedPublicKeys` when `transfer-authorize` is certified, as recovery already does.

### 12. Recovery doesn't clear device routes
**Section:** Routing: "derive the device-to-game map from validated genesis bindings plus replayed transfer entries."

**Trace:** Transfer entries are the only route input. After a recovery, the departed human's device still maps to a seat that is now a bot. The return rule also needs the route history as it stood before recovery.

**Minimal correction:** Recovery activation removes the departed seat's route from `TransferState`. Route history comes from certified replay, as the design already states.

### 13. Destination loss after activation in a two- or three-human game stops the game permanently
**Section:** Routing/crash order: "…or the normal recovery rules apply."

**Trace:**
- Two- and three-human games have no escrow recovery.
- A new transfer needs the destination key, or lost-key approvals from `quorumSize(n)` humans, which includes the lost seat.
- If the destination's storage is lost, no path remains.

**Minimal correction:** State the permanent pause explicitly, and make the activation UI warn about it in those games.

## B. Current-source limitations (not flaws in the design)

- **`openOnlineGame` assumes genesis keys.** It checks `material` against genesis `publicKey`s, derives `owned` from genesis `botHost`, and identifies `self` through the genesis device mapping. It can't open any seat after a recovery or transfer. The design's implementation plan doesn't list this.
- **`OnlineGameTransport` has a fixed peer map.** Its maps are `ReadonlyMap`s built once from genesis, and it keeps a departed device's route for the whole session.
- **The journal can't import.** `IndexedDbProtocolJournal` has no prefix-import path (`initialize` writes genesis at height 1 only) and supports one binding per `gameId`. This affects findings 1 and 10.
- **Recovery can't see transfers.** `validateRecoveryTransition` has no `TransferState` input, which is needed for finding 2.

## C. Claims I couldn't check from the excerpts

- That `engine.ts` accepts `SEAT_STATUS {status:'active'}` and restores human control deterministically.
- The 4 KiB limit on `seal` and its confidentiality-only guarantee.
- That `proposal.ts` derives voters from active human controllers.
- `WebRtcTransport.freezeRoster()` and `loadRecoveredHost`.
- Exactly which commitments `verifyRevealedMaster` checks. The design lists the genesis master point, beacon tip, deck lock keys and encryption key.

**Correction to the design's source summary:** Recovery checks that replacement keys are fresh at *authorization* (usedPublicKeys, plus `keySigs` over the readiness statement). Recovery activation checks only the recoverers' signatures and never re-checks the replacement keys. The design's per-bot `replacementChecks` at activation is therefore new behaviour, not something shared with recovery.

The design holds on these points, as far as the excerpts show:
- Old-set/new-set quorum intersection, including four-to-three and back to four.
- Excluding the absent bot from return approvals.
- Retiring the old key before the destination votes.
