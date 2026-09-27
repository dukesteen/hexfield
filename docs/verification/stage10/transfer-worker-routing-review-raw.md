# Transfer worker and routing review

## Verdict

- **No blocking security findings in the attached code** for the stated worker invariants:
  - A pending destination cannot attach transport or reach gameplay.
  - New RPC replies are public or destination-sealed.
  - Shutdown ordering is correct.
  - The bootstrap slot preserves control capacity.
- **Two channel findings (1, 2) would make the eventual transfer caller fail** and should be fixed before the channel is wired.
- **Finding 3 contradicts the "bounded" catch-up invariant.**

## Invariants I verified as holding (proved from attached code)

- **Pending destination is isolated.**
  - `attachTransport` needs `this.invite`, which `initializeTransfer` never sets (`online-worker-runtime.ts:478`).
  - Every gameplay, session, freeze and ceremony RPC goes through `requireStartup`/`requireSession` or needs `invite`.
  - `initialize` and `initializeTransfer` exclude each other through `this.identity` (380, 433), and both are serialized on `this.work`.
  - Promotion only returns a `gameId` (245–248).
- **Late source output is suppressed.**
  - `close()` sets `closed` and disposes the session before draining (659–663).
  - `transferResult` rethrows once closed (469–473).
  - Entropy and nonce are wiped in `finally` (289–292).
- **Bootstrap admission is separate.**
  - Bootstrap bytes never enter `pendingBytes`, and one flag-guarded slot exists (164, 170, 207).
  - Control keeps 4 count slots and a 64 KiB byte reserve on both client and worker.
  - The worker frees slots before the reply is posted, so the client and worker cannot diverge.
- **Pending offers and bad certificates cannot expand routes.**
  - Routes come only from `validateCertifiedEntry` + `advanceContext` → `projectCertifiedRoutes`.
  - A failed advance commits no state (`online-game-transport.ts:282–357`).
  - The WebRTC setter is admission-only, and its same-seq and stale checks plus reentrancy ordering are correct (`web-rtc-transport.ts:237–263`).
- **Retired routes are restricted to sync traffic.** Inbound accepts `SYNC_REQ` only, and outbound allows `SYNC_RES` only (`online-game-transport.ts:416–422, 499–512`). Retired devices are excluded from `peers()` and broadcast.

## Findings

### 1. Transfer channel cannot deliver its own maximum artifact on high-RTT links — Medium, proved (arithmetic)
- **Location:** `online-transfer-channel.ts:6,10,121–124,196–199`
- **Trace:**
  - The channel is stop-and-wait with 32 KiB chunks, so a 16 MiB artifact needs 512 round trips.
  - A single 120 s deadline covers the whole artifact on both sender and receiver.
  - That leaves about 234 ms per chunk, including encoding and SCTP.
  - A TURN relay or intercontinental path at 250–300 ms RTT therefore fails every time: `fail` closes the channel, and a retry fails the same way.
  - Late-game `authorized` and `activated` bootstraps are exactly the large artifacts.
- **Fix:** Replace the fixed deadline with a per-chunk inactivity timer, reset on each ack (sender) and each chunk (receiver), for example 30 s. Optionally add an overall cap scaled by `count`. Stop-and-wait itself can stay.

### 2. Channel has no loss tolerance, so the first-frame race stalls or kills the transfer — Medium, assumption (PeerLink hello ordering not attached)
- **Location:** `web-rtc-transport.ts:577`, `online-transfer-channel.ts:182,204–211`
- **Trace:**
  - The receiving `WebRtcTransport` drops messages unless the link is promoted and locally authenticated.
  - If the source's side authenticates first and sends immediately on `online`, chunk 0 is silently dropped. The sender then waits the full deadline.
  - A retransmitted duplicate cannot recover either. For the current transfer, `index !== nextIndex` makes it throw and `fail`. For a completed transfer, it is ignored with no ack.
  - Link replacement fires `online=false`, which closes the channel (101).
- **Fix (either option):**
  - (a) Use a receiver-initiated `ready` frame before the sender's first chunk.
  - (b) Re-ack duplicates of `(id, nextIndex-1)` and of completed ids, and have the sender retransmit the current chunk on a short timer.
- **Also:** The caller must be able to re-create the channel after replacement and resume the protocol idempotently.

### 3. Catch-up grace is enforced only at the next membership commit — Low/Medium, proved within attached code
- **Location:** `online-game.ts:370–383`, `online-game-transport.ts:66–67, 282–357`
- **Trace:**
  1. Activation happens at seq A.
  2. Hundreds of ordinary commits follow. `advanceCertifiedHistory` runs only from `onMembershipCommitted`, and the prune at 66–67 runs only inside it.
  3. So `retiring` keeps the old route, and survivors never re-emit `deviceRoutes`.
  4. The old device stays in the WebRTC `expected` set and keeps a mesh slot.
  5. It can issue `SYNC_REQ` and receive `SYNC_RES` indefinitely.
- **Inconsistency:** A restart replays every entry and prunes correctly (164–176), so live and restored replicas disagree.
- **Fix:**
  - Add a cheap `pruneRetired(committedSeq)` on the game transport, driven by every commit.
  - Re-emit routes when the catch-up set changes.
  - As a minimum, check `latestSeq - route.atSeq > RETIRED_GRACE_HEIGHTS` in the retired `send` and `receive` paths.

### 4. Duplicate destination device would halt every replica — Medium if unenforced upstream; assumption
- **Location:** `online-game-transport.ts:231–232`, `online-game.ts:371,401`
- **Trace:**
  - Suppose a certified activation routes two active human seats to one device, i.e. the destination `devicePeer` is already an active route.
  - Then `projectCertifiedRoutes` fails on every replica.
  - `onMembershipCommitted` returns that failure inside every session.
  - The seat owner controls the destination, so they could brick the game.
- **Fix:** Confirm the v4 core rejects authorization where `destination.devicePeer` or `gamePeer` equals any active route or controller key. The projection correctly fails closed; the concern is only whether upstream validation prevents the input.

### 5. Chat send path may reach catch-up devices — Low/Medium, assumption (OnlineChat not attached)
- **Location:** `online-room.ts:187–196, 813–819`
- **Trace:**
  - `OnlineChat` gets the raw `WebRtcTransport`, and `allowedSenders` filters inbound only.
  - If `send` uses `transport.broadcast` or `peers()`, the retired device receives game chat, because it is admitted as catch-up.
  - Separately, the fresh-room `LobbyController` still runs on the raw transport, so newly admitted devices can exchange lobby frames with it. The content is public.
- **Fix:** Send chat to `peers() ∩ allowedSenders()`. Dispose the lobby controller, or detach its transport, once `activeGamePeers` is set.

### 6. Request accounting measures view length, not what structured clone copies — Low, proved (memory); TOCTOU is an assumption
- **Location:** `online-worker-request-size.ts:18–31`, client posting at `online-worker-client.ts:199`
- **Trace:**
  - Structured clone serializes a view's whole `[[ViewedArrayBuffer]]`.
  - So `huge.subarray(0,10)` is accounted as 10 bytes but copies the entire buffer. This applies to any `Uint8Array` inside packets too.
  - If the page is cross-origin isolated, a `SharedArrayBuffer`-backed view is shared rather than copied. Main could then mutate the bootstrap after the worker verifies it, unless `OnlineTransferDestination` copies first (not attached).
- **Fix:**
  - Client: post `payload.slice()`.
  - Worker: reject non-`ArrayBuffer` backing (`payload.buffer instanceof ArrayBuffer`) and copy with `new Uint8Array(payload)` in `dispatch` before any verification.

### 7. Heavy outputs bypass the heavy slot, and the export size is unchecked — Low, proved
- **Location:** `online-worker-runtime.ts:249–262, 331–336`
- **Trace:**
  - `exportTransferBootstrap` and `exportSave` are tiny non-lifecycle requests.
  - Up to 12 can run concurrently, each building a buffer of up to 16 MiB or more (`exportSave` also canonical-encodes a copy).
  - `exportTransferBootstrap` has no ≤ `MAX_ONLINE_WORKER_SNAPSHOT_BYTES` check. An oversized result only fails later, at the channel (`RangeError`) or at the destination's `refreshTransferBootstrap`.
- **Fix:** Add the size check. Classify both export kinds as heavy (single slot) in `onlineWorkerRequestSize`.

### 8. Initial destination import is not interruptible, and default timeouts kill the worker — Low, proved
- **Location:** `online-worker-runtime.ts:442–450, 663`, `online-worker-client.ts:181–184`
- **Trace:**
  - `close()` captures `this.destination`, which is still `undefined` during `OnlineTransferDestination.create`.
  - A shutdown during a 16 MiB bootstrap verification therefore waits for it to finish, and the client's 10 s shutdown timeout terminates the worker mid-work. IndexedDB atomicity likely saves correctness, but "shutdown stops import" does not hold for the initial import.
  - Full-history verification can also exceed the default 120 s timeout. `fail()` then terminates the whole worker.
- **Fix:**
  - Pass an `AbortSignal` into `create`, aborted by `close()`.
  - Callers should pass a larger `timeoutMs` for bootstrap kinds.

### 9. Quadratic replay on control or cheat-proof entries — Low, assumption (frequency of `control` unknown)
- **Location:** `online-game-transport.ts:305–315`
- **Trace:**
  - Each control or cheat-proof entry since the last membership commit replays the full prefix from genesis.
  - That is O(k·n) signature verifications, run synchronously inside the session commit hook in the worker.
  - Finding 3's lazy advancement makes k larger.
- **Fix:** Reuse the session's already-validated context, or cache the replayed context between entries.

### 10. Route callbacks run inside the session's commit hook — Low, assumption (P2PSession not attached)
- **Location:** `online-game-transport.ts:335–337, 351–353`, `online-game.ts:384–398`
- **Trace:**
  - State is installed before notification, which is good.
  - But `notifyPeer` synchronously re-enters P2PSession's peer listener mid-commit.
  - Retirement disposes the transport, and online-game zeroes material and disposes beacon providers before the hook returns.
- **Fix:** Defer `notifyPeer` with `queueMicrotask`. Confirm P2PSession does not use the transport, master, or beacon after a retired hook returns.

### 11. Destination replies are not detached or allowlisted — Low, hygiene
- **Location:** `online-worker-runtime.ts:234, 239, 242, 244, 453`
- **Issue:** `snapshot()`, `prepareReadiness()` and `prepareOffer()` results are posted as-is, while other paths use `copyPublic`.
- **Fix:** Build these replies through an explicit public schema, then `copyPublic`.

## Informational (not bugs in scope)

- **Main-directed sealed export:** Main chooses the offer, so it can fabricate a destination whose encryption key it knows. It can then get the transfer certified and call `prepareTransferPrivate` to recover the seat master(s). Without a trusted UI this is inherent. The invariant should read: "no key access except through a public, certified transfer that retires this device."
- **Master is not rotated:** The source's journal key-binding record contains `signingKey` and `master` (`online-game.ts:175–184`). Source retirement should delete or zero it.

## Guidance for the eventual channel caller

- Derive `scope = H(domain, attemptId, genesisDigest, sourceDevice, destinationDevice)`.
- Enforce a per-direction kind state machine.
- Treat an ack as delivery only, not acceptance; use the `received`/`cancelled` artifacts.
- Send a `cancelled` artifact on receiver failure so the sender does not wait out the deadline.
- Wrap `onArtifact`: a throw currently closes the channel with "Invalid transfer frame".
- Add static assertions:
  - `MAX_FRAME_BYTES` (44,715) ≤ `MAX_WEBRTC_MESSAGE_BYTES`.
  - The maximum `TransferPrivateEnvelope` fits 64 KiB (the worker import allows about 1 MiB).
- Use a dedicated two-peer transport, or `sendBulk`.
- After `observeTransferActivation` succeeds, shut down the transfer worker before opening the ordinary resume.
