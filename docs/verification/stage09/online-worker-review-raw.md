# Stage 09 online worker review

I reviewed the snapshot excerpts only. Line numbers marked ≈ are counted within the excerpts. Browser acceptance is **not complete**. The failed real-browser guest start is still unexplained. Nothing below is shown to cause it.

## What holds up

- **Agreement verification stays in the worker.** Main ACKs only after the worker's durable `pinFreeze`. `startCeremony` re-verifies the signed agreement and requires its hash to equal the worker's own `pinnedFreezeHash` (`online-worker-runtime.ts` ≈L385–397). A main-thread hash claim cannot substitute for this.
- **Commands are bound to the right seat and head.**
  - `validate`, `submit` and `cancelPending` are checked against `startup.game().seat` inside the worker.
  - `requireHead` runs in the same synchronous step as `session.submit(..., { expectedRevision })` (≈L238–247). Submits therefore bind to the head the user actually saw, even while snapshots are coalesced and waiting for acknowledgement.
- **Hosted-bot private state is never read.** `publishSession` reads only `getPrivate(game.seat)` and drops `ext`. The runtime test's throwing `getPrivate` fixture really does distinguish this.
- **Visibility tokens work.** Tokens increase strictly, `sanitize` hides any snapshot whose token doesn't match, and hiding clears the cache synchronously.
- **Late worker output is blocked before termination.** `client.fail` notifies listeners first, which calls `bridge.stopOutput()`, then terminates. Frames already queued on the port are rejected because `outputStopped` is set.
- **Lease loss is handled fail-closed.** Lease loss disposes the transport and session, then `fatal` stops output and emits before closing, and main halts.
- **Game signing keys stay in the worker.**
  - Scope note: the **device** key does not. It is used on main for the lobby ACK (`lobby.ackFreeze()`) and for chat (`online-room.ts` ≈L185).
  - Transport peer authentication is also attested by main. Only worker-side signatures on game and ceremony messages protect authority.
  - The comment "Keys stay in the worker" (`online-worker-client.ts:100`) should say *game* keys.

## Confirmed findings

### F1 — Medium: normal shutdown turns into a hard terminate, and close rejects

**Where**
- `online-worker-client.ts:127` refuses every request once `closing` is set.
- `online-worker-client.ts:261–265` treats a refused `ackSession` as fatal.
- `online-worker-runtime.ts` ≈L129–130 calls `stopOutput()`, which disposes the session, *before* `close()` sets `closed`.

**Sequence**
1. The room closes, which calls `startup.close()` and then `client.shutdown()`, setting `closing`.
2. A session snapshot arrives. Either it was already in flight, or `session.dispose()` inside `stopOutput` notified subscribers while `closed` was still false.
3. The client sends `ackSession`. The request is refused with `online-worker-closed`, and `stopped` is still false, so the client calls `fail()` and `terminate()`.
4. The worker is terminated in the middle of `runtime.close()`. That skips the orderly `startup.close()`, journal close and lease release, and any in-flight IndexedDB transactions are aborted.
5. The pending `shutdown` request resolves as a failure, so `shutdown()` throws. `OnlineRoom.releaseResources` then skips `await this.chat.flush()` (`online-room.ts:759–760`), and `room.close()` rejects.

**Fix**
- Skip acknowledgements while closing: `if (message.kind === 'session' && !this.stopped && !this.closing)`.
- In `handle`, route `shutdown` straight to `close()`, which sets `closed` before `stopOutput`.
- Add a client test where a `session` event arrives after `shutdown()` starts. The worker should not be terminated and `shutdown()` should resolve.

### F2 — High (availability; fails closed): hosted bot seats break the main-thread session

**Where**
- `online-worker-runtime.ts` ≈L466 publishes `session.controllableSeats()` unfiltered.
- `online-worker-session.ts:31–32` throws if any seat other than `localHumanSeat` appears.

The repo's own runtime fixture uses `controllableSeats: () => [0, 2]` (`online-worker-runtime.test.ts:153`). The real session is at least expected to include hosted bots.

**Sequence**
1. A device hosting a bot opens the game.
2. The first `session` event reaches `OnlineWorkerStartup.receive`, and `new OnlineWorkerSession` throws.
3. The client catches it and calls `fail('Could not apply the online worker update')`. The game halts.

This mainly affects bot hosts, not typical guests. It is a data-leak risk only in the sense that it fails closed.

**Fix**
- Publish only the local seat: `controllableSeats: session.controllableSeats().includes(game.seat) ? [game.seat] : []`.
- Add a test that feeds runtime-emitted snapshots into `OnlineWorkerSession`. No current test connects the two.

### F3 — Medium: frames are dropped without disconnecting the peer

**Where**
- **Backpressure on main:** `enqueue` returns silently when `canQueue` fails (`online-worker-transport.ts:218`). It does not disconnect.
- **Send failure on main:** if `transport.send` throws, it only acknowledges `false` (≈L280–285).
- **Worker ignores rejection:** the worker's `ack` branch ignores `accepted`, and so does the worker listener-failure path.
- **Tests expect the opposite:** the transport tests expect disconnection (`online-worker-transport.test.ts` ≈L175 `['device-b']`, ≈L200 `toContain('device-f')`). As written, the source can't produce that. Either those tests fail on this snapshot or the unshown harness disconnects. Please run them.

**Sequence**
1. The worker is slow, or a WebRTC send buffer is full.
2. An authenticated consensus frame is lost on a peer that is still connected.
3. No peer-change event fires, so no reconnect or resync happens. Previously, `send` threw synchronously to protocol code. Now the game stalls until timeouts.

**Fix**
- Call `disconnectPeer(peer)` on queue overflow and on `send` failure, matching the oversize handling at L214–216.
- Lobby traffic shares these queues. Confirm that disconnecting on overflow doesn't cause reconnect storms while the worker is starting.

### F4 — Low: malformed requests get no reply, then kill the worker after 120 s

**Where:** `online-protocol-worker.ts` ≈L172, `if (!request) return;`.

Any `validBody` mismatch is dropped silently. Examples: a peer ID that isn't 43 characters, or a head hash that isn't lowercase 64-character hex (≈L86).

**Effect:** the client waits the full 120 s timeout and then fails fatally. Validation forms show "checking" for that whole time.

**Fix:** when `protocol`, `generation` and `id` parse, reply with an error result.

### F5 — Low: after a halt, the worker keeps its keys, or a bridge is created after failure

**Halt without termination:** a `startup` event with phase `halted` calls `OnlineWorkerStartup.fail`. That stops bridge output but does not terminate the client. The worker keeps its identity and game keys in memory until the room closes.

**Bridge after failure:** in `ensureAttached`, if the client fails between `initialize` and bridge creation, the bridge is still created with output enabled. It is only closed later by `close()`.

**Fix:**
- Call `client.fail` on a halted startup event.
- Check `client` state before creating the bridge.

### F6 — Low: failure overwrites a completed game

**Where:** `OnlineWorkerSession.fail` (≈L166–180) replaces a `complete` status with `error`. A lease loss or transport fatal after the game ends hides the result.

**Fix:** keep `complete`, and only clear the actionable fields.

## Speculative risks (need the unshown code)

- **120 s timeout on long operations.** The client applies the default 120 s timeout to `submit`, `requestTakeover` and `approveRecoveryAuthorization`. If `P2PSession.submit` waits for peer commit, one slow or reconnecting peer kills the whole worker. Consider per-kind timeouts, or no fatal timeout for consensus-bound calls.
- **Payloads that may carry hosted-bot private data.** Confirm that `getEvents()`, `update.events`, `audit` and `exportSave()` never include hosted-bot private events or secrets.
  - Also, `exportSave()` isn't awaited before its size check. If it returns a Promise, the 16 MB cap is bypassed.
- **Guest consent rests on seat membership alone.** `advance()` pins and ACKs based only on `seat.peer === self`. Verify that `LobbyController.ackFreeze` checks the local ready intent and the config the user saw, not the host's `ready` claim.
- **Is `withCeremonyLock` shared across main and worker?** Main and worker now open separate `IndexedDbByteStore` connections. It must be Web Locks–based, not an in-memory mutex.
- **Frames arriving before any worker listener are dropped** (`listenerCount > 0`), for example ceremony frames before `OnlineCeremony` subscribes. This is safe only if the ceremony retransmits.
  - This is worth instrumenting in the guest investigation. It is not evidence of the cause.
- **Repeated pins not tested against the real worker.** The fresh-start loop re-sends `pinFreeze` every second until the agreement completes. Only the FakeWorker covers this. No test shows that a real runtime accepts a same-state re-pin idempotently.

## What the tests do and don't distinguish

- **"close stops worker bridge output…"** (`online-worker-startup.test.ts` ≈L273–297) does not isolate `stopOutput`.
  - The comment says the shutdown reply is held, but the code only sets `pausePin = false`. The shutdown may complete and close the bridge anyway.
  - There is no positive control showing the same frame *would* be delivered before `close`.
  - If `tick()` only flushes microtasks, the MessagePort message may never be delivered before the assertion.
- **Transport capacity tests contradict the source** (see F3).
- **No integration test runs runtime snapshots through `OnlineWorkerSession`** (see F2).
- **Missing cases:** a session event during shutdown (F1), and a long `submit` exceeding the timeout.
- **These tests are sound:** pin-before-ACK ordering, changed state not ACKed, attach failure causing a halt, client request binding (id, kind, generation), stale-validation suppression in both the session and the hook, and no bot private reads in the runtime.

## Acceptance still missing

Real-browser checks are still needed:

- Two-browser fresh start (host and guest), plus a host with bots (F2).
- Resume.
- Two-tab lease loss.
- Worker crash.
- MessagePort transfer and `instanceof MessagePort` in module workers (Safari included).
- Real peer-ID and head-hash formats against the entry-point regexes.
- An orderly close with an active game (F1).
