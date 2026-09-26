# Stage 07 signed Monopoly count delivery: review

**Verdict:** I found no high-severity safety defect in the packet.

Each part of the chain checks what the design says it should:

- **Proof binding.** The operation ID covers genesis, epoch, anchor, monopolist, resource, keys and commitments. The Schnorr context adds seat, commitment and count. Each contribution carries a victim-key signature.
- **Evidence order.** `entryInput` verifies the signed count before any system policy.
- **Engine match.** `completeCountHandPlan` matches the derived obligation and exact effects.
- **Frozen state.** `validateCountState` rechecks the frozen state against engine pending and unconsumed commitments on every entry.
- **Driver gating.** The driver checks ownership, head, operation and openings before it reads a blinding.

The findings below are mainly about liveness, defence-in-depth and tests that are weaker than their claims.

## Implemented defects

### Medium

**M1. A missing count store is only discovered at the first Monopoly, and then the replica shuts down mid-game.**

- _Where:_ `ReplicatedLog.prepareCount` and `checkLocalKey` in `replicated-log.ts`.
- _What happens:_ `checkLocalKey` checks that beacon and deck stores exist at open, but not `countContributionStore` or `countProof`. A verified peer configured without a count store opens and plays normally. At the first Monopoly where it hosts a victim, `prepareCount` calls `failClosed('replica-count-store')` and disposes the replica. The victim's contribution never arrives, so the other peers stall too.
- _Related:_ a corrupt stored record (`count-outbox-record`) also causes a permanent halt. `repair()` cannot recover it, because repair only handles `certified-validation` halts.
- _Fix:_ In `checkLocalKey`, when genesis is verified, require both `countContributionStore` and `countProof`, just as the beacon and deck checks do. Separately, decide whether a corrupt outbox record should get an operator repair path.

### Low

**L1. Count evidence checking and count consumption are enforced by call order, not by a shared invariant.**

- _Where:_ `validateNextEntry` in `log.ts` and `validateCryptoTransition` in `crypto-context.ts`.
- _What happens:_ `verifyCountInput` runs only in `entryInput`. `completeCountHandPlan` runs later for any `REVEAL_COUNT` input, whichever branch selected it. Suppose a module adds a random pending whose `systemType` is `'REVEAL_COUNT'`. That input would take the `handled: true` beacon branch, skip `entryInput`, and still be consumed by `completeCountHandPlan` with no owner signature or opening.
- _Reachability:_ This cannot happen in the base game. It is exactly the kind of callback/branch bypass this review was asked to look for, so it should be closed.
- _Fix (either works; the second is stronger):_
  - In `validateCryptoTransition`, exclude `REVEAL_COUNT` from `beaconInput`.
  - Or have `entryInput` return the verified `SignedCountContribution`, and make `validateNextEntry` require it before calling `completeCountHandPlan`.

**L2. A count candidate that fails derivation blocks this proposer and is never dropped.**

- _Where:_ `ReplicatedLog.candidate` in `replicated-log.ts`.
- _What happens:_ `if (crypto) return this.entryCandidate(state, crypto);` returns `null` when `deriveCandidate` rejects the payload. It does not fall through to commands such as `CLAIM_VICTORY`, and `CountInbox` keeps the same contribution. Every later round at this height repeats the failure for this proposer.
- _Reachability:_ Commitment binding makes an engine-invalid signed count hard to produce today. Any accounting or invariant failure on a count entry (for example, a future module exceeding the 63 bound) would wedge this proposer.
- _Fix:_ On derivation failure, evict that seat from the inbox (add `CountInbox.forget(seat)`), then continue to the command path.

**L3. `P2PSessionOptions` exposes the raw `countProof` producer.**

- _Where:_ `P2PSession.open` in `p2p-session.ts`.
- _What happens:_ `P2PSessionOptions` omits only `systemInput`, `onCommit` and `onStatus`, so callers can pass `countProof`. If the driver has no `produceCountProof`, `...options` keeps the caller's producer. That producer skips the driver's ownership, head and opening checks.
- _Fix:_ Also omit `countProof` from `P2PSessionOptions`, and always set it from the driver (or explicitly `undefined`).

**L4. Invalid `REVEAL_COUNT` proposals are not objective accusation evidence.**

- _Where:_ The `PROPOSAL` handler in `replicated-log.ts`.
- _What happens:_ Only `payload.kind === 'command'` rejections produce an accusation. A Byzantine proposer can propose forged or substituted count entries in each of its rounds and only receives strikes and timeouts. This is a liveness cost, not a safety issue, and it is probably intended as later work.
- _Fix:_ Record it as a gate. Count evidence is objectively checkable at the certified parent, so the `invalid-command` accusation path could be extended to system count entries.

## Tests that do not support their claims

**T1. `count-state.test.ts`, "requires the signed count before a permissive system policy…"**

- _Gap:_ `data.entry(data.context, invalid)` has no `input`, so every entry carries the parent `stateHash`. Every variant would fail with `state-hash` even if `verifyCountInput` stopped comparing seat or count. No error codes are asserted. The `count: 1` variant targets seat 2, whose exact ore is 2, so the engine rejects it with `reveal-out-of-bounds` anyway. The only real guard is `verifySystem not called`.
- _Fix:_ Build each entry with the correct post-apply hash, assert `count-input` / `count-pending` / `count-operation`, and use seat 1 (bounds 0–1) with a `count: 1` input carrying the zero proof.

**T2. `count-contributions.test.ts`, inbox test**

- _Gap:_ The comment says a proposer-control entry is kept, but the test only calls `candidate(cryptoFor([0, 1]))` twice with identical input. Control preservation is covered only by the separate `validateNextEntry` test, not by the inbox.

**T3. `verified-session-driver.test.ts`, count proof test**

- _Gap:_ `toMatchObject({ value: { proof: {} } })` matches any object; the proof is never verified.
- _Missing cases:_ no test refuses production for a stale `appliedHead` or a wrong owned opening. These are the "no premature secret" guarantees.
- _Blinding:_ This fixture uses zero blindings.

**T4. Store "retries/races/corruption"**

- _Race:_ No test makes `putIfAbsent` lose to another writer, so the winner-load branch and the missing-winner branch are unexercised.
- _Corruption:_ The corrupt case is a pre-existing record, not a race winner.
- _Persist-before-broadcast:_ This is shown only by reading the code. No replica test injects a throwing or false `putIfAbsent` and asserts that no `COUNT_CONTRIB` is sent.

**T5. Live seed-14 trace**

- _No zero reveal is reachable._ Steals are disabled, so all hands are publicly exact, and max > 0 then means count > 0.
- _Max-0 exclusion_ is neither forced nor asserted.
- _Seat matching:_ Reveals are counted, not matched to `expectedVictims`.
- _Restore happens only after all reveals complete._ The plan's "durable restart" case is untested: restart with an unconsumed victim, reload the stored bytes, rebroadcast, and certify.
- _Fix:_ Add a restart between the first and last reveal, and compare the reveal seats to `expectedVictims`.

## Later-stage work (not defects in this checkpoint)

- **Offline victims stall the game.** A disconnected victim owner (or the host of a victim bot) stalls Monopoly indefinitely. This needs escrow or timeout recovery.
- **Commitments are not yet hiding.** Blindings are still zero, so every commitment is `count·G` and can be brute-forced over 0–63. The count proofs have witness 0. Hiding only begins with Step 5 transfer blindings.
- **Early count disclosure.** Counts are gossiped before certification. If a victory claim closes the operation first, unconsumed counts have already been disclosed. This is minor, since Monopoly reveals them anyway.
- **Legacy verified journals with an uncaptured Monopoly** fail `count-context-required`. This is the existing protocol-version and migration gate.
