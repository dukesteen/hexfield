# Automatic victory retry review

I found no safety defect. No trace I checked signs or sends a duplicate admitted command, reuses proof material for a changed statement, or changes private or public state on a rejected attempt. I did find two low-severity liveness or classification issues, one diagnostic issue, and several test gaps. The most important test gap is that the focused backoff test would still pass without any doubling.

## Checked and not found defective

**Single-flight.** The seat is guarded by `P2PSession.inflight`, which is set before `replica.submit` and cleared only in its `finally`.

- An accepted command keeps `ReplicatedLog.submit` pending, so a retry timer that fires meanwhile reaches `submitAutomatic` → `inflight.has(seat)` and stops. It does this before setting `automaticParent`.
- The `finally` → `maybeAutomatic` re-drives the claim after the command settles.
- The 8 s window in the "transient proof rejection" test confirms nothing is prepared again while the command is pending.

**Ordering around a commit.**

- `persistCommit` → `onCommit` → `applyCommit` advances the session head, clears the timer, resets `automaticParent` and the delay, and queues the automatic microtask. All of this happens before `settlePending` resolves the in-flight promise.
- That microtask then sees `inflight` and skips.
- The stale `.then` sees `head !== parent` and only calls `maybeAutomatic`, which is idempotent through `automaticScheduled`. No timer is armed for an old parent.
- Session context changes only in `applyCommit`, so a pending `automaticRetryTimer` always belongs to the current head.

**Pre-admission classification of resolved failures.** Every way `ReplicatedLog.submit` can resolve with a failure is a pre-acceptance return, or happens after the session has already left `running`:

- Before `acceptedHash` is set, `submit` resolves the failure directly.
- After `acceptedHash` is set, it only reports `pending`.
- `dispose` resolves with `replica-outcome-unknown`. Every internal caller emits `halted` first (`failClosed`, the fatal and throw branches of `enqueue`, `commit-application`), so `onStatus` has already set `error`. On `P2PSession.dispose` the status is `disposed` before the microtask `.then` runs. In both cases `retryAutomatic` returns early.

**Nothing is transmitted on rejection.** Pre-acceptance failures return before `broadcast({t:'SUBMIT'})` and `rememberCommand`, so a rejected signature never leaves the process.

- A retry at the same parent computes the same nonce and body. With a deterministic `proofSeed`, it produces the identical signed command.

**Proof material.**

- `prepareCommand` rebuilds the evidence on every attempt from a fresh `newSource`.
- The seed context `{genesisDigest, epoch, anchor, seat, nonce, command, slotId}` covers the whole statement, so a changed statement gets a different seed.
- The seed is zeroed in `finally`, and a failure partway through the slots discards the partial `data`.

**No state change on rejection.**

- `validate` applies `applyPrivate` to a copy from `getPrivate`.
- `prepareCommand` touches no store.
- The replica checks (`validateSignedCommand`, `deriveCandidate`) do not modify `commands`, `rejectedCommands` or the context.
- The only mutations are the session's retry bookkeeping (`automaticParent`, `protocolStatus`, the timer and the delay).

**Lifecycle.**

- `dispose` cancels the retry before disposing the replica.
- The timer callback re-checks status and head.
- The disposal test asserts `pendingTimerCount() === 0`.

## Findings

### R1 (Low): The `.catch` branch treats a definitely pre-admission failure as outcome-unknown and never retries

**Where:** `p2p-session.ts` → `submitAutomatic` → `.catch`.

The stated rationale, that the admission outcome is unknown, does not hold. `P2PSession.submit` can only reject before `replica.submit` is called:

- `ReplicatedLog.submit` never rejects. It returns a `new Promise` whose executor only chains onto `enqueue`, and `enqueue` catches every error from its operation.
- The `finally` block only deletes from a set and schedules a microtask.
- The remaining throw sites are all before admission: `validate` (via `engine.validate`, `engine.applyPrivate` or `driver.privateState`), `entryHash(log.head)` and `signCommand`.

**Trace:**

1. At parent _P_, `driver.privateState` throws once. For example, `copyPrivate` fails to encode a transient `ext` value, or a wrapped driver throws.
2. `submit` rejects, and `.catch` sets `protocolStatus`.
3. `automaticParent` stays equal to _P_ and no timer is armed. Every later `maybeAutomatic` (the pulse, `submit`'s `finally`, `repair`) returns at `automaticParent === parent`.
4. This is the original F3 behaviour for this class of failure. The claim waits for an unrelated commit, and a manual `END_TURN` defers the win.

The same `.catch` also receives exceptions thrown by the `.then` handler, such as `clock.setTimeout` throwing inside `retryAutomatic`. Those end the same way: a memo with no timer.

**Fix:** Send the rejection through `retryAutomatic(parent, 'session-automatic-input')`, the same path the synchronous `maybeAutomatic` catch already uses. Keep the diagnostic.

### R2 (Low, residual of F3): The owner can still pre-empt their own claim during the backoff window

**Where:** `P2PSession.validate` and `getLegalCommands`, which do not consult `engine.getAutomaticInput`.

**Trace:**

1. The claim at _P_ fails once, and the next attempt is 250 ms or more away (up to 4 s after repeated failures).
2. The UI still offers `END_TURN`. The owner submits it, it is admitted and commits at _P_+1.
3. `automaticVictoryClaim` only fires for `turn.activeSeat`, so the claim now waits for this player's next turn. Another player may win in the meantime.

The patch narrows the window from "until an unrelated commit" to at most 4 s, but does not close it. The engine comment says "before any further input", and that is not enforced locally.

**Fix:** While `getAutomaticInput` returns an owned command for seat _S_ at the current head, have `validate` reject other commands for _S_, for example with `automatic-input-pending`. Alternatively, have `submit` wait on the automatic attempt.

### R3 (Info): Stale, unemitted diagnostics

- `retryAutomatic` writes `protocolStatus` without calling `emit`.
- `applyCommit` only clears a `halted` status. After the retried claim commits, `getProtocolStatus()` still reports `{rejected, 'deck-reveal-proof'}` until another status arrives.
- A retry also overwrites a more informative `pending` or `sync` status.

This is harmless to protocol state but misleading in the UI.

### Design note, not a defect: deterministic rejections are retried indefinitely

Every resolved failure is retried, capped at one attempt every 4 s per parent, including deterministic ones such as `deck-reveal-kind`, `deck-reveal-owner` and engine validation failures. For `CLAIM_VICTORY`, each attempt rebuilds the deck source, decodes the card, derives the proof, and repeats the replica's `deriveCandidate` / `validateNextEntry`.

This is bounded and has no safety impact. It departs from the F3 suggestion to keep the memo for deterministic rejections. If the retry cost matters, classify those codes as terminal for _P_.

## Test gaps

### Focused session tests

1. **Doubling is not verified.** The "bounds repeated automatic proof failures" test advances by exactly `[250, 500, 1000, 2000, 4000, 4000]` and expects one attempt per step. The next timer is armed asynchronously, after `advanceBy` returns, so each step fires at most once. A constant 250 ms delay, or a 1 s cap, passes this test just as well. Advancing `delay − 1` before each step and asserting no attempt would check the lower bounds.
2. **Replica-level rejections are not tested.** Nothing exercises a failure inside `ReplicatedLog.submit`, such as `replica-command-cap` or a failing `validateSignedCommand` or `deriveCandidate`. Such a test should assert that the command is retried and that no `SUBMIT` is broadcast for the rejected attempt.
3. **The `.catch` path (R1) is not tested.** No test makes `validate` or `privateState` throw on an automatic attempt and then checks recovery.
4. **The race with a manual command is not tested.** Nothing fires the retry timer while a manual command for the same seat is in flight. The expected result is one skip, then a re-drive from `finally`, with a single command signed.
5. **Retry across a halt is not tested.** Nothing lets the timer fire while the status is `error`, then repairs, and checks that the claim is attempted at the new head with a reset delay.
6. **The eventual commit is not checked.** The "without an immediate loop" test never reconnects the accepted command, so it does not show that the command commits exactly once.

### Real encrypted victory-card test

The test is strong on the end result: one injected `proofSeed` failure, nothing before 249 ms, a claim at 250 ms, identical certified entries with a 2-vote certificate, `DECK_REVEAL_PROTOCOL` evidence, a winner on both peers, the slot consumed on the owner, and null on the foreign peer. It does not check the following:

1. **The claim's parent.** It never asserts `signed.body.headSeq === parentSeq` and `entry.seq === parentSeq + 1`. A claim deferred to a later head would still pass.
2. **What the failed attempt produced.** It does not assert `protocolStatus.code === 'deck-reveal-proof'`. It does not use `observe` to check that no `SUBMIT` or `CLAIM_VICTORY` was sent before 250 ms. It does not check that exactly one `CLAIM_VICTORY` was signed and sent.
3. **Private state after the failed attempt.** Before the retry, it should check `getPrivate(buyer).slots[slotId] === 'victoryPoint'` and that the deck contribution stores are unchanged.
4. **Fixture brittleness.** It depends on seed 0 and `vpTarget: 3` dealing a victory point as the first card, to a buyer with 2 public VP. The test fails loudly if that changes, but an explicit assertion on the dealt card and the buyer's `publicVp` would make the precondition clear.
