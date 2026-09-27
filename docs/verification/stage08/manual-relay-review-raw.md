I found **7 actionable defects**. None of them lets an unseated peer, a relay or a forged sender add a peer to the authorized roster, get past HELLO authentication, or inject game traffic. Everything this brief asks about that could be exploited is either a lifecycle problem or a denial of service. I reviewed only the snapshot text you supplied; no tools were used and no files were changed.

## Findings

### 1. High — One failed manual handoff blocks all manual invites until the room is left
**Locations:** `packages/p2p/src/manual-bootstrap.ts:15,176`; `apps/web/src/session/online-room.ts:170-179, 353-359, 455-464, 483, 523-531`; `apps/web/src/features/online/ManualConnectionPanel.tsx:39-40, 70-111, 146`

**Failure sequence:**
1. The joiner calls `answerManualOffer` (bootstrap, line 411). That builds a `ManualBridge`, and its constructor starts a 30 s close timer (line 176). The clock starts when the answer code is created, before any person has carried the code back to the host.
2. The host pastes the answer after more than 30 s, which is normal for copy and paste or QR plus a chat app. By then the joiner's bridge has closed its peer connection, so the host's bridge never opens.
3. Both rooms stay in `phase: 'answering'`. The only way out of that phase is `onPeerChange(online)` at room line 172.
4. On the host, `startManualInvitation` returns `manual-busy` (line 356). The Cancel button only renders while `receivingAnswer` is true (panel line 70), so there is nothing to click. No further joiners can be invited without closing the lobby.
5. On the joiner, `answerManualOffer` is blocked (room line 483). The "have offer" form is hidden because `hasCode` is still true (panel line 146), and the answer code on screen no longer works.

**Attack variant:** anyone who sees an unknown-recipient offer (for example by photographing the QR code) can submit a validly signed answer and then never connect. That puts the host in the same stuck state and also takes a roster slot (see finding 4).

**What's missing:**
- The bridge deadline should start after the host accepts, or be as long as the manual attempt window (`MANUAL_ATTEMPT_TIMEOUT_MS` is 5 minutes).
- Bridge close, or the link's attempt timeout, should move the room to `error` or `idle`.
- Cancel should be available in the `answering` phase.

A related gap: `online-room.ts:252-262` never passes `attemptTimeoutMs: null` for rooms without a server, so manual rooms use the 30 s transport attempt deadline. Retries partly cover for this on the smaller peer ID only.

**Tests:** none. In `manual-bootstrap.test.ts`, `FakePc` opens its channels as soon as descriptions are set, so no human delay is ever simulated. `online-room-manual.test.ts` only covers cancelling an offer.

### 2. Medium — The relay never learns when a bridge closes, so manual reconnect fails on one side
**Locations:** `packages/p2p/src/mesh-relay-signaling.ts:111-117, 232-239`; `packages/p2p/src/manual-bootstrap.ts:245-254`; `apps/web/src/session/online-room.ts:443, 452, 521`

`ManualBridge.close()` does not notify anyone. A closed bridge is only removed from `bridges` when a later `send` through it fails (relay line 141). In a room with two peers, `retireRedundantBridges` never removes the bridge either, because that needs a third peer to confirm a route.

**Failure sequence:**
1. The direct link and the bootstrap connection both drop, for example after a network change.
2. The peer with the smaller ID keeps retrying and sending, which removes its stale bridge.
3. The peer with the larger ID never sends (`linkDown` only retries when `self < peer`), so its dead bridge stays in the map.
4. The users try a manual reconnect. On the larger-ID peer, `relay.addBridge` throws "bridge is unavailable" (line 112) in either the offer or answer role, and the new bridge is closed. That peer cannot reconnect manually until the room is reopened.

**What's missing:** a close callback from the bridge to the relay, or `addBridge` replacing a bridge that is already closed. `hasBridge` exists but is never used.

**Tests:** none.

### 3. Medium — Old signed offers can be replayed across sessions to kill connection attempts
**Locations:** `packages/p2p/src/signaling-envelope.ts:10-21`; `packages/p2p/src/web-rtc-transport.ts:413-435, 660-674`; `packages/p2p/src/mesh-relay-signaling.ts:207-214`

The envelope body has no expiry and nothing that ties it to the receiver's current session. The scope (`lobby:<room>`) stays the same across reloads and resumes. The only replay protection is in memory: `retired`, and `offerHighwater`, which keeps at most 64 sessions per peer and is lost when the page reloads.

**Attack sequence:**
1. Roster member C (or the signaling server) records B→A offers. C receives these naturally, because hops-1 frames are sent to every peer (relay line 185).
2. Later, A accepts a fresh offer from B (B < A) and is still in ICE/DTLS, so `hasOpenedChannels` is false.
3. C sends A a stale B offer from an older `sessionId`, as a hops-0 frame. The relay accepts it (lines 205-213). `freshOffer` returns true because the session is unknown or has been evicted. `keepPrimary` is false, so `retireLink(from)` destroys B's real attempt (line 435).
4. B's later signals for that attempt are ignored as retired, and the stale link times out.
5. C repeats this on every retry from B, using a different recorded (session, seq) pair each time. After 64 sessions it can cycle through old ones again.

**What's missing:** a signed timestamp or expiry, or a nonce issued by the receiver. At minimum, an unverified offer should not retire a link that is still in progress.

**Tests:** `signaling-envelope.test.ts` covers tampering, not replay.

### 4. Medium — The roster only grows, and unauthenticated or departed peers fill its 6 slots
**Locations:** `apps/web/src/session/online-room.ts:608-625, 631-641, 432-447`; `packages/p2p/src/web-rtc-transport.ts:197`

- `discover()` adds every peer ID the server lists to the transport roster. That contradicts the comment at transport line 197 ("Server room snapshots never call this automatically"). `refresh()` does the same for spectators in lobby state.
- `acceptManualAnswer` adds the answerer before its PeerLink has authenticated.
- Nothing ever removes these entries before the game starts.

**Failure sequence:** five devices open the invite link or submit a manual answer, then leave or never connect. `roster.length > 6` then gives `room-full` (line 620), and `updatePreGameRoster` throws for every later joiner, including manual ones (line 446). Each ghost entry also counts as a valid relay sender and relay target in `receiveRelay`.

**What's missing:** roster entries that come from discovery or manual accept should be removed when the peer leaves, is not seated, or never authenticates.

**Confidence limit:** `ServerSignalingAdapter.onRoomPeers` and spectator removal in `LobbyController` are not in the snapshot.

### 5. Medium (relay-only mode) — Expiring TURN credentials are reused for the whole room
**Locations:** `apps/web/src/queries/network.ts:117-121`; `apps/web/src/session/online-room.ts:259-261, 296-301`; `packages/p2p/src/web-rtc-transport.ts:476-479`

`loadOnlineConnectionSettings` drops `expiresAt` and returns plain `iceServers`. The room fixes those values once, when it opens, and uses them for every later `PeerLink`, ICE restart and manual code.

**Failure sequence:** a game runs past the endpoint's TTL (the schema allows 1 s to 86,400 s). After that, retries, `restartIce` and manual reconnect codes gather no relay candidates. With `iceTransportPolicy: 'relay'`, the players cannot reconnect at all.

**What's missing:** each factory call should re-resolve credentials (or refresh them before expiry), and should fail visibly once they have expired.

**Confidence limit:** the code that calls `OnlineRoom.open` with these settings is not in the snapshot.

### 6. Low — A relay's unverified evidence can close the independent bootstrap route
**Location:** `packages/p2p/src/mesh-relay-signaling.ts:207-212, 232-239`

If C relays one B→A envelope, C becomes the "confirmed route" for B, and A closes its manual bridge to B while B is still directly online. This only shows that C can deliver messages from B to A, not from A to B. If the direct link later drops, A's reconnect signaling to B depends on C, which can simply drop hops-1 frames.

**What's missing:** confirmation should require delivery in both directions, or the bridge should be kept until a reconnect has actually gone through the mesh.

### 7. Low — Two quick "accept" calls close the live bridge
**Locations:** `apps/web/src/session/online-room.ts:426-430`; `packages/p2p/src/manual-bootstrap.ts:302-309`

Two concurrent `acceptManualAnswer(code)` calls with the same code get the same bridge back. The first call attaches it and sets `manualOffer = null`. The second then sees `offer !== this.manualOffer` and calls `bridge.close()` on the bridge that is already attached. The only guard is `action.isPending` in the UI.

**Also low:** the relay's pending queue is shared by everyone and holds 8 items (`mesh-relay-signaling.ts:241-247`). One roster peer can keep it full with hops-1 envelopes it signs itself to an offline target, renewing them every 15 s, which blocks forwarding for everyone else.

## Checked and not reported
- **Manual codes:** signature domain separation, exact fields, canonical bytes and base64, the scope and recipient checks, and the answer's `h` covering the whole signed offer (including its SDP fingerprint) all look correct.
- **Relay trust:** a hops-1 frame must be signed by the peer that sent it, and hops-0 frames can only go to self. The relay cannot forge senders.
- **Game traffic:** relay frames are sent only to relay listeners, and only authenticated links deliver game traffic.
- **Size limits:** decompression is bounded, and the 16/17 candidate limits reject oversized codes instead of silently dropping candidates. The tests say that is intended.
- **Offer answering by design:** anyone who holds an unknown-recipient offer can answer it, and the first valid answer wins. That is how the design works, not a code defect. It is what makes findings 1 and 4 exploitable.

**Confidence limits:** I could not see `LobbyController`, `ServerSignalingAdapter`, `room-registry`, the codec's tag bytes, or how the browser handles duplicate DTLS fingerprints. Any finding that depends on those is marked above.
