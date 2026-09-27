# Review: durable phase deadline in `packages/protocol/src/online-ceremony.ts`

I don't have line numbers, so I cite locations by method name. I found one high-severity defect, one medium, and two low. The rest of the change holds up.

## Defects

### 1. High: restoring a completed game times out if more than 20 s have passed since `waiting` began

**Where:** the `start()` restore branch, together with the pre-transition expiry check in `#enterPhase`.

**What happens:**
1. On restore, the fresh instance has `#locallyConsented = false`. The restore branch never consults the consent barrier and skips the `elapsed` check.
2. `#advance` → `#exchange('frozen')` → `#enterPhase`, which evaluates `!this.#locallyConsented && this.#phaseExpired(record.startedAt)`. The durable `waiting` phase started long ago, so it returns `expired: true`.
3. `#abortUnsafe('online-ceremony-timeout', prior)` calls `escrow.abort()`, which returns `escrow-ceremony-completed`. `#abortUnsafe` then sets `#locallyConsented = true` and emits `waiting`.
4. `#advance` swallows this as success (`locallyConsented && phase === 'waiting'`). But `#result` is still null.
5. `start()` hits `!this.#result && this.#disclosureBytes.size === 0` and returns `online-ceremony-restore: Completed result was not restored`.

**Impact:** Any saved game restored after the window fails to reopen. No durable damage occurs, because the escrow barrier held.

The same missing barrier causes a milder problem on a normal restart. If a post-consent attempt restarts within 20 s but the clock crosses the deadline during replay, the ceremony detours through `escrow.abort()`, emits a spurious `waiting`, and loses one retry interval.

**Smallest repair:** In `start()`, consult `#restoreConsentBarrier()` before `#advance`, in both branches, instead of only when the attempt is expired.

```ts
// restore branch, before #advance():
const consented = await this.#restoreConsentBarrier();
if (!consented.ok) return consented;
if (!consented.value)
  return failure('online-ceremony-restore', 'Certified escrow completion is missing');
this.#locallyConsented = true;

// normal branch, replacing the `elapsed` block:
const consented = await this.#restoreConsentBarrier();
if (!consented.ok) return consented;
if (consented.value) this.#locallyConsented = true;
else if (elapsed < 0 || elapsed >= TIMEOUT_MS) return this.#abortUnsafe('online-ceremony-timeout');
```

**Missing test:** the existing restore tests should restore after `advanceBy(20_001)`. That test would catch this.

### 2. Medium: waiting for sealed envelopes is charged to the `approvals` window

**Where:** `#escrowTranscript`.

**What happens:**
- The dealer's `#outgoing(envelope)` calls and the "private inbox missing" wait both run before `#exchange('escrow', …)` calls `#enterPhase('escrow')`.
- During that time the durable phase is still `approvals`. So approval collection plus envelope delivery share one 20 s window, and acks then get a fresh one.
- On expiry the diagnostic reads `online-ceremony-timeout:approvals`, while the UI shows `phase: 'escrow'`.

This is not a safety problem, because every output is still gated. It is a liveness problem, and the diagnostic is wrong.

**Smallest repair:** Enter the phase at the top of `#escrowTranscript`. The later `#exchange('escrow')` then becomes a same-phase no-op.

```ts
const entered = await this.#enterPhase('escrow');
if (!entered.ok) return entered;
if (!entered.value) return success(null);
```

### 3. Low: the post-CAS recheck in `#enterPhase` can report a spurious timeout in the new phase

**Where:** the `success({ phase, startedAt: next.startedAt, expired: … #phaseExpired(record.startedAt) })` return in `#enterPhase`.

**What happens:**
- The pre-CAS check, made under the attempt lock, already proved that the old phase completed in time.
- If the deadline passes during the `compareAndSwap` await, the new phase has already been durably written. `#abortUnsafe` is then called with `expected` equal to the *new* phase, so it retires the new phase and labels it as having timed out.

**Smallest repair:** Return `expired: false` in that branch. The pre-CAS check is the authoritative one.

### 4. Low: an already-signed packet can be sent after the deadline

**Where:** `#sendSlotWithinAttempt`.

**What happens:**
- `#outgoing` and the replay path in `#exchange` check expiry, then `await` `putIfAbsent` and/or `withCeremonyLock(deckCeremonyId(manifest))`.
- The escrow lock can be held by another tab for an unbounded time.
- After acquiring it, only escrow status is rechecked, not the phase deadline. A sealed envelope or ack signed before the deadline can therefore be broadcast after it.
- Retirement cannot race this, because the attempt lock is held. It is purely a late send, not a new signature.

**Smallest repair:**
1. Thread `record.startedAt` into `#sendSlotWithinAttempt`.
2. Immediately before each `#broadcast` call (both branches), add `if (!this.#locallyConsented && this.#phaseExpired(startedAt)) return failure('online-ceremony-timeout', …)`.

## Checked and correct

- **Duplicate or replayed packets:** these cannot extend a deadline. Non-waiting slots return early in `#receive`. `#enterPhase` only rewrites `startedAt` on a strictly later phase index, and phases are monotonic. `#schedulePhaseTimeout` recomputes the remaining time from the durable `startedAt`, so timer churn from packet floods keeps the same deadline.
- **Restart retains the remaining interval:** `start()` measures `elapsed` from the durable phase `startedAt`. The first `#enterPhase` no-op then reschedules with the true remainder. The third test covers this.
- **An expired phase cannot enter a fresh window:** the expiry check runs under the attempt lock before any CAS, and it also runs on same-phase re-entry. Every `#advance` therefore gates on the current phase. (The exception is issue 3, which fails closed.)
- **Stale timer callbacks:** `#onTimeout` compares `{phase, startedAt}` against the durable record, and `#abortUnsafe(…, expected)` repeats that comparison inside the lock. A stale callback cannot retire a newer phase, and `dispose` plus the `#disposed` guard cover callbacks that are already queued.
- **No new signatures after expiry:** `#outgoing` checks expiry before `produce`, before signing, and before persistence. The evidence packets (`escrow-invalid`, `escrow-dispute`) are unguarded by design; they retire the attempt, which is acceptable.
- **Lock order:** it is attempt lock → escrow lock everywhere: `#outgoing`, the replay sends in `#exchange`, `#abortUnsafe` → `EscrowCeremony.abort`, and the evidence handlers. The escrow-only calls (`checkEscrowCeremonyActive` in `#advancePhases` and `#checkConsentedDisputeEnvelope`, and `escrow.complete`) take no attempt lock, so I found no inversion.
- **Consent race:** `consentAndSend` runs under the attempt lock, and `#locallyConsented` is set before the post-produce expiry checks. A timeout that fires concurrently either sees `#locallyConsented`, or is refused by `escrow.abort()` returning `consenting`/`completed`, which flips the local state to `waiting`. A signed digest is never revoked.
- **Diagnostic reason:** `retiredReason` and `retiredPhase` are written only by the local `#abortUnsafe` and read only for `#emit` and the `start()` failure code. No decision branches on them, and no remote input sets them.

## Test gaps

The new tests don't exercise:
- restore after the window (issue 1),
- a stale queued timeout after a phase transition,
- a timeout that races local consent.

A test that restores after `advanceBy(20_001)` is the one that would have caught issue 1.
