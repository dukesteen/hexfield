# Stage 09 chat follow-up rereview

**Verdict:** All six claimed fixes hold against the frozen source. I found no signature, sender, roster, or scope bypass. I found no way for a still-retained duplicate to be broadcast or to corrupt restore. One real, medium-severity liveness defect remains in the receive rate limiter, plus two low-severity items. Line numbers below are counted from the bundle, so treat them as approximate (±2).

## Claimed fixes

| Claim | Verdict | Notes |
|---|---|---|
| Ingress work before caps | **Sound** | The pre-queue gate (`online-chat.ts:~170–179`) does only constant-time or small-array work. It reads `allowedSenders`, which is now `() => this.chatAllowedPeers`. Rejected frames never emit, so they never trigger `refresh()` or snapshot cloning. |
| Per-sender fairness | **Sound for rosters ≤ 8 senders** | 8 per sender × 8 senders = 64 global. A lobby with more than 8 human+spectator peers lets 8 *roster members* fill the global cap. That is an accepted insider bound, not a bug. |
| Durable duplicate suppression | **Sound** | `remember` checks the stored history under the lock before appending (`~413–418`). Restore still fails closed on already-corrupt data. |
| Cross-instance mute merge | **Sound** | Read, modify and CAS all happen inside the lock, and memory copies the exact written set. A CAS loss throws. `setMuted`'s promise rejects and `ChatPanel.mute` catches it. |
| Handled async receive errors | **Sound** | The terminal `.catch` is on the ingress `enqueue`. The queue tail is always fulfilled, because `emit` swallows listener throws, so `flush()` never rejects and the queue can't be poisoned. |
| Fan-out after a failed recipient | **Sound** | Every recipient is attempted and partial failure is reported. |

### Stale authorization, kicks and scope changes
- **Kicked sender:** `receive` rechecks `allowedSenders()` when the packet is processed (`~373`). `refresh()` updates `chatAllowedPeers` synchronously on `controller.onChange`, so packets still queued from a kicked peer are dropped.
- **Scope change:** `enterGame` sets `ready = false` synchronously. Lobby packets queued ahead of the switch are then dropped by the `ready` check, and those queued after it are dropped by the scope-key check. The boundary holds in both orders.
- **Local duplicate:** `send` returns `chat-duplicate` before fan-out when `remember` reports an existing durable ID, and rate is not charged.
- **Restore:** `remember` is the only writer, it deduplicates under the lock, and the lease prevents two same-room instances.

## Confirmed remaining issues

### 1. Medium: receiver rate window has zero tolerance, so honest messages are silently dropped
`online-chat.ts:~386–387` together with `withinRate`/`chargeRate` (`~395–407`).

The sender and receiver use the same 5-per-10 s budget. The receiver timestamps each message at its own **processing** time, not the sender's send time.

Sequence:
1. The sender sends 5 messages starting at t₀ and passes its own limit.
2. At t₀+10 000 ms the sender's window has expired (`now - time < 10000` is false), so it sends a 6th message and gets `ok`.
3. The receiver charged message 1 at t₀+d₁ and processes message 6 at t₀+10 000+d₆.
4. If d₆ < d₁, all 5 earlier charges are still inside the window. Message 6 is silently discarded.

Normal jitter is enough to trigger this. A storage stall makes it worse: the queue releases everything at once, so both batches get charged at nearly the same instant.

**Fix:** give the receiver a budget strictly looser than the sender's. For example, add `RECEIVE_RATE_COUNT = 2 * RATE_COUNT` and use it only in `receive`, keeping the per-sender queue cap as the hard bound. Optionally, charge at ingress time instead of processing time.

### 2. Low: send fan-out uses a recipient list taken before the durable write
`online-chat.ts:~265` (recipients computed), `~291` (`await this.remember`), `~296–303` (fan-out).

Sequence:
1. In the lobby, `send` snapshots the roster.
2. It then awaits storage.
3. The host kicks peer K, and `refresh()` removes K from `chatAllowedPeers`.
4. Fan-out still sends to K, so a just-kicked peer receives the message.

Game scope uses a frozen roster, so it is unaffected.

**Fix:** after `remember` returns, recompute the list, e.g. `recipients.filter((p) => this.allowedSenders().includes(p))`, or simply compute it for the first time there.

### 3. Low, conditional: `enterGame` can spin if the game scope fails the schema
In `online-room.ts` `refresh()`, suppose `v.parse(scopeSchema, scope)` inside the `enterGame` task throws, for example because `genesisDigest(game.genesis)` is not 43-char base64url. Then the scope stays `lobby` and `.finally` calls `refresh()`, which calls `enterGame` again. This repeats indefinitely as a microtask loop, emitting on each pass.

The test fixture uses `'A'.repeat(43)`, so the bundle doesn't show whether real digests match. **Fix:** latch the failure, e.g. a `chatSwitchFailed` flag checked next to `chatSwitching`. Alternatively, validate the scope synchronously in `enterGame` before queuing.

## Bounded by design (not bugs)
- **Transition-window loss is wider than "in-flight".** A faster peer that has already entered the game sends game-scope packets. A slower peer drops them until its own `startup.game()` exists, which can take a whole startup ceremony, and the sender still sees `ok`. This is noncertified and the scope stays intact. If it matters, add a small per-sender buffer for game-kind packets with a matching `roomId`, re-evaluated after `enterGame`.
- **Aged-out replays.** Once an ID leaves both the 100-event history and the 512-ID cache, the original author can replay it and it appears as new. A muted author's packets can also resurface after unmute if eviction happened. Only the signing author can do either, and they could just send new messages instead.
- **No retransmission.** A peer missed by a failed `transport.send` never receives that message.

## Unverified; needs a check outside this bundle
- **Recipients between freeze and game.** In that window, `refresh()` builds the lobby-scope roster from the live lobby `state`, including spectators. `freezePeers` narrows the transport roster. If `WebRtcTransport.send` throws for peers outside the frozen roster, every chat in that window reports `chat-send` and shows "chat failed" even though players received it. Users may then resend. Please check `send` semantics for frozen-out peers.
- **Stale in-memory mutes across tabs.** Tabs for *different* rooms, and therefore different leases, don't reload each other's mutes until their next `setMuted` or restart. This is a UX issue only.

## Test gaps
- **Global-cap test no longer covers the global cap.** "authenticated chat ingress stays bounded" sends all 65 frames from one sender, so the 8-per-sender cap now drops the valid frame, not the 64-frame global cap. Add a variant with ≥ 9 roster senders, or rename the test to describe what it now checks.
- **No regression for a kick while packets are queued, or for a kick during a send's storage await (issue 2).**
- **No test using a real `genesisDigest` output through `enterGame` (issue 3).**

Real multi-browser evidence remains separate and outstanding; nothing here depends on it.
