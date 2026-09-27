I did not create the plan file or call ExitPlanMode because you asked for no tools. This is a review only, with no implementation plan.

# Stage 08 signaling slice review

## Release-blocking

### B1. A peer cannot rejoin while its old socket is half-open

**Where:** `room-core.ts` (`join`) and `server.ts` (no heartbeat)

`join` rejects any peerId that is already in `room.peers` with `room-full-or-duplicate`. The Node host never pings clients, so a dead TCP connection stays in the room until the OS gives up or someone sends to it. That can take many minutes. With no traffic, it lasts until the 24 h idle sweep.

This happens on common events: a Wi‑Fi to cellular switch, a laptop sleeping, or NAT rebinding. The client reconnects every ≤4 s, gets rejected each time, and `send()` fails every 10 s. Even a clean client-side `lost()` can race the server's handling of the old socket's close.

**Repro:** in `RoomCore`, `const a = f.join(1)`. Don't call `disconnect(a.id)`. Open a new socket and send `signRoomJoin(ROOM, newChallenge, a.identity.secretKey)`. It closes with `room-full-or-duplicate`. The current test in `room-core.test.ts` asserts this as the desired behavior.

**Fix:**

- A new session that proves possession of the key with a fresh challenge should replace the old one:
  ```ts
  const existing = room.peers.get(peerId);
  if (existing) {
    room.peers.delete(peerId);
    this.sessions.delete(existing.id);
    try {
      existing.socket.close(1008, 'replaced');
    } catch {}
  }
  if (room.peers.size >= MAX_ROOM_PEERS) {
    this.reject(session, 'room-full');
    return;
  }
  ```
  Then admit the new session and announce once. This is safe because only the key holder can take over its own slot.
- Add a ws ping/pong heartbeat in `server.ts` (for example, ping every 15 s and `terminate()` if no pong arrives before the next tick).
- Change the test to assert replacement, and split the room-full and duplicate reasons.

### B2. The client does not pace to the server's 30 msg/s limit, so bursts are silently lost

**Where:** `server-signaling.ts` (`send`)

`send()` writes straight to the socket. Trickle ICE across a mesh easily bursts more than 30 frames per second. For example, 5 remote peers × (1 description + several candidates + a `null` end-of-candidates) is already over 30. The join frame also counts toward the limit.

The server then closes the connection with `rate-limit`. Every frame after the 30th is dropped, but the `send()` promises for those frames have already resolved. The loss is invisible to the transport.

This conclusion comes from the code. It was not observed in browsers.

**Repro:**

1. Get the adapter ready (challenge, then `peers`).
2. Call `adapter.send(...)` 31 times synchronously. `socket.sent` grows by 31 with no pacing.
3. Feed the join plus those 31 frames to one `RoomCore` session within one second. The session closes with `rate-limit` at the 30th signal.

**Fix:** add a client-side token bucket in `send()`, for example 20/s, which leaves headroom for the join. Queue excess sends using the existing waiter bound (`MAX_WAITERS`) and resolve each send only when it is actually written. Add a test that 31 rapid sends are spread across windows.

### B3. The forwarded frame is 2 bytes larger than the inbound one, so the server kicks the sender

**Where:** `room-core.ts` (`signal`) and `server-signaling.ts` (`send`)

The client checks the size of `{type,to,envelope}`. The server forwards `{type,from,envelope}`. Both use `JSON.stringify` and peerIds have the same length, so the forwarded frame is exactly 2 bytes longer (`"from"` vs `"to"`).

A frame of 65,535–65,536 bytes passes the client check and the server's inbound check. The server then rejects the sender with `wire-limit`. The client reconnects, and the message is lost even though `send()` resolved.

**Repro:**

```ts
const base = JSON.stringify({ type: 'signal', to: b.identity.peerId, envelope: '' }).length;
f.core.receive(
  a.id,
  JSON.stringify({ type: 'signal', to: b.identity.peerId, envelope: 'x'.repeat(65_536 - base) }),
);
// a closed 'wire-limit'; b receives nothing
```

**Fix:**

- In the client, measure the frame the server will actually forward: `JSON.stringify({ type: 'signal', from: this.options.self, envelope })`, and compare it to `SERVER_WIRE_LIMIT`.
- In the server, drop an oversize forwarded frame instead of punishing the sender, or share one exported "forwarded frame size" helper between client and server.

### B4. No test would catch missing signature verification (evidence gap)

**Where:** `room-core.test.ts`

The admission code looks correct. But if you delete the `verifyObject(...)` check, all nine tests still pass:

- The replay test fails on the challenge mismatch, not the signature.
- The duplicate test fails on the duplicate check.
- The "spoofing" case sends `{type:'join', body:{peerId}}`, which fails `exact()` and the already-joined guard.

No test covers these, so the headline security claim is unproven:

- a tampered `sig`,
- `body.peerId` = A signed by key B,
- a join for `OTHER_ROOM` presented on a `ROOM` session,
- a second valid join on an already-joined session.

**Fix:** add those four negative cases. Each should expect `invalid-join`, and each should fail if its specific guard is removed.

## Follow-on / integration

### F1. A stale `peers` list can arrive after a fresher one

**Where:** `room-core.ts` (`announce`)

`announce` builds `frame` once, then loops over peers. If one send fails, `reject → disconnect → announce` sends a newer list to the remaining peers. The outer loop then continues sending the old list (which still includes the removed peer) to later peers. Those peers end up holding stale membership.

This has low impact now because the adapter only uses `peers` to detect readiness. It will matter once the lobby or transport uses membership.

**Fix:** collect failed sessions during the loop, reject them after it, then announce once. Room expiry in `sweep` has the same shape: it announces to peers that are about to be expired, which is O(n²) sends.

### F2. The server is easy to exhaust with no per-client limits

**Where:** `server.ts`, `room-core.ts`

`MAX_SOCKETS = 256` is global:

- One client can hold 256 pending sockets, recycling them every 10 s.
- It can also join its own rooms with self-generated keys and hold the sockets for 24 h with no traffic.
- Anyone who knows a room ID can fill all 8 slots.

This is consistent with the "untrusted for availability" model, but the deployed default instance needs:

- per-IP connection caps (behind the TLS terminator, using a trusted forwarded header),
- a shorter idle limit for sessions that send nothing.

### F3. The client ignores close reasons and retries forever

**Where:** `server-signaling.ts` (`lost`)

The client retries every 4 s forever, even on `room-full`, `invalid-join`, or `rate-limit`. Nothing is surfaced to the UI, and there is no jitter, so every client reconnects in lockstep after a server restart.

**Fix:**

- Expose a status or error callback.
- Treat `room-full` as terminal, or back it off much further.
- Add ±25% jitter to the retry delay.

### F4. Envelope size contract mismatch with the WebRTC layer

**Where:** `signaling-envelope.ts`

`MAX_ENVELOPE_BYTES = 70_000` and `MAX_DESCRIPTION_BYTES = 65_536` are both larger than the 64 KiB wire. The envelope is also escaped twice: `\r\n` in SDP becomes `\\r\\n` in the wire frame, and every `"` becomes `\"`. So an SDP of roughly 30–35 KB can pass `validSignalEnvelopeBody` but hit the adapter's `RangeError`.

This fails fast and safely, but:

- the transport must treat that `RangeError` as non-retryable for this route,
- the envelope limit should be derived from the wire limit rather than set independently.

Typical data-channel SDP is a few KB, so this is not blocking. It is not verified across browsers.

### F5. The planned Cloudflare host can't use `RoomCore` as-is

`RoomCore` keeps sessions, challenges, and peerIds only in memory. The Durable Object hibernation API evicts that memory. The DO host will need per-socket attachment state, such as `serializeAttachment`, holding `{roomId, challenge, openedAt, peerId}`, or a core API that can rebuild state from it.

### F6. Tests that don't discriminate their claims

- **Idle TTL:** the test only jumps far past the TTL. It doesn't show that forwarded signals refresh `lastActivity`, and doesn't check the boundary (`ROOM_IDLE_MS - 1` survives).
- **Wire limit:** the test uses ASCII `'x'`, so a character-count check would also pass. Add a case with a multibyte character just over the limit, and one exactly at 65,536 bytes that is accepted.
- **Client adapter:** no test covers:
  - listener exceptions being isolated,
  - `signal` frames before `ready` being dropped,
  - pending `send()` waiters surviving a reconnect,
  - stale-socket events being ignored after `lost()`.
- **Host send failure:** the asynchronous `ws.send` error callback (`onFailure → disconnect + terminate`) is untested.

## Checked and OK

- **Join challenge:** each session gets a fresh 32-byte CSPRNG challenge, signed together with `roomId` under a dedicated domain. A second join on the same session is refused. Replay across sessions fails.
- **Room isolation:** recipients are looked up only in the sender's own room. The isolation test discriminates.
- **Opaque forwarding:** the envelope string is never parsed. The whitespace and key-order assertion discriminates.
- **Ordering:** a newcomer always receives `peers` before any signal, because the announce is synchronous before any other peer can route to it.
- **Clock:** the rate window is monotonic in `receive` (`Math.max`).
- **Iteration safety:** deleting from a Map during iteration in `sweep`/`announce` is safe.
- **Hardening:** deflate is disabled, `maxPayload` is set, UTF-8 decoding is fatal, and binary frames are refused.
- **Stale sockets:** the client's `this.socket === socket` guard correctly ignores events from old sockets.
- **Byte-based buffer limit:** `sendServerFrame`'s test does discriminate byte length from character length (`'Ω'` is 2 bytes).
