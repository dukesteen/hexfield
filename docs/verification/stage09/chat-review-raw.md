# Stage 09 §6 chat and emote review

## Verdict

I found **no signature, scope-binding or authorization bypass**:

- Every accepted packet must satisfy all of these: sender equals the authenticated link `from`, the encoding is canonical, the domain-separated signature verifies, the scope hash matches, and the sender is in the roster both at ingress and when processed.
- Third-party replay is impossible because packets are only accepted from their own sender's link.
- Game scope binds `genesisDigest`, so lobby packets cannot enter game history. The test covers this.

I would treat **finding 1 as blocking** for the "bounded ingress" claim. It is cheap to fix. Findings 2–4 are should-fix. The rest are low-severity or limitations.

Line numbers are counted from the bundle and may be off by one or two.

---

## 1. Medium (blocking): unbounded work per frame before authorization

**Where:** `apps/web/src/session/online-room.ts:171` and `apps/web/src/session/online-chat.ts:172`

**Problem:**
- The room's `allowedSenders` closure calls `this.chat.snapshot()` just to read `scope.kind`.
- `snapshot()` (`online-chat.ts:226-238`) runs `structuredClone` on up to 100 stored events (each up to about 4 KB) and sorts the mutes.
- The ingress handler runs this for every CP2C v1 frame, before the queue caps. It is also the check that rejects non-roster peers.

**Sequence:**
1. Before the roster freezes, peer X connects over an authenticated device link, for example as a signaling-server candidate. X has no seat and is not a spectator.
2. The lobby history holds 100 long messages.
3. X streams 4 KB `CP2C\x01` frames of garbage.
4. Every frame costs about 400 KB of cloning before it is rejected at line 172. The queue bound never applies, and the main thread janks.

**Fix:** stop using `snapshot()` for authorization. Pick the closure by the room's phase, since `enterGame` replaces it anyway:

```ts
allowedSenders: resume
  ? () => humans(this.startup?.agreement()?.state ?? resume.agreement.state)
  : () => { const s = this.lobby?.state(); return s ? [...humans(s), ...s.spectators] : []; },
```

Alternatively, add a cheap `OnlineChat.scopeKind()` accessor.

## 2. Medium-low: one sender can starve everyone else's chat

**Where:** `online-chat.ts:173-174` (one queue cap shared by all senders)

**Problem:**
- The 5-per-10-second budget is charged only after the signature verifies (`:363-364`).
- Invalid frames cost nothing against it, yet each one holds a queue slot.

**Sequence:**
1. Roster is {A, B, C}; C is the receiver.
2. A sends one valid message. C's `remember` now awaits an IndexedDB write. Startup load also opens a window like this.
3. During that await, A sends 64 wrong-scope frames, and `queuedFrames` reaches 64.
4. B's legitimate message arrives and is silently dropped at `:173`. Chat has no retransmit.
5. A repeats this every time C writes to storage.

The existing "bounded while storage is blocked" test only drops a message from the same sender.

**Fix:**
- Add a per-sender in-flight cap, for example `Map<PeerId, number>` with a cap of 8. Increment it next to `queuedFrames`, decrement it in the `finally`, and keep the global cap as a backstop.
- Optionally, keep a per-sender failure counter. When a sender repeatedly sends invalid frames, drop its frames before decode and verify.

## 3. Medium-low: a replayed duplicate permanently breaks chat for a game

**Where:**
- `online-chat.ts:366`: muted packets enter the `seen` FIFO.
- `:392`: `remember` appends without checking the stored history for duplicates.
- `:422`/`:430`: `loadHistory` throws on any duplicate.

**Problem:** muted packets consume `seen` capacity (512) but are not stored. This lets an ID drop out of `seen` while its event is still among the 100 stored events.

**Sequence (game scope):**
1. B sends event E, which is stored.
2. C mutes B.
3. B sends 512 messages at the maximum rate (about 17 minutes, or less if muted peers collude). Each is marked seen, and E is evicted from `seen`.
4. C unmutes B.
5. B resends E byte-for-byte. It passes the `seen` check and is stored a second time. React also warns about a duplicate key.
6. C reloads. `loadHistory` throws, `ready` never becomes true, and chat is dead for the rest of that game.

**Fix:**
- Inside the lock in `remember`, skip the append when `previous.events` already contains `eventKey(packet)`. Still call `markSeen`.
- As a second layer, have `loadHistory` skip duplicate IDs instead of throwing. Keep the throw for bad signatures and wrong scope.

## 4. Low: mute changes can be lost across rooms or tabs

**Where:** `online-chat.ts:299-314`

**Problem:**
- `next` is built from the in-memory `this.muted`.
- `prior` is loaded inside the lock only to satisfy the compare-and-swap.
- So the compare-and-swap always succeeds and overwrites whatever another instance wrote.
- The mutes key is shared by every room for the same identity.

**Sequence:**
1. Tab 1 (room R1) and Tab 2 (room R2) both load an empty mute list.
2. Tab 1 mutes X, and the store holds {X}.
3. Tab 2 mutes Y and writes {Y}.
4. X's mute is gone after the next load.

Two rooms held in the same tab's registry hit this too.

**Fix:** inside the lock:
1. Decode `prior` with `mutesSchema`.
2. Apply the add or delete to that set, and check the 128 limit.
3. Write it.
4. Assign `this.muted` from the written set.

## 5. Low: correctness and UX

- **Sticky error** (`online-chat.ts:342`): `this.error` is never cleared. One transient failure, such as a mute compare-and-swap, shows `chatFailed` for the rest of the session. Clear it after the next successful task, or keep fatal load errors separate from per-operation errors.
- **Unhandled rejection** (`online-chat.ts:180`): `void this.enqueue(...)` discards the rejecting `result` promise when `remember` throws. The queue branch records the error, but the browser still raises `unhandledrejection`. Add `.catch(() => undefined)`.
- **Send stops at the first failed peer** (`online-chat.ts:281-285`): this is conditional. If `transport.send` throws for a disconnected roster peer, later recipients never get the message. The message was already stored and rate-charged, the draft is kept, and a retry creates a new event ID, so peers who did receive it see a duplicate. Wrap each send in its own `try`, finish the loop, and return one partial-delivery result.
- **Lobby-to-game window:**
  - Packets processed after `enterGame` sets `ready = false` (`:208`) are dropped.
  - Game-scope packets from peers who switched first are dropped while the receiver is still in lobby scope.
  - This loses messages but has no security impact.
  - The game chat dialog can briefly show lobby events until the `enterGame` task clears them. Filtering the rendered events by `chat.scope` would hide that.

## Limitations (not security bugs)

- **Duplicate suppression is bounded.** After a restart, `seen` holds only the IDs in the 100 stored events, and the rate budget resets. A sender can re-send its own evicted or muted-era packets. This is equivalent to sending a new message and is still rate-limited.
- **Muted messages are dropped, not stored.** Unmuting does not reveal messages sent while muted.
- **Storage keys are never collected.** There is one history key per scope, with no garbage collection. Mutes are global per identity and capped at 128. The UI can only unmute peers in the current room, so once the cap is reached, space cannot be recovered.
- **Hardening (optional):** render text inside `<bdi>` or with `unicode-bidi: isolate`. Consider rejecting text that contains only invisible characters, since `trim()` keeps U+200B.

## Missing evidence

- **Diagnostic leak coverage.** Tests only check the lobby and ceremony wrapper listeners. Two raw-transport consumers are not shown in this bundle:
  - `relay.attachTransport(transport)` receives the raw transport.
  - `transport.onDiagnostic` feeds `connectionError`.

  I can't confirm CP2C frames never reach them. Add a test that sends v1, v2 and truncated CP2C frames through a real `WebRtcTransport` and relay, and asserts no diagnostic fires.
- **Other untested paths:**
  - spectator send and receive
  - kick while a frame is queued
  - cross-sender starvation
  - the `OnlineRoom` lobby-to-game switch and its `allowedSenders` closure
  - the mute/eviction duplicate path
  - multi-instance mutes
- **No browser evidence** for the in-game chat dialog, or for chat over actual WebRTC links.

## Checked and holding

- **Ingress limits:** frame and size checks run before decode, and canonical re-encoding is enforced.
- **Authorization:** the roster is rechecked when each queued frame is processed.
- **Lobby vs game rosters:** the game roster is frozen humans only, and lobby spectators are included only in lobby scope.
- **Rate limits and serialization:**
  - The local send rate is checked before the event is stored and charged after it.
  - Receive work is serialized, so duplicates cannot race.
- **Disposal order:** `chat.dispose()` runs before `identity.dispose()`. `releaseResources` flushes chat before closing the store, and signing checks `disposed` first.
- **UI:**
  - `busyRef` stops rapid duplicate sends.
  - A draft is cleared only if it still equals the sent text.
  - Mute buttons exclude self and are serialized.
