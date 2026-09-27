# Transfer browser coordinator review

I reviewed only the pasted source and tests; I did not run anything. Line numbers refer to the packet. Findings under "Proved" follow directly from the code shown. Findings under "Conditional" depend on worker, runtime or protocol behaviour that is not in the packet.

## Proved findings

### F1 — High (availability): the source cannot cancel or finish an approved transfer unless the destination is connected

**Where:**
- `online-transfer-browser.ts:204-206`
- `online-transfer-browser.ts:261-274`
- `online-transfer-exchange.ts:366-384`, `:404-430`

**Trace:**
1. The source approves. The authorization may be certified, and the private packet may already have been sent.
2. The page reloads, or the link drops, and the destination never comes back.
3. After `openSource`, `#exchange` is still `null`. The exchange is only created inside `onChannel` or `onArtifact`.
4. `cancel()` finds no exchange and `record.approved` set, so it throws `'Reconnect before cancelling the approved transfer'`.
5. `retry()` without a channel only calls `#connect()`, which waits for a destination that never arrives.
6. Even when an exchange exists, `cancel()` gets a certified cancellation and then calls `deliverOutcome` → `channel.send`. That throws `'Transfer connection is unavailable'`, so a certified cancellation is reported as a failure.

**Effect:**
- The certified pending authorization cannot be revoked from this device. If the protocol allows only one pending transfer, other `confirm` calls fail with "Another transfer is pending".
- There is no authority change here; this is an availability problem, not a safety one.

**Minimal fix:**
- In `#ensureExchange`, create the source exchange as soon as `#record` exists. The channel wrapper already checks for a live channel only when sending.
- In `cancel()`, after the worker confirms a certified outcome, treat a failed `deliverOutcome` send as "certified, destination not notified" rather than an error.

### F2 — Medium: a certified outcome with no receipt blocks every future transfer for this game

**Where:**
- `online-transfer-browser.ts:340-341`
- `online-transfer-records.ts:218-221`
- `online-transfer-browser.ts:105-113`

**Trace:**
1. The cancellation or activation is certified on the source's worker.
2. The receipt is lost, and the destination closes its handle or the device is lost.
3. The source stays in `awaiting-receipt`, so `finish()` is never called.
4. `openSource` reuses the unfinished invite.
5. Any new invite is refused by `saveCurrentTransferInvite` with "A transfer is already in progress".

**Effect:**
- For a certified cancellation, the source is still the controller but can never start another transfer of that seat unless the old destination returns.
- For activation, the source is retired, but its UI shows "awaiting receipt" indefinitely.

The same stranding happens on the destination side: `onPromoted` / `promotedGameId` is only set after a successful `sendReceipt` (`online-transfer-exchange.ts:645-650`). A promoted destination therefore has no in-UI path into its game unless the source reconnects.

**Minimal fix:**
- Add a source-only terminal state, "certified outcome, receipt unconfirmed", entered after `transferStatus(authorization).outcome` has been verified. It should allow `finish()` and replacing the invite, but must not display "completed". This keeps the rule that completion requires a receipt.
- On the destination, call `onPromoted` once `terminal` is set, whether or not the receipt was delivered.

### F3 — Medium-High: an approved authorization that was never certified becomes permanently uncancellable

**Where:** `online-transfer-exchange.ts:390-400` and `:316-333`

**Trace:**
1. `save({approved})` succeeds.
2. The page reloads before `submitTransfer`, or `submitTransfer` fails because a strict-agreement voter is offline.
3. The game continues past `approved.statement.validUntilSeq`.
4. `retryNow` resubmits the stale authorization, and the worker rejects it on every attempt.
5. `cancel()` sees no `pending` and throws "outcome is uncertain" on every attempt.
6. The record is never finished, which leads into F2.

**Why the outcome is not actually uncertain:** activation and certified cancellation both require `record.authorization`, and that is saved before any disclosure (line 334). So "no certified authorization with this statement in history, and head past `validUntilSeq`" proves the authorization can never certify.

**Minimal fix:**
- Add a worker query that checks `transfer.authorizations` by statement.
- If nothing matches and the head has passed `validUntilSeq`, finish the attempt as "expired before certification".

### F4 — Medium: cancellation intent is not persisted, so a failed cancel can be followed by activation or private re-disclosure

**Where:** `online-transfer-exchange.ts:413-429`, `:247-269`, `:336-352`

**Trace:**
1. `cancel()` → `submitTransfer(transfer-cancel)` throws (for example on a timeout), or it returns and line 429 finds no outcome.
2. The UI shows an error, and the link stays open because the phase is not `cancelled`.
3. A readiness artifact arrives, either from a destination retry or reconnect, or already queued. `handle` sees `pending` with `head == parent` and submits `transfer-activate`, which then competes with the in-flight cancel.
4. Alternatively, the user presses Retry: `retryNow` re-sends `authorized` and the private packet.

**Minimal fix:**
- Add `cancelRequested: boolean` to `OnlineTransferExchangeRecord`. It is pinned once true, using the same rule as the other decisions.
- Save it before the first cancel submission.
- While it is set, `handle('readiness')` and `retryNow` must only re-submit the cancel at the current head or call `deliverOutcome`. They must never call `submitTransfer(activate)` or `prepareTransferPrivate`.

### F5 — Medium: reconnecting does not resume the exchange, and a storage failure on the destination strands the offer

**Where:**
- `online-transfer-exchange.ts:187-189`, `:231`
- `online-transfer-exchange.ts:473-486`, `:499`, `:627-628`

**Trace (a), source approved but destination not yet imported:**
1. The link reconnects, and the browser keeps the same exchange instances.
2. `start()` sends only `bootstrap`.
3. The destination is already `initialized`, so it runs `refreshTransferBootstrap` and gets phase `offered`, which sends nothing.
4. Destination Retry re-sends the offer, but the source ignores it because it is already approved (line 231).
5. Only a Retry on the source makes progress. The same happens if the destination reloads and sends a fresh offer.

**Trace (b), destination storage failure:**
1. `initialized = true` is set at line 499.
2. `save({offer})` then throws at line 530, so the offer is never sent.
3. Destination Retry: phase `offered` with `record.offer === null` → throws "not retained" (line 628).
4. Later `bootstrap` artifacts only refresh.
5. The exchange is stuck until the destination page reloads.

**Minimal fix:**
- Source: in `handle('offer')`, when `record.approved` is set, `await this.retryNow()`.
- Destination: in the initialized-`bootstrap` branch and in `retry()`, when the phase is `offered`, call `prepareTransferOffer` (the reserved scope makes it idempotent), save it if missing, and send it.
- These two changes cannot loop, because the destination's `authorized` handler never emits an offer.

### F6 — Medium: artifacts are acknowledged and then dropped when the exchange queue is full

**Where:**
- `online-transfer-channel.ts:266-267`
- `online-transfer-exchange.ts:153-157`
- `online-transfer-exchange.ts:368-383`

**Trace:**
1. The channel acknowledges the final chunk, then calls `onArtifact`.
2. `Exchange.receive` rejects when `queuedBytes + len > 17 MiB`. In-flight artifacts are included in that total until their `finally` runs.
3. `deliverOutcome` sends the parent bootstrap and then the final bootstrap back to back. The destination is still in `refreshTransferBootstrap` on the parent when the final one completes.
4. For any bootstrap over 8.5 MiB (the channel allows 16 MiB), the `activated` or `cancelled` artifact is therefore rejected. The browser swallows the rejection (`online-transfer-browser.ts:274`), while the sender believes it was delivered.
5. The only recovery is an accidental one: the destination's readiness echo on `authorized` (lines 553-558) triggers another `deliverOutcome`. Each round uses 2+ channel ids (see F7).

**Minimal fix (either option):**
- Size `MAX_QUEUED_BYTES` to match the count cap, i.e. `2 × 16 MiB + 64 KiB`.
- Or propagate the rejection back to the sender: fail the channel so the sender's `send` does not report success.

Additionally, stop answering `authorized` with a fresh readiness when the refresh did not change the head.

### F7 — Low-Medium: running out of channel ids leaves an unusable channel that Retry never replaces

**Where:** `online-transfer-channel.ts:137` and `online-transfer-browser.ts:214-215`

**Trace:**
1. After 64 sends on one channel, `send` throws before `fail()` is called, so neither the link's nor the browser's channel is cleared.
2. `retry()` sees `#channel !== null`, calls `exchange.retry()`, and that throws again. This repeats until the peer drops or the page reloads.
3. F6's echo loop and repeated retries consume ids.

**Minimal fix:** call `this.fail(new Error('Transfer exchange limit reached'))` at line 137, so `onError` clears the channel and Retry reconnects.

### F8 — Low: the source's phase can go backwards after it is terminal

**Where:** `online-transfer-exchange.ts:250-252`, `:384`

**Trace:**
1. A receipt sets the phase to `activated`, and the browser finishes the record.
2. A late or retried readiness arrives, `deliverOutcome` runs, and the phase becomes `awaiting-receipt`.
3. If the destination has gone, the UI stays in `awaiting-receipt` even though the record is finished.

**Minimal fix:** in `SourceTransferExchange.handle`, when the phase is `activated` or `cancelled`, process only `received` artifacts and ignore everything else.

### F9 — Low: a failed destination auto-select after reload is silent

**Where:**
- `online-transfer-browser.ts:287-291`, `:294-299`
- `online-transfer-link.ts:291-297`, `:304-309`

**Trace:**
1. On reload, the selection comes from `onCandidates`.
2. If `updatePreGameRoster`, `freezeRoster` or `connect` throws, the link closes itself.
3. The exception is swallowed by the link's observer isolation.
4. The browser shows no error and stays in `connecting` until a manual Retry.

**Minimal fix:** in `#selectKnownDestination`, wrap `selectDestination` in `try/catch`, set `error`, and clear `#channel`.

### F10 — Low: the source pins an offer before any signature check

**Where:** `online-transfer-exchange.ts:215-231`

**Trace:**
1. The offer is only schema-checked before it is saved and becomes irreplaceable.
2. An offer with a bad signature or an expiring anchor surfaces as `awaiting-confirmation`, and then fails at confirm on every attempt.
3. The only way out is a pre-approval cancel.

Only the authenticated, selected destination device can send an offer, so the impact is self-denial of service.

**Minimal fix:** ask the worker to verify the offer (signatures and anchor) before `save`.

### F11 — Low: abandoned attempts leave durable state on the destination

When the source cancels before approval (`online-transfer-exchange.ts:391-394`), it just closes the link without telling the destination.

The destination:
- stays in `awaiting-authorization` indefinitely;
- keeps its reserved scope and transfer credentials in IndexedDB indefinitely.

**Minimal fix:** have the worker clean up these locators once `head > scope.validUntilSeq` with no certified authorization. Optionally, send an unsigned "abandoned" hint so the UI can stop waiting.

## Conditional findings (depend on code outside the packet)

**A1 — `submitTransfer` semantics.** Lines 329-333 and 425-429 treat "no outcome right after submit" as an error, which implies `submitTransfer` waits for certification. If it can return before certification:
- `handle('readiness')` → `retryNow` (line 269) re-sends `authorized` and `private`;
- the destination replies with fresh readiness;
- the source submits activation again.

The loop is bounded only by the 64 channel ids. Please confirm the contract, or have `retryNow` skip disclosure once an activation is in flight.

**A2 — determinism of `prepareTransferPrivate`.** If each call re-encrypts with fresh randomness, every source retry after the destination has imported hits "Private import differs from the durable staged packet" (`online-transfer-destination.ts:837-843`). This is non-fatal because readiness is sent on `authorized`, but it is noisy.

**A3 — refresh budget.** If ordinary entries can be certified while a transfer is pending:
- each stale-readiness cycle and each reconnect `bootstrap` burns one of `MAX_REFRESHES = 8`;
- once the budget is exhausted, activation is impossible;
- `observeCancellation` requires the exact child of the refreshed parent (`:1239-1243`), so the destination also cannot observe a certified cancel, cannot send a receipt, and F2 becomes permanent.

Allow the cancellation to be any certified extension that ends in the matching `transfer-cancel`.

**A4 — lease scope.** The destination holds `transfer-${attemptId}` (`online-transfers.ts:58`), not the game writer lease.

In the `oldBinding` path (`online-transfer-destination.ts:1107-1170`), a retired game worker for the same `gameId` can run in another tab during `promoteTransfer`. The `expectedActive` compare-and-swap probably prevents corruption, but promotion can repeatedly lose the race.

Acquire the game writer lease for `invite.body.gameId` during `observeActivation`.

**A5 — worker lifetime on the source.** F1, F2 and the final-export requirement all assume the room keeps the game `OnlineWorkerClient` alive after retirement. If the game screen disposes it when it sees retirement, `transferStatus` and `exportTransferBootstrap` fail and the receipt can never be verified.

**A6 — transfer-only worker.** Nothing in the packet shows the worker runtime rejecting `initialize` or `attachTransport` after `initializeTransfer`. The "no transport or voter while staged" requirement relies on that.

**A7 — ordered delivery.** Handling of duplicate chunks after completion (`online-transfer-channel.ts:307-320`) fails the channel for any duplicate that is not the last chunk. This is only safe if the data channel is ordered and reliable.

## Test gaps

- **Source role in the browser:** the only browser test is a destination link-replacement test. There is none for `openSource`, auto-select after reload, `selectDevice` races, or source cancel/retry without a channel (F1, F9).
- **Real channel with real exchange:** the exchange tests' fake `send` never drops or acks-then-drops. There is no test with more than 8.5 MiB bootstraps in `deliverOutcome` (F6), and none for id exhaustion followed by `retry()` (F7).
- **Reconnect liveness:** no test covers a reconnect in the `offered` window or the authorized-but-not-imported window without manual retry, using the same exchange instances (F5a), or a failed offer save on the destination (F5b).
- **Cancel:** no test covers a failed or uncertain cancel followed by readiness (F4), or an approved-but-never-certified attempt past `validUntilSeq` (F3).
- **Terminal handling:** no test covers a late readiness after `activated` (F8), or a destination that is gone after a certified cancel (F2).
- **Worker-level repeats:** no real-worker test covers repeated `prepareTransferPrivate` against an already staged destination (A2).

## Checked and found sound

- The public record pins destination, offer, approval and authorization, and cannot be replaced after reload (`online-transfer-records.ts:122-147`).
- The invite is canonical and signed. The destination roster is frozen to the signed source device.
- Link generation guards drop stale `onChannel`, `onArtifact` and `onError` callbacks.
- The source reports `activated` or `cancelled` only after a receipt whose `entry` matches the worker's certified outcome, and never from a local failure.
- The destination promotes only through the worker's exact-child activation plus the durable stage, and awaits shutdown before `onPromoted`. A lost receipt is retried without the stopped worker.
- The destination cannot cancel unilaterally.
