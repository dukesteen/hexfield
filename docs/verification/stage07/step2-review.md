# Stage 07 Step 2 beacon review

I found no defect that lets a peer bias or substitute a public beacon outcome in this slice. There is one implemented-slice flaw that can permanently stall a game. There are several test gaps where the claimed guard is either untested or the test would still pass without it.

## Confirmed issues in the implemented slice

### 1. Extension secrets are not bound to the certified tip, which can permanently fail a seat (Medium)

**Affected:** `BeaconSecretSource`, `prepareBeaconContribution`, `ReplicatedLog.prepareBeacon`

**Cause:**

- `source.extension(chainEpoch)` may return a different chain on each call. The race test depends on this: it produces two different tips and accepts whichever persisted.
- `source.link(chainEpoch, index)` has no tip or commitment argument, so the source cannot tell which candidate chain was certified.

**Failure trace:**

1. Seat 0 is exhausted. `prepareBeaconContribution` loads no record and calls `source.extension(1)`, which returns chain A. The source retains A, as required.
2. The process crashes before `putIfAbsent` completes. Two tabs or workers racing on one store gives the same result.
3. On restart the load is again empty. `source.extension(1)` returns chain B, which is persisted, sent and certified with tip `b0`.
4. At the next reveal, `getBeaconOperation` gives epoch 1, index 1, previous `b0`. `source.link(1, 1)` returns A's link if the source kept the first chain for epoch 1, which is the natural retain-once behaviour.
5. `signBeaconReveal` throws "does not advance its frozen chain". The catch-all maps this to `beacon-contribution-prepare` ("could not be persisted"), and `failClosed` disposes the replica.
6. Every restore repeats this. The fixed request can never complete, and escrow recovery (§7) cannot reproduce tip B either.

**Direction:** do either of the following, and fix the misleading error code:

- Require extensions to be derived deterministically from the master secret and epoch. `DERIVATION_LABELS.beaconExtension` already exists.
- Pass the certified commitment into `link()` and persist the chain secret before signing.

### 2. Registered derivations are not bound to certified game context (Low, hardening)

`policy.entry.randomDerivations` is local configuration and is not checked against `genesis.config.modules`. Two honest peers with different module registrations derive different outcomes or validation results. They then diverge into a `certified-validation` halt instead of rejecting at genesis. Replay has the same dependency.

### 3. Hard-coded bounds may conflict with the engine (Low, needs confirmation against the engine)

- `seatList` rejects configurations with more than 4 seats. The protocol and quorum table allow up to 6 humans. A verified 5–6 seat game would fail in `initializeCryptoContext`, because `freezeBeaconRequest` rejects `startSeat` and so genesis is rejected.
- `diceIds` requires at least 7 remaining balanced-dice ids. If the engine reshuffles below 7, the `ROLL_DICE` entry that creates the request fails `captureCryptoPending`. That command could then never be certified.

If 5–6 players is a later module, the seat bound is a missing feature rather than a flaw. The dice lower bound must match the engine's reshuffle threshold either way.

### 4. Any preparation error permanently closes the replica (Low)

`prepareBeaconContribution` maps a transient `store.load` or `putIfAbsent` exception to the same result as corruption. `prepareBeacon` then calls `failClosed` and disposes the replica, even during a routine pulse. "Corruption fails closed" is intended. However, a transient IndexedDB error currently has the same effect and requires a manual restore.

### 5. Extension commitments are only weakly checked (Low, not a bias)

`verifyBeaconExtension` only rejects `tip === previous`. It accepts:

- A tip equal to another participant's current tip, which mirrors their chain.
- One of the signer's own already-revealed links.
- `length = 1`, which forces an extension height before every round.

None of these can bias an outcome while one honest chain remains unknown. They do allow a participant to have no independent chain and to double the number of heights. Genesis lengths have the same missing minimum.

## Test assertions that would pass with the guard removed

- **Inbox duplicate guard.** The duplicate test (`beacon-replica.test.ts`, "needs both human tips…") injects seat 0's own contribution while the inbox is incomplete. If the `this.received.has(seat)` check were removed:
  - `remember` would return `true` and call `offerAvailableInput`.
  - `prepareBeacon` would skip (already sent), `beaconCandidate` would be null (1 of 2), and commands and system inputs are suppressed.
  - So there would be no safety write and no send. The assertions cannot tell the difference.
  - There is also no `BeaconInbox` unit test for stale, future or wrong-kind drops, or for a second valid extension from the same seat not replacing the first. Extensions are the only case where a signer can produce two valid, different contributions.
- **Durable reuse at replica level.** Reveals are a deterministic chain value plus a deterministic Ed25519 signature. The restore and send-error retry tests would therefore pass even if the store were never consulted. Only the unit test in `beacon-contributions.test.ts` (`link` called once) actually shows reuse. No replica-level test uses a nondeterministic extension across a restart, which would also have exposed issue 1.
- **`beacon-pending` guard in `validateCryptoTransition`.** While a steal is fixed, `active` is null, so `beaconInput` is false for `STEAL_RESULT`. This guard is the first barrier against a permissive `verifySystem` approving it. No test sends a command or generic-proof system entry while the beacon is active or fixed. `captureCryptoPending`'s `beacon-request-changed` check is a second barrier when the pending disappears. However, it does not cover inputs that leave the pending request unchanged.
- **Other untested guards:**
  - `beacon-fixed-kind`: a `beacon-fixed` entry on a dice or start-seat request.
  - The `protocol === BEACON_EVIDENCE_PROTOCOL` label check: every negative test keeps `beacon-v1`.
  - `ambiguous-random-request`.
  - `beacon-request-changed`.
  - `validateBeaconState`'s active-and-fixed exclusivity.
  - Registry output type versus `pending.systemType`. This is not enforced; the engine is the only backstop if an extension derivation returns, for example, `DICE_RESULT` for another request.

## Checked and found consistent with the claims

- Genesis tips are ordered by human seat and bound through `genesisDigest`.
- The frozen operation binds genesis digest, epoch, anchor, round, pending request and each participant's epoch, index, length and previous tip. Control entries preserve it (tested).
- The seed hashes the canonical operation and ordered `{seat, value}` pairs, excluding signatures. `uniformInt`'s rejection bound is correct, and `d1`/`d2` use separate labels.
- `START_SEAT` and `DICE_RESULT` always take the built-in path. `verifySystem` is never consulted for them, and a wrong input is rejected with `beacon-result`.
- No reveal can be produced or validated while any chain is exhausted. The extension keeps the original anchor and round. A duplicate extension or a second `beacon-fixed` is rejected.
- A proposer cannot re-anchor a frozen request, so a revealed honest link cannot be reused under a different context.
- Consensus `contextHash` and replay snapshots include `CryptoContext`. `stateHash` remains engine-only.
- `committedEntry` receives input-null entries, live and on restore, as detached copies.
- Extension derivations receive detached state, pending request, seed and context, and return detached outcomes.

**Missing later-stage features, not flaws:** a fixed steal stalls forever because nothing calls `consumeFixedBeacon`. Membership-epoch transitions, escrow-based recovery of withheld reveals, and genesis deck/escrow checks are absent.

## Adjacent Stage 06 observation (outside this slice)

`pulse()` uses `requireSend` for pending `SUBMIT` retransmits, and `handleEffects` uses it for votes and proposals. A single transient broadcast failure there throws and halts or disposes the replica. So "retransmission survives a temporary send failure" holds for the beacon path only, not for command or vote retransmission.

## Review limitations

This was a static read; I did not run anything. The following were not provided, so conclusions depending on them are conditional:

- Engine rules: whether commands are rejected during random pendings, the reshuffle threshold, and the supported seat count.
- `votes.ts`, `control.ts`, `wire.ts`, `safety-store.ts`, `testing/*`.
- The `@cp2p/crypto` HKDF/group internals beyond what was shown.
