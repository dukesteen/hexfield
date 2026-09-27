# Stage 08 PeerLink review: authenticated WebRTC transport slice

**Verdict:** The identity binding itself holds up. The main risks are availability and deterministic false-failure bugs:

- A stale PONG kills a healthy link.
- Unauthenticated signaling can tear down or wedge an authenticated link.
- `bulk` data can overtake `HELLO` across SCTP streams.
- The glare test's fake cannot show the behaviour it claims to cover.

I found no path that lets a signaling-level attacker substitute a DTLS identity. This review is based on reading the source only; nothing was executed.

---

## What holds up

These are sound as written, so I don't re-argue them below:

- **Binding construction.** Each side hashes `{self: fp(currentLocal), peer: fp(currentRemote)}`, sorted by code-unit `PeerId`.
  - Suppose a MITM substitutes its own certificates on both legs (M1 toward A, M2 toward B). Then A signs `{A:fpA, B:M1}` and B signs `{A:M2, B:fpB}`. These can only match if M1 = fpB and M2 = fpA, which means the MITM would already hold both private keys.
- **Freshness.** Both 32-byte nonces are assigned per identity inside a purpose-separated signature, and `nonceTo === this.nonce` is required. Replaying an old HELLO fails. Reflecting A's own nonce back to A gains nothing without B's key.
- **Key and constructor hygiene.** The constructor checks that the key matches `self`, copies and zeroes `secretKey`, and cleans up if construction fails partway.
- **Pre-auth input bounds.** Binary data before authentication fails the link. Control bytes are counted in UTF-8. The per-message cap is 2 KiB and the total is 4 messages / 4 KiB.
- **Frame validation.** `MessageFramer.accept` validates `count`, `index` and sizes before it allocates anything per message. The `count` cap is 65 and the 1 MiB per-message and 2 MiB aggregate totals are enforced.
- **Send path.** `drain` stops above the 1 MiB high-water mark and resumes on `bufferedamountlow`. The watermarks are consistent, so the low event is guaranteed to fire after a pause.

---

## Findings (highest impact first)

### 1. A late PONG kills a healthy link with `invalid-control`

**Where:** `peer-link.ts`, `receiveControl` / `ping`

**Trace:**

1. At t=2000, `ping()` sends `PING{1}` and sets `awaitingPong=true`.
2. The peer's `PONG{1}` takes more than 2 s. This happens when it sits behind about 1 MiB in either direction of the ordered `game` stream, which is where all `Transport` traffic goes.
3. At t=4000, `ping()` sets `missedPongs=1`, sends `PING{2}`, and sets `pingSequence=2`.
4. `PONG{1}` arrives. The PONG branch requires `sequence === pingSequence`, so it falls through to `this.fail('invalid-control')`.

**Impact:**

- A single RTT above 2 s drops an honest peer and labels it a protocol violation.
- The Stage 08 acceptance check "1 MiB message transfers with backpressure" puts about 1 MiB in the channel buffer ahead of the PING. On any path below roughly 4 Mbps (TURN, a phone hotspot) that is enough to trigger this.

**Fix:**

- Accept any safe-integer PONG with `1 ≤ seq ≤ pingSequence`.
- Any such PONG should reset `missedPongs` and `awaitingPong`, because any reply proves liveness.
- Ignore stale PONGs rather than failing the link.
- Separately, consider not counting a miss while this side's own `game` queue or `bufferedAmount` is above the low-water mark.

---

### 2. Unauthenticated signaling can kill or wedge an authenticated link

**Where:** `peer-link.ts`, `receiveSignal`

`receiveSignal` accepts `SignalBlob`s with no origin authentication and changes link state based on them. Signaling blobs are unsigned for every adapter; the planned relay signing covers only mesh relay. So whoever feeds `receiveSignal` can cause the failures below: the signaling server, a relay forwarder, or possibly any room member. Whether a room member can forge `from` depends on the server, which I haven't seen.

All four traces run against an already-authenticated link:

- **Junk candidate at any revision.** Send `{kind:'candidate', generation:g, revision:1, candidate:{candidate:'x'.repeat(5000)}}`.
  - Validation runs before the stale-revision filter, so it throws.
  - The `catch` then runs `fail('signaling-error')`.
  - An `addIceCandidate` rejection for an unknown `sdpMid` takes the same path.
- **Oversized revision plus bad SDP.** Send `{kind:'description', revision:2**53-1, description:{type:'answer', sdp:'x'}}`.
  - `remoteRevision` is set to the maximum.
  - `setRemoteDescription` throws, and the link fails.
- **Polite side, stable state.** Send a well-formed offer carrying the attacker's fingerprint.
  - It is applied and answered.
  - `signalingstatechange` then runs `checkCurrentBinding`, which fails with `fingerprint-changed`.
  - A variant with the attacker's ICE credentials redirects ICE instead.
- **Wedge instead of kill.** Deliver an offer with `revision: MAX` while the impolite side has an offer in flight.
  - It is ignored silently, but `remoteRevision` is already `MAX`.
  - The legitimate answer (for example rev 3) is then dropped by `revision <= remoteRevision`, and negotiation hangs.

**Impact:**

- The design says relays "can delay or drop" signaling. In practice they can also tear down established DataChannel links mid-game at will.
- Dropping signaling alone could not do that.

**Fix (the proper one):** Sign each signal blob with the sender's identity key. Cover `{scope, from, to, generation, revision, payload}` and verify it before any state change.

**Fix (minimum for this slice):**

- Malformed, stale or foreign blobs should `return`, not `fail`.
- Advance `remoteRevision` only after `setRemoteDescription` succeeds, or after a structural-validity check in the ignore branch.
- Once authenticated, parse an incoming description with `applicationFingerprint` and refuse it before applying if it would change `verifiedBinding`.

---

### 3. `bulk` frames can overtake `HELLO` and trigger `preauth-data`

**Where:** `peer-link.ts`, `receive` / `send`

**Trace:**

1. B sends `HELLO_B` on the `game` stream (SCTP stream 0).
2. B receives `HELLO_A` and authenticates; `onAuthenticated` runs.
3. The caller runs `link.send(x, 'bulk')`, which puts a frame on stream 1.
4. `HELLO_B`'s packet is lost and retransmitted. SCTP orders messages only within a stream, so A receives the stream-1 frame first.
5. A is still `!authenticated`, so it calls `fail('preauth-data')`.

**Scope:** `Transport` currently routes only to `game`, so exposure is through the public `PeerLink.send(..., 'bulk')` API. The `game` channel is safe, because ordering guarantees the peer's HELLO precedes its data.

**Fix:** When a side authenticates, it sends a `READY` control on `game`. The peer keeps its `bulk` queue paused until it receives `READY`.

---

### 4. Signaling state gates HELLO asymmetrically

**Where:** `peer-link.ts`, `trySendHello` / HELLO branch of `receiveControl`

- **Sending:** `trySendHello` waits while not `stable` and retries on `signalingstatechange`.
- **Receiving:** a HELLO that arrives while not `stable` gets `binding === null` and fails immediately with `hello-authentication`.

**Trace:**

1. Before authentication, the connection goes `disconnected`.
2. After 5 s, `restartIce()` runs and fires `negotiationneeded`, so this side enters `have-local-offer`.
3. The peer's HELLO arrives during that renegotiation and the link fails.

**Impact:** This is rare because it needs a network blip during the 10 s handshake. The failure is deterministic once it happens, and it is reported as a security failure.

**Fix:** Keep at most one pending HELLO (it is already capped at 2 KiB) and verify it on the next `stable` state, still within `HELLO_TIMEOUT_MS`.

---

### 5. Both peers always offer, so the one-round manual flow breaks for about half of pairs

**Where:** `peer-link.ts`, `attachListeners` / `negotiate`

**Trace:**

1. Creating the first data channel fires `negotiationneeded` on both sides, and each side calls `negotiate()` unconditionally. Every link therefore starts in glare.
2. Perfect negotiation resolves this when both offers are delivered. The manual flow (§2.1: inviter offer, joiner answer, no third message) does not deliver both.
3. Take a joiner whose `PeerId` sorts after the inviter's, so the joiner is impolite. It is already in `have-local-offer` when the pasted offer arrives.
4. It computes `collision && !polite`, ignores the offer, and never produces an answer code.

**Caveat:** This only works if the caller constructs the link and calls `receiveSignal(offer)` in the same task, before `negotiationneeded` is dispatched. Nothing in the API enforces or documents that.

**Why it belongs to this slice:** The later manual adapter cannot fix this without changing `PeerLink`.

**Fix:** Add a role option (`initiator: boolean`, or `offerMode: 'auto' | 'answer-only'`). An answer-only link suppresses `negotiate()` until its first remote description has been applied.

---

### 6. ICE restart is effectively unreachable after authentication

**Where:** `peer-link.ts`, `connectionChanged` vs `ping`

**Trace:**

1. Traffic stops at t0.
2. The ping monitor fails the link with `ping-timeout` about 6–8 s after the last PONG.
3. The browser typically reports `disconnected` a few seconds after t0. The 5 s grace timer then calls `restartIce()` at roughly t0+7.5 s or later, and a signaling round trip plus ICE checks follow.
4. `ping-timeout` usually wins, so the link is rebuilt from scratch instead of restarted.

**Assessment:** The doc specifies both the grace timer and the ping timeout, so this is a spec inconsistency surfaced by the code.

**Fix:** While `connectionState` is `disconnected` or a restart is in flight, pause missed-pong counting, with an overall cap (for example 15 s).

---

### 7. Partial reassembly expires from the first chunk and loses messages silently on a live link

**Where:** `framing.ts`, `accept` / `expire`

**Trace:**

1. `expires` is set once, at `now + 30 s` from the first chunk.
2. A 1 MiB message on a path below about 280 kbps (a poor TURN or mobile link) keeps sending chunks after 30 s.
3. `expire()` deletes the partial. The remaining chunks start a new partial that can never complete, and it expires 30 s later.

**Impact:** The link stays up and reports nothing, but a message accepted by `send` is lost. That contradicts "a later ... failure clears queued data and reports peer loss". On a reliable, ordered channel, an expired partial means either a protocol violation or a pathologically slow link.

**Fix:**

- Refresh `expires` on every accepted chunk, so the timeout measures idle time.
- Make expiry signal the link: `expire` returns a count, and `PeerLink.ping` or `receive` calls `fail('reassembly-timeout')`.

---

### 8. Callback failures are handled inconsistently, and one path fails open

**Where:** `peer-link.ts`, `maybeAuthenticated` / `receive`

- **`onAuthenticated` throws:**
  - The error is swallowed and the link stays authenticated.
  - It keeps delivering `onMessage` for a peer the mesh manager may never have registered.
  - It also keeps sending PINGs.
  - This fails open.
- **`onMessage` throws:** the link fails with `application-listener`. A local handler bug then looks like network loss, and the peer can trigger reconnect loops by sending whatever payload crashes the handler.

**Fix:** Fail the link when `onAuthenticated` throws. Keep `onMessage` failing closed, but give it a distinct reason so the manager does not auto-reconnect in a loop.

---

### 9. Latent: `maybeAuthenticated` can run after `fail`

**Where:** `peer-link.ts`, `trySendHello` → `maybeAuthenticated`

**Trace:**

1. `trySendHello` calls `sendControl`.
2. `game.send` throws, so `fail()` runs and sets `closed=true`.
3. Control returns and sets `helloSent = true`, then calls `maybeAuthenticated()`.
4. `maybeAuthenticated()` does not check `closed`. If `helloVerified` were already set, it would mark the link authenticated, arm `pingTimer`, and call `onAuthenticated` after `onDown`.

**Reachability:** Current ordering makes `helloVerified`-before-`helloSent` unreachable, so this is not exploitable today.

**Fix:** Add `this.closed ||` to the guard in `maybeAuthenticated`, and return early in `trySendHello` when `closed` is set after `sendControl`.

---

### 10. Lower-severity items

- **Early-candidate cap.** `MAX_EARLY_CANDIDATES = 16` is shared across all keys and drops silently. A host with several interfaces (IPv4/6 × UDP/TCP plus VPN or Docker) can exceed 16 when an adapter delivers candidates before the description. Injected future-revision candidates can also fill it. Consider capping per revision and preferring the lowest pending revision.
- **Locked remote generation.** `remoteGeneration` is fixed by the first description and later mismatches are ignored silently. If the remote reloads and starts generation g+1 while this link is still in `disconnected` grace, the new offers vanish and the manager gets no signal. Surface this, for example with an `onForeignGeneration` hook or a return value.
- **Misleading failure reasons.**
  - If the remote SDP's fingerprint cannot be parsed (for example sha-384, a session/media conflict, or an uppercase `SHA-256` token), `fingerprintBinding()` returns `null`, the HELLO is never sent, and the reason becomes `hello-timeout`.
  - Wrong scope, wrong identity, bad signature and binding mismatch all collapse into `hello-authentication`.
  - §1 requires a security warning specifically on binding failure, so these reasons need to be distinguishable.
- **Control sends bypass flow control.** `sendControl` writes directly to `game`, skipping the queue and `bufferedAmount` checks. An authenticated peer can flood PINGs and grow our send buffer until the browser rejects `send`. The only bound is that it is authenticated misbehaviour.
- **Pre-auth size cap applies after buffering.** The 2 KiB pre-auth cap is checked after the browser has already buffered a message up to its advertised `a=max-message-size`. Chrome advertises 256 KiB; Firefox advertises much more. This is unknown and probably acceptable, but it is not a hard pre-auth memory bound.
- **Reentrant `onDown`.** `send()` can call `onDown` from inside `drain`→`fail` before returning normally. `WebRtcTransport.broadcast` must tolerate its peer table changing mid-iteration.
- **Unused dependency.** `package.json` depends on `@cp2p/engine`, which is not used and is not in the design's dependency list.
- **Cross-package test import.** The tests import `../../protocol/src/testing/virtual-clock.js` across a package boundary.

---

## Test issues (misleading or missing)

**The glare test cannot exercise glare.** In `FakePc`:

- `signalingState` is always `'stable'`.
- `setLocalDescription` never changes `localDescription` or signaling state.
- There is no `have-local-offer` state and no rollback.

So the collision is detected only because `makingOffer` is held `true` by the gate. The real case — offer already applied, `makingOffer === false`, state `have-local-offer` — is never reached. The test also doesn't check that the polite side sends an answer or that the impolite side applies it.

**Other gaps:**

- **Fake channels deliver synchronously and in order across channels.** Finding 3 (cross-stream reordering) and finding 1 (delayed PONG) cannot be expressed.
- **Framing test names overstate coverage.** "round-trips … across channels" involves no channels. The input-mutation check cannot distinguish a copy from an alias when `size === 1`.
- **Items listed in the design's test plan that are not tested:**
  - wrong expected identity
  - wrong scope
  - unknown control type
  - the 4-message / 4 KiB unauthenticated limit
  - declared `count > 65`
  - a cumulative total over 1 MiB
  - the 2 MiB aggregate partial cap
  - expiry driven by `ping`
  - HELLO or data on `bulk`
  - ignored-offer candidates
  - ICE-restart revisions
- **The MITM test tampers with only one side's remote SDP.** It passes, but it does not model the symmetric fingerprint swap that the acceptance criterion describes.

---

## Explicitly not in this slice

These are not defects of this slice:

- `WebRtcTransport` / mesh management
- adapters (non-trickle gathering, SDP minimisation, codes and QR, server, signed relay)
- ICE/TURN settings, `stats()`, diagnostics
- Node `node-datachannel`/`werift` and Playwright integration

Findings 2, 5 and 10 (generation) are raised here because the adapters and mesh manager cannot fix them without changing the `PeerLink` API.

## Unknowns

I did not infer any of these; they need checking:

- Whether the future caller serialises `receiveSignal` calls, and whether it delivers a manual offer in the same task as construction.
- Whether the signaling server binds `from` to the authenticated join.
- Whether target browsers ever emit a non-`sha-256` or session+media-conflicting fingerprint. Chrome, Firefox and Safari normally emit `sha-256`: media-level in Chrome/Safari, session-level in Firefox, and the parser handles both.
- How older Safari treats `addIceCandidate(null)`.
