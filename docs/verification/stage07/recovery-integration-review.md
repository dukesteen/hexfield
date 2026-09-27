# Design review: escrow coordinator and certified recovery integration

The first two findings apply to the **coordinator being implemented now**. Findings 3–6 apply to the **recovery design, which is not implemented yet**.

---

## Coordinator (current scope)

### 1. The completed marker has no representation in the registry, and the exported retirement helpers bypass it

The coordinator says completion blocks all later disputes and retirement, "including lower-level retirement helper". The code does not support that yet:

- `reservationSchema.status` only allows `'active' | 'retired'`. The registry has `retiredCeremonies` but no completed set.
- `retireEscrowCeremony` and `verifyAndRetireEscrowShareDispute` are exported and take no lock.
- `retireCeremonyAttempt` tombstones masters that were never reserved. So on a device with fewer than four humans, or one with no local dealer reservation, it retires a completed ceremony with no check at all.

A completed marker stored anywhere other than the registry record cannot be ordered against these compare-and-swap (CAS) writes. That includes a separate store key or an in-memory flag.

**Correction:**

- Add `completedCeremonies` (keyed by `ceremonyId`, not by reservation) plus a `'completed'` status to `registrySchema`.
- Make `parseRegistry` reject any ceremony that is both retired and completed.
- In `retireCeremonyAttempt`, return `escrow-ceremony-completed` before any mutation.
- In `reserveOrRestore`, reject completed ceremonies.
- Perform completion as one registry CAS: add the completed ID, set the ceremony's reservations to `completed`, and clear only their `envelopes`.
- `activeCeremonies` must stop counting completed ceremonies, so headroom is released.
- Either make the verify-and-retire helpers internal to the coordinator, or have them take the lock token. Otherwise a caller outside `withCeremonyLock` can still race completion.

**Hash-cycle check:** storing the genesis digest in the completed record is safe. The digest is computed over the body and does not depend on the registry.

### 2. Consent and retirement live in two stores, so a device can end up consented and retired at once

Genesis consent is written to `GenesisConsentStore`, while the active/retired state lives in the registry. The lock orders these operations on one device, but it does not make them one state machine:

1. After a local consent is persisted, and possibly already enqueued, an authenticated remote dispute can still arrive.
2. `verifyAndRetireEscrowShareDispute` then retires the ceremony.
3. `complete()` must now refuse, yet other peers can certify genesis using the consent this device already sent.
4. The device is left with a certified game it has locally aborted. It will neither retain its shares as completed nor vote.

A crash between the consent `putIfAbsent` and the enqueue has the same effect: on restart, a retirement proceeds because the registry still reads `active`.

**Correction:**

- Before signing, CAS the registry to `consenting{genesisDigest}` under the lock. Only then call `prepareGenesisConsent`.
- After `consenting`:
  - Local abort is refused.
  - An authenticated dispute is retained as post-consent evidence and does not retire the ceremony. A holder who both ACKed an envelope and complained about it is an equivocator, because the ACK binds the envelope hash. The share is public in either case, and retiring cannot un-send the consent.
  - `complete()` requires that the stored digest equals the completed genesis digest.
- Holder-side rule: `disputeAndPublish` must refuse if an accepted-share/ACK winner exists for that dealer. It should compare against the persisted record, not in-memory state.

**Hash-cycle check:** the consent digest excludes signatures and escrow completion state, so there is no cycle.

---

## Recovery design (next scope)

### 3. The authority resolver cannot be retrofitted while operation IDs hash genesis keys

The design says to "separate the immutable statement from signature authority", but the current code fuses them:

- `operationFromBeacon` rebuilds the steal operation from `genesis.seats[...].publicKey` and requires `fixed.operation.epoch === epoch`.
- `validateStealState` recomputes that expected operation at every step.
- `validateCountState` checks `operation.epoch !== epoch` and compares victim `publicKey` to genesis.
- `authenticateCertifiedEntry` requires the proposer to be a genesis human with the same key, so any post-transfer controller is rejected.
- `validateEntry` requires `crypto.epoch === membership.epoch`.
- `advanceContext` never updates `membership`.

If the design keeps the `publicKey` embedded in `StealOperation`/`CountOperation` but verifies new contributions against the "current controller", then either:

- `verifyStealContribution` still checks `operation.victim.publicKey` and rejects the new key, or
- someone rewrites the operation, which changes `stealOperationId` and invalidates certified receipts. That is exactly the "replace" the design forbids.

**Correction:**

- Stop recomputing frozen operations from current state. Carry the certified frozen record forward unchanged, and validate only its structural link to the beacon/anchor.
- Change verifiers to take `(operation, signerKey)`. `signerKey` comes from `resolveAuthority(seat, submissionParent)`, and the operation keeps its original key and epoch, which stay inside its ID.
- Drop the genesis-human check in `authenticateCertifiedEntry` in favour of membership at the certified parent.
- Advance `membership` and `crypto.epoch` together in `advanceContext`, only when the validated entry is a certified authorization or activation.

### 4. Membership entries are rejected exactly when the design needs them

In `validateCryptoTransition`, only `control` and `cheat-proof` short-circuit. Every other kind reaches:

- `deck-setup-pending` (before `decksReady`),
- `deck-pending`, and
- `beacon-pending`.

So an authorization entry fails whenever a draw, beacon or steal is pending, which is the main departure case. Separately, recovery during pre-play deck setup is undefined: lock keys are only partially committed at that point.

**Correction:**

- Add a `membership` payload branch next to `control`, returning `handled: false, input: null` with the crypto state unchanged apart from freeze flags.
- State explicitly that recovery before `decksReady` is refused, or specify how pending deck passes resume.
- Add a trace for authorization during active beacon, deck draw and steal, as a precondition of the existing test list.

### 5. Fresh command keys are not durable before readiness, and a pending recovery cannot be amended

The authorization names fresh per-seat keys and a host. The design never requires the host to durably persist those secrets, and the escrow material it will later receive, before sending readiness signatures. After certification:

- if the host loses the record, activation is impossible;
- the affected seats remain frozen;
- "one change at a time" blocks any other fix.

The same deadlock follows if the named host departs before activation, in games with at least five humans where that is quorum-feasible.

Doc 10 §2.3/§3.4 also still describes `SEAT_RETURN` as allowed "if the seat still has its master secret". That contradicts the rule that a retired controller "must never resume" signing from an older record.

**Correction:**

- The host CASes a pending-recovery record holding the fresh key secrets, the parent hash and the affected seats before emitting readiness.
- Add a certified `recovery-amend` or `recovery-cancel` under the current set. It supersedes the pending host or keys, requires new readiness, and never reverses release. Holders release only to the latest unsuperseded authorization.
- Redefine return as a fresh-key certified transfer.

### 6. Binding and disclosure claims: no cycle today, but one overstated guarantee

**Binding check:**

- Readiness binds the certified parent hash, which is correct. Do not "fix" it to bind the authorization entry hash: the entry contains the readiness signatures, so that would create a cycle.
- Release envelopes binding the authorization entry hash is fine because they are produced afterwards.
- The activation "recovered-state check digest" must commit to the activation parent's hash and state. It must not commit to the post-activation state (seat as bot, installed keys) or to the activation entry, since that would also be a cycle. Say this explicitly.

**Overstated claim:** "A previously recovered holder's original encrypted share can be opened only after the new dealer's own authorization" is not enforceable. Every activation voter must reconstruct the departed master, and so learns its genesis encryption secret. With that secret they can open that holder's sealed shares from every dealer in the public genesis immediately. For each other dealer, this removes one required colluder.

**Correction:**

- Replace the claim with the actual bound: after recovering seat A, any coalition of all remaining holders other than A can reconstruct another dealer.
- Make it a requirement that release policy (honest nodes) never treats already-recovered keys as authorization.
- Add a test asserting that the documented collusion bound holds, rather than asserting non-openability.
