# Stage 08 WebRTC reconnect: follow-up review of F1–F9

I read the supplied source only. Nothing was executed, and no browser result applies to this code.

**Verdict:** F3–F8 are fixed in code. F1 and F2 are fixed for honest ordering and for stalled links. However, the mechanism that fixes F2 opens a new kill path:

- An offer from a session the responder has never seen is treated as fresh.
- That offer immediately retires a live authenticated link.
- Without clocks, "never seen" does not mean "new". After any responder reload, every old signed offer in the same scope qualifies.

Three of the new regressions do not discriminate the bug they are named for.

---

## Status of F1–F9

| #   | Status                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Holds, with residual D1**                        | Freshness uses a signed `sessionId` plus `attemptSeq`. The per-peer high-water mark holds up to 64 sessions, LRU. It uses no wall clock and does not compare random IDs. The 30 s deadline covers answer-only records. Its regression does not discriminate (T3).                                                                                                                                         |
| F2  | **Holds, with residual D1**                        | A fresh canonical offer retires a one-sided authenticated link. `failOneSide` models a truly asymmetric closure. The test fails without the fix, because the left side would stay `[true,false]` at +250 ms.                                                                                                                                                                                              |
| F3  | **Holds**                                          | The order is SRD → SLD → send answer → drain early candidates, with a `try/catch` per candidate. SRD/SLD errors on signed input now `fail('negotiation-error')`, which closes the attempt. `holdNextRemoteDescription` plus `rejectNextCandidate` does discriminate.                                                                                                                                      |
| F4  | **Holds**                                          | `drain` never goes above `SEND_HIGH_WATER`. Controls have a separate hard cap at HIGH + 64 KiB. The test's `bufferedAmount ≤ 1 MiB` assertion discriminates the overshoot.                                                                                                                                                                                                                                |
| F5  | **Holds in code; test does not discriminate** (T1) | Frames, PINGs, READY and PONGs all call `seenInbound()`.                                                                                                                                                                                                                                                                                                                                                  |
| F6  | **Holds**                                          | One pending attempt per peer, 8 candidates, 5 s TTL. The flush happens after the offer's synchronous prefix, so the candidates land in `PeerLink`'s own early queue. The test discriminates the cap.                                                                                                                                                                                                      |
| F7  | **Holds in code; test does not discriminate** (T2) | A HELLO is checked against `sentBinding` as soon as this side has sent its own. The pending slot is used only before that.                                                                                                                                                                                                                                                                                |
| F8  | **Holds**                                          | `structuredClone` runs before validation. The detached copy is the one that is both verified and returned. Getters are snapshotted and proxies or class instances are rejected. The mutation test discriminates.                                                                                                                                                                                          |
| F9  | **Partly fixed**                                   | Fixed: `onDiagnostic` exists; `hello-binding` and `fingerprint-changed` stop redial on both roles; `ignoredRevision` is a single max value. Still open: `MAX_ENVELOPE_BYTES = 70_000` is larger than the planned 64 KiB server frame; non-Chrome candidate `toJSON()` shapes through `canonicalEncode` are untested; `restartIce` on an answer-only link before authentication is still silently dropped. |

### Confirmed as requested

- **Bounded state:** `retired`, `offerHighwater`, `earlyCandidates`, `lastReplacement` and `retries` are all keyed by roster peer and each is capped.
- **Replacement rate:** limited to 250 ms per peer.
- **Liveness sources:** listed under F5 above.
- **Fake needs both SDP directions:** the fake connection sets `negotiated = localSet && remoteSet`, and this is required on both ends. The initiator's `remoteSet` only becomes true once the answer is applied. The pre-seeded `currentRemoteDescription` is harmless because channels cannot open before `wire()`.

---

## New defects

### D1. A replayed old-session offer tears down a live authenticated link (high)

**Where:** `web-rtc-transport.ts` `receive`, the `!matches` offer branch.

**Why it happens:**

- `freshOffer` returns `true` for any `sessionId` that is missing from the responder's high-water map.
- That map is per transport instance, capped at 64, and empty after a reload.
- Nothing checks whether `record` is authenticated before `retireLink(from)` runs.

**Trace.** A < B. A signaling adversary (the §1 threat model, and later a relay forwarder) has recorded any earlier A→B offer in this scope, from any A session that B's current instance has not seen.

1. B reloads (the normal stage-10 case) and re-authenticates with A's current session.
2. The adversary delivers the recorded offer.
   - Scope, recipient, sender and signature all verify.
   - `retired` is empty. `freshOffer` is true. `previous` is undefined.
3. B retires its authenticated link and emits `false`.
4. B creates an answer-only record. That record can never authenticate, because A drops the answer as a non-matching attempt.
5. A sees its channels close and retries 250 ms later.
6. If the next replay arrives within 250 ms before A's genuine offer, the genuine offer is dropped by the rate limit, and A sits out its full 30 s deadline.

**Impact:**

- The budget is one kill per stored `(session, seq)`. It resets on every B reload.
- With more than 64 stored sessions it becomes unbounded, because they cycle through the LRU.
- This restores the kill path that signed envelopes were meant to close.
- A replay can also evict honest candidates from the single early-candidate slot. This is minor.

**Minimal fix: make-before-break.**

- The core problem is that freshness of an unseen session cannot be proven without a clock, so accepting a stale offer has to be made harmless.
- When the current record is authenticated, or its channels have opened, run the new offer in a single `pending` slot per peer instead of retiring the current record.
- Routing: `matches` checks the current record and the pending record.
- Deadline: the pending record gets the normal attempt deadline and the rate limit.
- On success: in `onAuthenticated`, retire the old record, emit `false`, promote the pending record, and emit `true`.
- On failure: if the pending record fails, only the pending slot is cleared.
- If the old link really is dead, its own ping or disconnect timeout still removes it.
- Why this is safe: a replayed offer cannot pass HELLO, because the nonces are fresh, so it can never displace a working link. The F2 test's expected `[true,false,true]` still holds.

**Regression:**

1. Capture an offer from a throwaway transport that uses A's identity.
2. After the main pair authenticates, deliver the captured offer to B from A's endpoint.
3. Assert B stays authenticated with no down event.
4. Assert that after 30 s the pending attempt closes and the live link is untouched.

### D2. Rate-limited offers are dropped, not deferred (medium)

**Where:** `receive`, the `REPLACEMENT_INTERVAL_MS` check.

**Problem:**

- An honest offer that arrives less than 250 ms after any replacement is discarded silently. The cause can be a replay, as in D1, or relay jitter compressing X and Y.
- The initiator then waits the whole 30 s deadline.

**Fix:**

- Keep one deferred fresh offer per peer (the latest arrival), together with its early candidates.
- Re-run acceptance, including freshness, when the interval expires.

**Regression:** Send two fresh offers 100 ms apart. Assert the second is applied at about 250 ms, not at 30 s.

### D3. A local fingerprint-parse failure is reported as a MITM and blocks the peer permanently (medium)

**Where:** `peer-link.ts` `receiveControl`, the line `if (!this.sentBinding || …) fail('hello-binding')`.

**Problem:**

- In `stable` state, `sentBinding` can only be null when `fingerprintBinding()` failed to parse.
- Parse failures come from an uppercase `SHA-256` token (the token is case-insensitive per RFC 8122), `sha-384`, or a session/media conflict.
- The transport then calls `manualDisconnects.add(peer)` on both roles and shows a security warning, although no binding comparison ever happened.
- Whether werift or libdatachannel produce such SDP is unknown.

**Fix:**

- Fail with a distinct, non-security reason such as `fingerprint-unsupported` when `sentBinding` is null.
- Reserve `hello-binding` for a real mismatch between two computed bindings.
- Make the `sha-256` match case-insensitive.

### D4. The Playwright start race will fail the unrun e2e test (medium, harness)

**Where:** `apps/web/tests/webrtc-transport.e2e.ts` and `web-rtc-browser-harness.ts` `receiveSignal`.

**Problem:**

- All four `start()` calls run concurrently.
- An offer that reaches a page before that page registers its listener is dropped, because the listener set is empty.
- The retry now arrives only after 30.25 s, but the poll gives up at 20 s.
- The iframe smoke avoids this with `queuedSignals`; this harness has no equivalent.

**Fix:** Either buffer inside `receiveSignal` until a listener exists, or split the harness into two phases: `create` (constructs the transport and subscribes) and `begin` (calls `transport.start()`).

### D5. Manual answerer still gets a 30 s deadline (low–medium)

**Where:** `startLink`, the `timeoutMs` computation.

**Problem:**

- `attemptTimeoutMs: null` exempts only records where `origin === self`.
- In the manual flow, the joiner's answer-only record waits on a human scanning a QR code, yet it closes at 30 s even when the setting is `null`.
- The adapter is out of scope for this packet, but the timeout policy is in it.

**Fix:** Give manual attempts a finite, longer deadline (minutes) that applies to both roles, rather than `null` for the initiator only.

### D6. Diagnostics fidelity (low)

- **Misleading reasons:**
  - An attempt deadline reaches `onDiagnostic` as `'closed'`, because `link.close()` runs with no reason. Pass `'attempt-timeout'` instead.
  - A reassembly expiry detected inside `accept` becomes `'invalid-frame'`, while the same expiry detected from `ping` becomes `'reassembly-timeout'`.
- **No security classification:** `onDiagnostic` does not mark which reasons are security failures. Export a reason set or a `security` flag, so the UI does not have to match strings.
- **One-sided detection:** the §1 warning is local only. If A's `pc.close()` aborts SCTP before its HELLO is flushed, B sees `channel-closed` or `hello-timeout` instead. If B is the initiator, it keeps redialing about every 34 s and never shows a warning.

---

## Regressions that don't discriminate

**T1.** _"steady inbound game frames prevent false ping timeout without PONGs"_

- **Problem:** Only PONGs are dropped. Right's own PINGs still arrive every 2 s and call `seenInbound()`, so the test passes even if frames never reset liveness. In the F5 scenario the peer's PINGs are queued behind its data too, so frames are the path that actually matters.
- **Fix:** Drop `"PING"` from right's control sends as well.

**T2.** _"a delayed HELLO is checked against our sent binding during later negotiation"_

- **Problem:** The old code, which parked the HELLO until `stable`, also passes this test.
- **Fix:** Assert `f.left.isAuthenticated === true` before restoring `stable`. Also advance 2 s so that right's PING reaches left while it is still in `have-local-offer`, and assert no `invalid-control`.

**T3.** _"…regardless of random ID order"_

- **Problem:** With `descendingIds`, the retry ID Y (`0xFB…` encodes to `-_v7…`) sorts below X (`0xFD…` encodes to `_f39…`). The old "prefer smaller ID" rule therefore accepts it.
- **Fix:** Parametrize the test over both orders with `test.each([false, true])`.

## Missing regressions

- The D1 replay-after-reload test and the D2 rate-limit deferral test.
- Transport-level cases:
  - `hint ≠ from`;
  - a lower `attemptSeq` replayed in the same session;
  - a replay of a retired `attemptId`.
- One-sided failure on the **responder** side. Recovery depends on the initiator's ping timeout, about 6–8 s plus 250 ms; assert it.
- Expiry of an answer-only record whose answer was dropped, with the initiator configured with `attemptTimeoutMs: null`. The current timeout test covers only the initiator's record.
- A signed offer whose SRD or SLD rejects. Assert `negotiation-error`, a diagnostic, and a retry from the initiator.
- Delayed negotiation at the **mesh** level:
  - The transport fake still resolves SRD/SLD in microtasks.
  - Signaling is synchronous.
  - `settle()` is still a fixed 30 turns.
  - Replacement while SRD/SLD is in flight, and early-candidate flush under a slow SRD, are covered only at the `PeerLink` level.

## Evidence scope

The iframe smoke pins older source. It shows symmetric loss only, in four same-origin globals in one Chrome tab. It is not evidence for any change reviewed here, and no browser acceptance can be claimed for this packet.
