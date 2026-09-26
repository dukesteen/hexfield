# Review: trade delivery timing fixes (F1–F4)

**Verdict:** F1–F4 are fixed as described. F5's three scenarios cannot happen with the included base engine. One conditional Medium remains: an unguarded proof verification on the response path. I also have two Low observations. I found no Critical or High defect.

## F1: separate trade budget

**Fixed.** The owner-side order is:

1. Finalizer-host check and exact `headSeq`.
2. Exact-bytes cache, which serves successful requests before any budget.
3. `verifyTradeProofRequest`.
4. Owner/key check.
5. Per-finalizer distinct cap of 3, cleared on commit.
6. `admitExpensiveRequest(from, requestId, 'trade')`: 4 per peer per 10 s, stored in `tradeProofWorkByPeer`, not in `expensiveByPeer`.

The earlier failing trace now passes:

- R0 at P0 uses 1 of 4. Each commit clears the per-finalizer set.
- R1, R2 and R3 at P1, P2 and P3 use 2, 3 and 4.
- Every per-parent set has size ≤ 1, so the cap of 3 is never reached.
- `SYNC_REQ`, snapshot and old/future-commit requests still use the separate 3-entry `expensiveByPeer`.

Only the active seat passes `planTradeProof`, so at most 3 successful responses exist per parent. The 16-entry cache cannot evict a live one.

A retry of the same failed body passes the per-finalizer check (`seen.has`). It is then dropped by `budget.seen.has(key)` until the window resets, after which it is regenerated. That matches the stated design.

## F2: replica/session publication gap

**Fixed.** During the gap:

- `requestTradeProof` fails at `verifyTradeProofRequest`, which returns `trade-proof-stale-head` (the head check comes before consent), before `pendingTradeProofs.set`.
- Nothing is sent and no owner budget is used.
- `retry` now treats `stale-head` and `parent` like a transport failure and reschedules.

When `onCommit` → `applyCommit` publishes the head, `finishWait(trade-proof-parent)` makes `submitTrade` continue with a new body. The wait still ends on:

- the deadline;
- cancellation;
- `status !== 'running'`, including an `onCommit` throw, which sets `error`;
- `replica-disposed`, which is not in the tolerated set.

It cannot spin past 10 s.

A small test note: the regression changes the parent with `Reflect.set` and the next tick's head check, not through `applyCommit`'s `finishWait`. Both paths end in `continue`, so the claim holds.

## F3: priority after arrival

**Fixed.** The order after the response is:

1. cancelled/running check;
2. head check;
3. deadline;
4. `checkTradePriority`;
5. `prepareSubmission`;
6. `checkTradePriority` again;
7. deadline again;
8. synchronous handoff to `replica.submit`.

There is no `await` between the last check and admission. The added test expires the timer inside a retry interval and responds, which covers the earlier trace.

## F4: local engine exceptions

**Fixed for engine calls.** The `planTradeProof` wrapper covers:

- `authorizeTradeProof`;
- `verifyTradeProofRequest`;
- the planning step of `verifyTradeProofResponse`.

Both receive paths exclude `trade-proof-unavailable` from strikes. The outer strike list in `attachTransport` doesn't match any returned trade code, so nothing is struck twice. However, the wrapper does not cover the proof loop; see N1.

## Remaining findings

### N1 — Medium (conditional): `verifyHandProof` on the response path is not exception-safe

**Where:** `verifyTradeProofResponse`, in the `for (const item of response.body.proofs)` loop. It is reached from:

- `receiveTradeProofResponse` (finalizer), with bytes from the peer;
- the owner's self-check in `receiveTradeProofRequest`, with local bytes.

Neither call is in a `try`.

**Condition:** `verifyHandProof` throws on schema-valid proof bytes. An example is a well-formed hex field that is not a valid group element; typical point decoders throw on these. `hand-transition.ts` is not in the packet, so I can't confirm this. The review notes that the equivalent command path in `validateSignedCommand` is wrapped.

**Trace:**

1. A malicious owner host answers a live request with a correctly signed response. Its indices are exact, but one proof has an undecodable point.
2. `receiveTradeProofResponse` passes the route and head checks and calls `verifyTradeProofResponse`.
3. The signature is valid, `authorizeTradeProof` is valid, and the indices match. `verifyHandProof` throws.
4. The error propagates to the `enqueue` catch. It sets `halted: replica-transition` and calls `dispose()`.

One peer can halt the finalizer's replica with one message.

**Smallest fix:** in `verifyTradeProofResponse`, wrap each `verifyHandProof` call and treat a throw as a failed proof:

```ts
let verified: Result<void>;
try {
  verified = verifyHandProof(planned.value.plan, item.index, item.proof, planned.value.binding);
} catch {
  return failure('trade-proof-invalid', 'Owner proof is malformed');
}
if (!verified.ok) return verified;
```

The bytes are covered by the owner's signature, so striking the sender here is correct. On the owner side, this turns a local self-check throw into "no response" instead of a halt.

### N2 — Low: a transient owner failure at the initial parent is never retried within the same intent

Take a new window whose first request is R0 at t=0, and suppose the owner's source fails temporarily.

- `budget.seen` keeps R0 until t=10.0.
- The finalizer retransmits every 250 ms, and every retransmit is dropped.
- The last retry is clamped to the deadline, which is also t=10.0, so the result is `trade-proof-timeout`.

The response only claims that a new user attempt can succeed, which is true. So this is not a regression; it just means "retry after the window" never happens within one intent. If that is intended, say so in the response.

This matters more if the owner's driver `appliedHead` can ever lag its replica context while requests are processed. That would require `ConsensusController` not to await `onEffects`, so a message could be handled between `this.context = next` and `onCommit`. In that case a request that is valid at the owner's parent would lose its whole intent. Please confirm that `onEffects` is awaited inside `dispatch`. If it is, this path is unreachable.

### N3 — Low: the per-peer trade budget spans trade intents

Four confirmations with the same host inside 10 s will drop a later intent's requests until the window resets. This includes bot owners, which share their host's budget. Because the window starts no later than the new intent, the reset always comes before that intent's deadline, so the cost is only latency. I'm noting it, not asking for a change.

## F5: reachability in the current engine

None of the three scenarios can happen with `trade.ts` and `shared.ts`:

- **More than 64 offers:** `offerTrade` and `proposeTrade` both use `offers.filter(item => item.proposer !== input.seat)` before appending, so there is at most one offer per seat, which is 6 or fewer. For the `maxLength(6)` limits:
  - `to` and `acceptedBy` are distinct other seats, at most 5.
  - `declinedBy` gets no duplicates. `respondTrade` rejects repeat responders. `cancelTrade`'s acceptor branch requires the seat to be in `acceptedBy`, which excludes it from `declinedBy`.
- **Extra keys:** `validatedSides` → `parseCounts` rejects any key outside the base resources and fills all five from `emptyResources()`. Offer objects are built with exactly the eight schema fields. `afterInput` only rewrites `valid`.
- **Empty or open `to`:**
  - `recipients` turns `undefined` into an explicit list of other seats and rejects `[]`.
  - Counter-offers set `to: [activeSeat]`.
  - The consent test mirrors `counterparty` exactly: acceptance for the active proposer, and `proposer === withSeat && to.includes(active)` for counter-offers. `respondTrade` also requires `to.includes`.

The strict parser and recipient check can stay. Commodity support needs a protocol change when that module lands, as the response says.

## Summary

| Item | Status                                                                                        |
| ---- | --------------------------------------------------------------------------------------------- |
| F1   | Fixed                                                                                         |
| F2   | Fixed                                                                                         |
| F3   | Fixed                                                                                         |
| F4   | Fixed for engine calls; proof-verification throws remain (N1)                                 |
| F5   | Scenarios unreachable in the current engine                                                   |
| New  | N1 Medium (conditional, one `try`/`catch`); N2 and N3 Low, documentation or confirmation only |
