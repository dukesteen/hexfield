# Stage 07 Step 3 live follow-up review

This review covers only the supplied source and documents. No tools were run, and references use `file` → `symbol`.

**Summary:** I found no safety defect in the M1/L2–L4/L6 changes.

- **L2 continuity:** Private state cannot skip or repeat a certified entry. A failed private apply advances neither the driver cursor nor the session context.
- **L4 preflight:** The ownership preflight runs before `journal.initialize` on create.
- **L6 inbox:** The inbox shortcut does not weaken validation. The only unverified path into `candidate` is data that `remember` has already verified against the same operation ID. `entryCandidate` → `deriveCandidate` → `validateNextEntry` still runs `completeDeckDeal` in full before any local proposal, and incoming proposals are validated independently.

Below are one liveness defect in session state, one residual gap from M1, and one low-severity retry issue.

## Findings

### F1 (Medium): A successful repair leaves the session inert in `error`, which can deadlock the game

**Where:**

- `p2p-session.ts` → `open` → `replicaOptions.onStatus`, which sets `status = error` on any `halted` status
- `p2p-session.ts` → `repair`
- `replicated-log.ts` → `receive` → `SNAPSHOT_RES` → `repairNow`

**Trace:**

1. A certified entry fails local validation. `handleEffects` → `halt` reports `{kind:'halted'}`, so `onStatus` sets the session status to `error`.
2. `P2PSession.repair()` succeeds. It clears `protocolStatus` and calls `maybeAutomatic`, but never resets `this.status`.
   - The automatic path is worse. Snapshot-driven `repairNow` inside `receive` never reaches the session at all, so neither `protocolStatus` nor `status` is cleared.
3. The status stays `error`, so:
   - `validate` returns `session-inactive`;
   - `getPending` and `getLegalCommands` return empty results;
   - `maybeAutomatic` returns early.
4. Only a commit from another peer calls `applyCommit`, which sets `running` again. If the pending input belongs to this peer (a turn, discard or automatic claim), nobody can commit. Verified sessions currently have no `TIMEOUT` input, so the game stalls permanently.

This may predate this packet, but it undermines the claim that restore works normally and that automatic claims recover.

**Fix:**

- Have `ReplicatedLog` report a distinct `repaired` or `resumed` status from `repairNow`, whichever path invoked it.
- On that status, the session sets `running` or `complete` from `context.log.state.result`, emits, and calls `maybeAutomatic`.
- Keep `error` for halts that dispose the replica.

### F2 (Low): The M1 fix still lets view projection exceptions halt the replica after a successful private apply

**Where:** `p2p-session.ts` → `notify`, which calls `this.update(events)` outside its `try`.

**Trace:**

1. `applyCommit` succeeds, so the driver state and `this.context` both advance.
2. `emit` → `notify` → `update` calls `engine.project`, `engine.getPending` and `driver.getTimers()`.
3. If any of these throws (for example an engine projection bug on a particular state, or a driver timer bug), the exception escapes `onCommit`.
4. `persistCommit` reports `halted/commit-application` and disposes the replica. Public and private state are still consistent.

The same throw also skips every later listener. In `dispose`, it would skip `listeners.clear()` after the keys have been zeroed.

**Fix:** Build the update once per `emit`, inside the `try`. Report `session-listener` or `session-projection` on failure. This also removes redundant projection work, which today runs once per listener.

### F3 (Low): An automatic claim that fails transiently is never retried at the same parent

**Where:** `p2p-session.ts` → `submitAutomatic`, which sets `automaticParent = parent` before `submit`, plus the `.then` handler.

**Trace:**

1. At parent _P_, the engine returns `CLAIM_VICTORY`.
2. `submit` fails transiently. Examples:
   - `prepareCommand` → `deck-reveal-proof` because the deck-source factory threw;
   - `replica-command-cap`;
   - any pre-acceptance replica error.
3. The `.then` handler retries only if the head moved. Because `automaticParent === P`, the claim is suppressed until an unrelated commit happens.
4. If the player acts manually (for example `END_TURN`), the claim is next attempted at a later head. The win may then be deferred to a later turn, or pre-empted by another player's claim.

**Fix:** Clear `automaticParent` for failure codes that do not prove the command is invalid at _P_, and rely on the next pulse or status change to reschedule. Keep the memo only for deterministic rejections such as engine or proof invalidity.

## Checked and not found defective

- **Continuity (L2):**
  - The open-time check compares `replica.getContext().log.head` with the replayed head.
  - `applyCommit` compares `previous.log.head` with `this.context.log.head` and checks `seq` and `prevHash`.
  - `VerifiedSessionDriver.committedEntry` checks `appliedHead`, including input-null entries, and requires a seq-0 parent at start.
  - A commit that races between the two journal loads causes a fail-closed halt (`session-replay-head` → `commit-application`), never a skip.
- **Atomicity:**
  - The driver builds the `next` map and assigns both `privates` and `appliedHead` only after every owned seat has applied and passed `validOwnedState`.
  - CARD_DEALT decode failures return before either is touched.
  - The session commits `context`, `events` and `status` only after the driver succeeds.
- **Ownership preflight (L4):**
  - `ownedSeats` is derived from keys that were already checked against genesis.
  - Verified sessions reject extra private seats.
  - Every path that rejects after the session is constructed disposes it, zeroing the keys and disposing the driver.
- **Key cleanup (L3):** `keyMatches` zeroes the temporary identity in `finally`. `ReplicatedLog`'s own `fill(0)` on its derived identity confirms that `identityFromSecret` returns a copy.
- **Automatic path:**
  - The microtask `try/catch` covers synchronous throws.
  - `submit` rejections are caught.
  - The `inflight` skip is re-driven by the `finally` block in `submit`.
  - Status is rechecked inside the microtask.
- **Proof context:** `prepareCommand` now requires `body.headHash === appliedHead`, so a proof cannot be produced for a parent the driver has not applied.

## Verification gaps

1. **Repair returning to a usable session.** No test checks that the session is usable after either `P2PSession.repair()` or snapshot-driven repair. Such a test would catch F1.
2. **Automatic-input test is weak.**
   - It never asserts that the injected throw happened. It should check a call counter or `protocolStatus.code === 'session-automatic-input'`.
   - Because the engine is built with `Object.create(engine)` and a non-enumerable property, the `{ ...engine }` spread in `detachedContext` and `detachedLogContext` yields an empty engine. Any hook that reads `context.engine` in that test gets `{}`.
3. **No live mismatch test for `onCommit`.** Nothing drives a replica commit whose `previous` head differs from the session head, and nothing asserts that the replica then halts and no private state is published. Only the open-time split journal and the driver unit test cover this.
4. **Preflight rejection is untested.** Missing tests for `session-driver-seats`, in both directions:
   - an owned seat with no private state;
   - a verified driver that returns a foreign private state.

   Each should also assert that a rejected `create` leaves the journal uninitialized, so that `create` can be retried.

5. **Driver cursor after a decode failure is untested.** The atomicity test covers `applyPrivate` failure. Nothing checks that a CARD_DEALT decode failure leaves the cursor in place, so that the corrected callback for the same entry is then accepted.
6. **Projection and timer exceptions from F2 are untested.**
7. **Zeroisation is not asserted.** No test checks key zeroing on open failure or dispose for `P2PSession` and `ReplicatedLog`. The key buffers the caller passes in stay referenced through `this.options` after dispose, which matches the "caller-owned" decision.
8. **Some claimed tests could not be checked.** The response says the tests now restrict each host's deck source to its own seats, and that a card is played through `P2PSession.submit`. Those tests are in `deck-replica.test.ts` and `testing/verified-deck-session.ts`, which were not in this packet, so I could not confirm either claim.
9. **Restore mismatch is detected late.** The replica attaches transport, resumes and may vote before the open-time head check disposes it. This is safe, since votes depend only on public state, but it is untested. Passing the expected head into `ReplicatedLog.restore` would move the check before `attachTransport`.
