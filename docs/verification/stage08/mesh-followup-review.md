# Stage 08 WebRTC transport follow-up review

**Verdict:** The identity binding still holds, and signed envelopes close the unauthenticated-signaling kill paths from the prior review. The remaining serious problems are in the **attempt lifecycle**. Two independent traces can leave a pair of peers permanently unconnected with no timer left to recover them. Neither the fakes nor the iframe smoke can show this, because every loss they model is symmetric and instantaneous.

The second group is **liveness and backpressure false-failures on slow paths**. The third is a **silent negotiation wedge** when an early ICE candidate is rejected.

I did not run anything. This review reads the source and the recorded smoke evidence only.

---

## Status of prior findings

| #   | Prior finding                        | Status                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Late PONG kills link                 | **Fixed.** Any PONG with `1 ≤ seq ≤ pingSequence` is accepted, and miss counting pauses while the local `game` buffer is above low water or while disconnected. A residual problem on the peer→us direction is new finding 5.                                                                                                                                                                    |
| 2   | Unauthenticated signaling kills link | **Fixed at the transport.** `verifySignalEnvelope` runs before any state change, and the `hint` must equal `body.from`. `PeerLink` now drops stale input instead of failing. Two residuals: the swallow-everything `catch` now hides real failures (finding 3), and signed-but-not-fresh offers still change state (finding 1).                                                                  |
| 3   | `bulk` overtakes HELLO               | **Fixed.** `READY` gates `bulk` drain.                                                                                                                                                                                                                                                                                                                                                           |
| 4   | HELLO while not `stable`             | **Partly fixed** with a single pending slot. Residual: finding 7.                                                                                                                                                                                                                                                                                                                                |
| 5   | Both peers offer                     | **Fixed.** Inbound links are `answer-only` until authenticated.                                                                                                                                                                                                                                                                                                                                  |
| 6   | ICE restart unreachable              | **Fixed.** Miss counting pauses while `disconnectedSince` is set, with a 15 s cap.                                                                                                                                                                                                                                                                                                               |
| 7   | Reassembly expiry                    | **Fixed.** Expiry is now idle-based and `ping` calls `fail('reassembly-timeout')`.                                                                                                                                                                                                                                                                                                               |
| 8   | Callback failures                    | **Fixed.** `onAuthenticated` now fails closed, and the transport isolates its own listeners.                                                                                                                                                                                                                                                                                                     |
| 9   | `maybeAuthenticated` after `fail`    | **Fixed.** Both guards are present.                                                                                                                                                                                                                                                                                                                                                              |
| 10  | Lower-severity items                 | The early-candidate cap is still global at 16. Failure reasons are now distinct (`hello-binding` vs `hello-authentication`), but the transport discards them (finding 9). The PING flood is now bounded by `control-backpressure`, which causes finding 4. The cross-package `virtual-clock` import remains. I cannot see `package.json`, so the unused `@cp2p/engine` dependency is unverified. |

## What holds up

- **Envelope verification.** It uses exact keys, validates the body before signing and verifying, and applies purpose separation (`p2p-signal` vs `p2p-hello`). It checks scope and recipient, requires the sender to be in the roster, and requires `hint === from`.
- **Plain signed data.** Outbound `RTCSessionDescription` is converted to a plain `{type, sdp}`. Inbound native objects fail `exact(…, ['type','sdp'])` because they have no own keys, so only plain data is ever signed or applied.
- **Retirement and notifications.** Retirement bookkeeping is bounded at 64 per roster peer. `emitDown` fires only for peers that were announced online, so replacing an unauthenticated attempt never emits a spurious down event. `broadcast` iterates a snapshot, so reentrant `onDown` is safe.
- **Replacement ordering.** `retireLink` deletes the record before calling `close()`, so `linkDown` no-ops for retired records. When a link is retired, any in-flight `negotiate()` or answer path stops at the `closed` check in `sendSignal`.
- **Framing bounds.** Per-channel queues are FIFO, so each channel has at most one in-flight partial at the receiver. The 2 MiB aggregate partial cap therefore matches the 1 MiB × 2 channels worst case exactly.

---

## Findings (highest impact first)

### 1. Same-origin retries are ordered by a random ID, and unopened links never time out: the pair can wedge permanently

**Where:** `web-rtc-transport.ts` `preferredAttempt`, `startLink`; `peer-link.ts` (no deadline before `channelOpened`)

`preferredAttempt` returns `attemptId < current.attemptId` when both attempts come from the same origin. Attempt IDs are random 128-bit strings, so a genuine retry replaces a stale attempt only about 50% of the time. Nothing expires the stale attempt:

- `HELLO_TIMEOUT_MS` starts only when the channels open.
- `attemptTimeoutMs` defaults to `undefined`, and both harnesses omit it.
- An answer-only link whose ICE never starts stays in `new`/`checking` indefinitely.

**Trace (honest network).** A < B, so A is the canonical initiator.

1. A's authenticated link drops, B's link also drops, and B has no record.
2. A retries with attempt X. B creates an answer-only record X and answers.
3. The answer is lost, or ICE cannot complete yet. A's link X reaches `failed`. A calls `linkDown` and then `scheduleRetry`, which sends attempt Y.
4. B's record X is still unauthenticated. Its channels never opened, so it has no timer. B accepts Y only if `Y < X`.
5. If `Y > X`, B drops the offer. A's link Y waits in `have-local-offer` with no remote description, so it never reaches `failed`. `links.has(B)` then blocks every further retry.
6. The pair stays down until someone manually calls `disconnect` and then `connect`.

**Trace (replay amplification).** A signaling server, or later a mesh-relay forwarder, has recorded A's signed offers from earlier sessions in the same `scope`.

1. B reloads, which clears its `retired` set.
2. The attacker delivers the captured offer with the smallest `attemptId`.
3. B creates an answer-only record for it. That record can never authenticate, because the old DTLS private key is gone, and it never expires.
4. Every genuine offer from A loses the comparison.

This is stronger than dropping signals. One replay on any path blocks the pair even while another path delivers honestly.

**Fix:**

- Add a signed, per-origin monotonic attempt order to `SignalEnvelopeBody`. For example, `epoch` (wall-clock ms at transport construction) plus a `seq` counter.
- Prefer the greater `(epoch, seq)` from the same origin, and keep a per-peer high-water mark so lower values are rejected as replays.
- Give every link record a pre-authentication deadline by default (about 30 s), including answer-only records. Let manual mode opt out explicitly only for the initiator's waiting offer.
- Optionally, accept at most one new attempt per peer per 250 ms. This bounds how fast an authenticated roster member can churn `RTCPeerConnection`s.

**Regressions to add:**

- A stale answer-only record plus a retry whose ID sorts higher must converge.
- A replayed older-epoch offer after a transport restart must be ignored.
- An unopened attempt must close after the deadline and trigger a retry.

---

### 2. One-sided loss deadlocks: an authenticated side drops the initiator's fresh offer, and the non-initiator never retries

**Where:** `web-rtc-transport.ts` `receive` (the `record?.link.isAuthenticated` check) and `linkDown` (`this.self < peer`)

**Trace.** A < B. The DataChannel path dies but the signaling server stays reachable, for example on a Wi-Fi to LTE handoff.

1. Both links go `disconnected`, so ping counting pauses on both sides. Each side's `disconnectedSince` comes from its own ICE observation, so the two can differ by one or two seconds.
2. A reaches `disconnected-timeout` first. It closes its connection, but the close is lost on the dead path.
3. A calls `linkDown` and schedules a retry 250 ms later. The fresh offer Y reaches B through the server.
4. B's old link still reports `isAuthenticated`, so B drops Y silently.
5. B then times out, calls `linkDown`, and does not retry because it is not the initiator.
6. A's link Y sits in `have-local-offer` forever (finding 1), and `links.has(B)` suppresses further retries.
7. The pair is permanently down with no timer pending.

The smoke's `forceLoss` and the fake `Fabric.close` both close both ends in the same instant, so neither can produce this ordering.

**Fix:** With the signed monotonic order from finding 1, an honest peer only issues a higher `(epoch, seq)` after abandoning its old link. So a verified fresh offer is evidence that the peer abandoned the old one.

- Retire the authenticated link, emit `false`, and accept the new attempt.
- Keep the initiator's default attempt deadline so that an offer lost in transit is retried.

**Regression:** Using a fabric that can close one endpoint, fail A's link first, deliver A's retry to B while B is still authenticated, and assert the peer reconnects once with events `[true, false, true]`.

---

### 3. Early-candidate drain runs before the answer; one rejected candidate, or any SRD/SLD error, silently wedges the handshake

**Where:** `peer-link.ts` `receiveSignal`, description branch and the final `catch`

With real asynchronous `setRemoteDescription` taking tens of milliseconds and trickle ICE, candidates for revision 1 usually arrive while SRD(offer) is pending. They go to `earlyCandidates` because `acceptedRemoteRevision` is still −1.

**Trace:**

1. After SRD resolves, the loop runs `await addIceCandidate(c)` for each early candidate _before_ `setLocalDescription()`.
2. If any candidate rejects, the whole block exits into the catch-all.
3. Candidates can reject for several reasons: an end-of-candidates form a browser does not accept (the prior unknown about older Safari and `null`), a Firefox `''` end marker, or an `sdpMid`/ufrag mismatch.
4. The answer is never created. The link stays in `have-remote-offer`, no channels open, and no timer runs (finding 1).
5. The initiator waits forever as well.

The same `catch` also swallows SRD and SLD failures on a signed offer from a legitimate peer, even though `negotiate()` fails closed on the same class of error.

**Fix:**

- Order the answer path as SRD, then SLD, then send the answer, then drain candidates.
- Drain each candidate in its own `try/catch` that ignores the error, as in MDN's `ignoreOffer` handling.
- Now that every input is signed by the peer, SRD/SLD failures on a non-stale description should call `fail('negotiation-error')`.
- Keep `return` only for stale, foreign, or fingerprint-mismatched input.

**Regression:** A fake whose SRD resolves on a later macrotask, with a candidate delivered during the SRD and an `addIceCandidate` that rejects once. Assert the answer is still signaled and the link authenticates.

---

### 4. Sustained `game` sends can trigger `control-backpressure` on any PING or PONG

**Where:** `peer-link.ts` `drain` vs `sendControl`

`drain` checks `bufferedAmount <= SEND_HIGH_WATER` _before_ each send, so it always ends above the mark whenever the queue holds more than 1 MiB. A single 1 MiB `Transport.send` produces 65 frames totalling 1,049,096 bytes. Frame 65 is sent at exactly 1,048,576, which leaves `bufferedAmount = 1,049,096 > HIGH`.

Each refill triggered by `bufferedamountlow` ends in the range (HIGH, HIGH + 16 KiB]. During that window, both of these fail the link:

- this side's own `ping()`, which calls `sendControl(PING)`;
- this side's reply to the peer's PING, which calls `sendControl(PONG)`.

Both hit `fail('control-backpressure')`. On TURN or mobile paths the window lasts roughly 100 ms per refill, so this is a periodic false failure, not a theoretical one. The smoke sent its 1 MiB payload on `bulk`, so it never loaded `game`.

**Fix:**

- In `drain`, send a frame only if `bufferedAmount + frame.byteLength <= SEND_HIGH_WATER`, or if `bufferedAmount === 0` so progress is always possible.
- Fail controls only above a hard cap, such as `HIGH + 64 KiB`.

**Regression:** Queue 1 MiB on `game` with a fake that does not drain synchronously, advance the clock 2 s, and assert the link is still authenticated.

---

### 5. Liveness ignores inbound traffic, so a peer's large `game` send times us out

**Where:** `peer-link.ts` `ping` and `receive`

**Trace:**

1. The peer sends us 1 MiB on `game` over a link of about 1 Mbps, which takes about 8.4 s.
2. The peer's `PONG` sits behind that data in its SCTP buffer.
3. Our own `game.bufferedAmount` is small, so our misses count at roughly +4, +6 and +8 s.
4. We hit `ping-timeout` while frames are still arriving steadily.

Findings 4 and 5 are two sides of the same slow-link scenario.

**Fix:** Any valid authenticated inbound frame or control resets `missedPongs` and `awaitingPong`.

**Regression:** Deliver one frame every second with no PONG and assert no `ping-timeout`.

---

### 6. The answerer drops candidates that arrive before the offer

**Where:** `web-rtc-transport.ts` `receive`

With no record, or a record for a different attempt, any non-offer blob returns early. `PeerLink`'s early-candidate buffer only covers candidates that arrive after the record exists. This makes in-order delivery an unstated requirement on every adapter.

The requirement fails in two places:

- Mesh relay and multi-path delivery can reorder.
- The Playwright bridge runs each `cp2pSignalSend` as a separate `destination.evaluate` containing `await import(...)`, while `PeerLink.sendSignal` fires sends without awaiting them. Nothing in that path guarantees order.

Peer-reflexive discovery usually hides the lost candidates, but not in relay-only mode.

**Fix:** Either document and enforce per-pair FIFO ordering in the adapter contract, or buffer a few verified candidates per unknown attempt with a short TTL. A good bound is 8 candidates for 1 unknown attempt per peer, expiring after 5 s.

---

### 7. A pending HELLO still fails on the peer's normal follow-up traffic

**Where:** `peer-link.ts` `receiveControl`, the pending-HELLO path

A sends HELLO while `stable` and then leaves `stable`, for example through `restartIce` or an incoming offer. B verifies HELLO_A and authenticates. B's HELLO then reaches A and goes into the pending slot. After that:

- B's application data fails at A with `preauth-data`.
- B's PING after 2 s fails at A with `invalid-control`.
- Four or more pre-auth controls fail at A with `unauthenticated-limit`.

This is rare, but it is deterministic when it happens.

**Fix:** Record the binding used in this side's own HELLO as `sentBinding`, and verify the peer's HELLO against it without waiting for `stable`. `checkCurrentBinding` already covers any later change. This removes the pending path entirely.

---

### 8. Verified envelopes are returned by reference

**Where:** `signaling-envelope.ts` `verifySignalEnvelope`

The function returns the adapter's own object, and `PeerLink` reads it again after an `await`. An adapter that yields getter-backed or later-mutated objects can therefore diverge from the bytes that were verified. Today only local adapters construct these objects, so this is defense in depth.

**Fix:** Verify the canonical encoding and return a decoded or `structuredClone`d, frozen copy.

---

### 9. Lower severity

- **Binding failures are invisible.** `onDown` reasons are discarded by the transport, so a `hello-binding` failure cannot drive the §1 security warning. The retry loop also silently re-dials a MITM'd path every 4 s or less. Surface the reason, for example via `onPeerChange(peer, false, reason)` or a diagnostics event.
- **Unbounded revision set.** `ignoredRevisions` grows without bound under a signed peer's offers during glare. Keep only the latest entry.
- **Envelope larger than the planned server frame.** `MAX_ENVELOPE_BYTES = 70_000` exceeds the planned 64 KiB server frame before JSON overhead is added. Real SDPs are small, but the caps should nest: 60,000 or less for the SDP.
- **Other browsers' candidate objects.** Chrome's candidate `toJSON()` output passed `signSignalEnvelope`. Whether `canonicalEncode` accepts Firefox/WebKit variants (`usernameFragment: null`, `''` end markers) is unknown. A rejection there becomes a synchronous `fail('signal-error')`.
- **Suppressed pre-auth negotiation.** An answer-only link suppresses `negotiationneeded` until it authenticates. A `restartIce()` requested before authentication is therefore lost, since the browser will not re-fire the event. The 10 s HELLO timeout bounds the damage. Worth a comment.

---

## Test fidelity: what the fakes hide

- **Answer delivery is never exercised.** The transport `Connection` fake never leaves `stable`. It pre-seeds `currentRemoteDescription` with the correct peer fingerprint and wires channels as soon as both endpoints exist. Authentication therefore succeeds even if the answer is never delivered, so glare, lost answers and SDP-dependent binding are not exercised at the mesh level.
- **Signaling runs synchronously.** `InProcessSignaling` delivers inside the sender's call stack, in order and without loss, which hides findings 3 and 6. `Channel.close()` propagates to the peer instantly and `Fabric.close` is symmetric, which hides finding 2.
- **Transport scenarios with no test:**
  - attempt timeout;
  - same-origin retry preference (finding 1);
  - retired replay;
  - `hint ≠ from`;
  - wrong scope reaching the transport;
  - larger-peer explicit `connect` racing the canonical initiator;
  - `disconnect` then `connect`.
- **`settle()` is timing-fragile.** It runs a fixed 30 microtask turns, so tests pass or fail on microtask depth rather than on state.
- **The MITM test is one-sided.** It still tampers only with the left side's remote SDP. The acceptance criterion asks for a transport-level fake adapter that swaps fingerprints on both legs.
- **The Playwright e2e test has a start race and has never run.** It starts all four pages in parallel. Offers that reach a page before its `start()` registers a listener are dropped by `receiveSignal` (the listener set is empty), and with no attempt timeout the initiator then waits forever. The iframe smoke avoids this with `queuedSignals`; the Playwright bridge has no equivalent.

**Suggested harness changes:**

- A fake RTC whose SRD/SLD resolve on a later macrotask, with real `signalingState` transitions, whose channels open only after both sides have applied matching descriptions.
- A signaling fabric with delay, reorder and drop controls.
- One-sided close.

The planned `node-datachannel`/`werift` integration would cover most of this.

## Evidence scope

The recorded smoke shows that native Chrome in one tab, with four same-origin iframes, completes the HELLO/DTLS binding, delivers 1 MiB on `bulk`, and recovers once from a symmetric forced loss.

It does not cover:

- isolated contexts;
- Firefox or WebKit;
- glare or ICE restart;
- one-sided or asymmetric loss;
- reordering;
- sustained `game` load;
- TURN.

The server, manual-code and mesh-relay adapters, SDP minimisation, ICE/TURN settings, `stats()` and diagnostics are not implemented. `InProcessSignaling` is a test route only. None of the Stage 08 acceptance criteria can be checked off yet.
