# Review: cross-peer trade proof delivery

No finding reaches Critical or High. I found no way for an unauthorized or changed request to reach a hand source. I also found no way to bypass the `command-proofs-v1` verifier or to submit a stale or duplicate accepted command. The concrete defects affect liveness: one blocks the promised third retry, one ends a retry early during a timing gap, and three hardening issues are smaller. The focused tests have gaps in the stale/future request, restart and multi-parent paths.

## What holds

These were checked against your five questions and are sound as written:

- **Authorization order.** On the owner side the order is: route check, `verifyTradeProofRequest`, driver `appliedHead` check, a second `authorizeTradeProof`, `verifyOwnedOpenings`, and only then `createHandSource`. `hand-trade.test.ts` shows the proof source is not called for a forged signer, nonce +2, changed `withSeat`, missing offer, extra key or stale head.
- **Proof delivery can't bypass the normal verifier.**
  - Responses are accepted only from `pendingTradeProofs[requestId].ownerHost`, with an exact index order check.
  - `prepareCommand` verifies each external proof again, requires the slot to belong to `withSeat` and not to a local seat, and rejects duplicates. `verifyHandProofs` then checks the full set.
  - `replica.submit` and the vote/replay path run the unchanged `validateCommandForEntry`.
  - Proofs are copied with `copyCanonical` at both callback boundaries, so a callback can't mutate them.
- **Cancellation.** There is no `await` between the last `intent.cancelled` check and `replica.submit`. The reservation moves from `tradeIntents` to `inflight` in the same step. The `finally` guard `tradeIntents.get(seat) === intent` keeps an old intent's cleanup from deleting a newer intent for the same seat.
- **No retry after admission.** `replica.submit` is awaited exactly once. Automatic input never takes the `CONFIRM_TRADE` path.
- **Deterministic seeds.** The seed context includes the full parent-bound body and the obligation. The private hand at a certified parent is fixed by replay. So one seed context can't be used with two different witnesses, and regenerating a proof yields the same bytes.

## Findings in this change

### F1 — Medium: the shared expensive-request budget blocks the third fresh-parent retry

**Function:** `ReplicatedLog.receiveTradeProofRequest` → `admitExpensiveRequest(from, 'trade-proof/' + requestId)`

**Cause:** `EXPENSIVE_REQUESTS_PER_WINDOW = 3` applies per peer, per 10-second window, across every expensive category. `expensiveByPeer` is not cleared on commit. The coordinator can send four distinct request IDs within its 10-second deadline (the initial request plus three retries). The per-finalizer `seen` set is cleared on each commit, so it does not help here.

**Failing trace:**

1. t=0: the finalizer sends R0 at parent P0. The owner admits it and its budget window starts, with 1 entry.
2. t=0.3: an unrelated entry commits, such as another seat's `RESPOND_TRADE` or a beacon or deck entry. This yields `trade-proof-parent`, so the finalizer sends R1 at P1 (budget: 2).
3. t=0.6: another commit leads to R2 (budget: 3).
4. t=0.9: another commit leads to R3. `budget.seen.size >= 3`, so the owner drops it silently.
5. Retransmits every 250 ms are also dropped. The window only resets at t=10.0, which is also the deadline, so the finalizer returns `trade-proof-timeout`.

A recent `SYNC_REQ` or future-commit from the finalizer's host leaves even fewer attempts. In the other direction, after three trade requests the owner ignores that peer's `SYNC_REQ` and snapshot requests for the rest of the window.

**Smallest fix:** Stop charging trade requests to the shared budget. Deduplicate with the per-parent set that already exists. Successful requests are served from the cache before this point, so a repeat can only be a request that already failed at this parent.

```ts
if (seen.has(requestId)) return success(undefined); // already attempted at this parent
if (seen.size >= MAX_TRADE_PROOF_REQUESTS_PER_FINALIZER) return success(undefined);
seen.add(requestId);
```

Work stays bounded at three source calls per finalizer per certified parent, and parents only advance through consensus. Add a real-replica test with four distinct parents inside 10 seconds.

### F2 — Low/Medium: a timing gap between session and replica ends a fresh-parent retry early

**Functions:** `P2PSession.waitForTradeProof` (`retry`) together with `ReplicatedLog.requestTradeProof`. The gap comes from `persistCommit`.

**Cause:** `persistCommit` sets `this.context = next` and then runs `await this.openController()` before calling `onCommit`. Until `onCommit` runs, the session is still at P_n while the replica is at P_n+1.

**Failing trace:** Use a journal whose `loadSafety`/`restore` truly waits on I/O, as in the browser.

1. Entry n+1 commits on the finalizer's replica, and `openController` is waiting on I/O.
2. The session's 250 ms retry timer fires. Its head still equals `request.body.headHash`, so it resends.
3. `requestTradeProof` verifies against P_n+1 and gets `trade-proof-stale-head`.
4. That code is not `replica-transport`, so `finish(sent)` runs. `submitTrade` only continues on `trade-proof-parent`, so it returns `trade-proof-stale-head` to the user.

The promised fresh-parent retry never happens. In-memory journals resolve as microtasks, so the current tests cannot reproduce this.

**Smallest fix:** In `retry`, treat a replica-side parent mismatch like a transport failure: keep the wait alive and let the session's own head check detect the change once `onCommit` runs.

```ts
if (!sent.ok && !['replica-transport', 'trade-proof-stale-head', 'trade-proof-parent'].includes(sent.error.code))
```

Don't map these codes to `trade-proof-parent` and `continue`. While the gap lasts, each new attempt would rebuild the same stale body and use up all four attempts almost immediately.

### F3 — Low: expired timers are not checked again between the response and signing

**Function:** `P2PSession.submitTrade`, between `await this.waitForTradeProof(...)` and `prepareSubmission`

**Cause:** Only the 250 ms `retry` tick checks for expired seat timers. After a response arrives, `prepareSubmission` → `validate` checks automatic input but not timers.

**Failing trace:**

1. The seat timer's `expiresAt` passes at t.
2. The owner's response arrives before the next retry tick at t+250 ms.
3. The continuation signs and submits the confirmation.

The design says a timer cancels the intent before it runs. The outcome is only a race with the timeout input in consensus, not a safety issue.

**Dependency:** `VerifiedSessionDriver` has no `getTimers`, so this is inert in the current verified stack. It applies to drivers that expose timers.

**Smallest fix:** Move the automatic-input and expired-timer checks into an `interrupted(intent)` helper. Call it in `retry` and also directly before `prepareSubmission`.

### F4 — Low (hardening): an engine exception on the receive path halts the replica

**Functions:** `planTradeProof` (via `verifyTradeProofRequest` and `verifyTradeProofResponse`), called from `receiveTradeProofRequest` and `receiveTradeProofResponse`

**Cause:** `planTradeProof` calls `engine.validate` and `engine.apply` without `try`/`catch`. A throw propagates into `enqueue`'s catch, which sets `halted: replica-transition` and calls `dispose()`. The comparable `validateSignedCommand` path does wrap engine calls.

**Dependency:** This needs the engine to throw on a consented, schema-valid `CONFIRM_TRADE`, which the packet does not show.

**Smallest fix:** Wrap the body of `planTradeProof` and return `failure('trade-proof-invalid', ...)` on a throw.

### F5 — Low (depends on engine): the offer parser and consent rule may be stricter than the engine

**Functions:** `certifiedOffer` and the consent test in `planTradeProof`

**Cause:**

- The entire `ext.base.offers` array must pass a strict schema with `maxLength(64)` and exactly five resources on each side.
- A proposer-side offer requires `offer.to.includes(owner)`.

**Possible failures:**

- If the engine keeps invalidated offers across turns and they pass 64, every remote confirmation fails.
- If an offer or its `give`/`want` carries a key outside the strict schema (for example commodity resources in the knights module), the strict parse fails.
- If an empty `to` means an open offer, legal trades are rejected.

These all fail closed at the finalizer, costing liveness rather than safety.

**Fix:** Look up the offer by ID in an unconstrained array, strict-parse only that item, and match the engine's `to` semantics.

## Test coverage (question 5)

**Substantiated:**

- Authorization rejects bad requests before any source call.
- Response signature, index, epoch and slot-swap failures.
- In the session: cancellation, timeout, dispose, automatic preemption, timer preemption, withdrawal, admission atomicity, and the four-request cap. These use a mocked replica.
- The live trace shows:
  - a hidden steal first;
  - the first response dropped;
  - byte-identical request and response retransmits;
  - exactly one owner seed call;
  - one certified `CONFIRM_TRADE`;
  - commitment deltas matching the expected changes;
  - both peers' private hands unchanged after restore.

**Gaps:**

1. **`trade-proof-network.test.ts` never exercises request verification.**
   - It uses stub genesis, so every verification path would stop at `trade-proof-game`.
   - Its `staleRequest` has `headSeq: 1` against head 0, which makes it a _future_ request.
   - "No strike" is inferred from `disconnected === []`, but disconnection needs five strikes, so one strike is invisible.
   - "Wrong host" injects from the local peer itself.

   Needed: a verified-genesis replica test covering a stale request, a future request, and an invalid request at the matching parent, with strike counts asserted.

2. **Catching-up owner:** no test has an owner serve a retransmitted future request after sync without a strike.
3. **Restart regeneration:** no test restores, resubmits at the same parent and compares response bytes. The live trace restores only after the trade completes.
4. **Real replica with changing parents:** the retry cap is tested only against the mocked replica, which is why F1 went unnoticed. A late response for an old parent is also untested against the real replica; the session test's "late response" is at the same parent after cancellation.
5. **Third peer:** if `createVerifiedDeckSession(317, 2, …)` means two human hosts, no third host exists. The "no third-party bytes" claim then rests on `broadcasts === 0` and `to === otherHost`, which cover broadcast but not a real third peer.
6. **Fixture wiring:** `deckContributions: new MemoryStealDeliveryStore()` in `trade-replica.test.ts` looks like a copy error. If it type-checks, the two store types happen to match structurally; please confirm it is intended, since the trace's deck draws depend on it.

## Out of scope

I did not raise findings about escrow, typed cheat consequences, audit, real WebRTC, lobby, browser persistence or host takeover. I also did not treat the disclosed current-affordability signal at each parent or the timing side channel as defects.
