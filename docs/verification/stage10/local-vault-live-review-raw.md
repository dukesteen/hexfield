# Local vault integration review

I reviewed only the pasted controller source and diff. I had no tools, so I could not check any claim against `@cp2p/storage` internals or files outside the diff. The storage assumptions I rely on are listed at the end.

The controller file is not in the diff, so its line numbers are counted from the pasted text and are approximate. It would live at `apps/web/src/session/online-vault-controller.ts`.

## Confirmed release blockers

### 1. A scope can acquire the tab owner after `lock()` has finished, causing a same-tab or cross-tab deadlock

**Evidence:**
- `online-vault-controller.ts:123-130` (`acquireScope`, first stage) awaits `acquireVaultOwner()`. It then checks only `#disposed || #closing || state !== 'ready'`.
- `lock()` clears `#closing` in its `finally` (`:153-155`).
- `#closeScopes` puts `state` back to `'ready'` (`:193-197`).
- `unlock` (`:102-110`) makes the same `#closing` check.

**Trigger (cross-tab):**
1. Tab A is in clear mode. A settings query calls `acquireScope`, and A's shared owner lease is granted while `acquireVaultOwner` is still finishing its work.
2. Tab B calls `enable()` and posts `lock-request`.
3. A's `lock()` finds no owner and no scopes, so it completes at once and nulls `#closing`.
4. A's `acquireVaultOwner` then resolves. All checks pass, and `#owner` is kept.
5. B's exclusive `migrateLocalVault` now waits on A's owner.
6. A's second-stage shared request (`:134`) is queued behind B's exclusive request, because Web Locks grants requests in FIFO order. Both tabs hang until A locks for some other reason.

**Trigger (same tab):** In `#migrate` (`:207-209`), `lock()` resolves before `state` is set to `'busy'`. A listener-triggered refetch can take the owner in that gap. `migrateLocalVault` then waits on the controller's own lease.

**Smallest fix:** Add a lock epoch. Increment it at the start of `lock()`, before any early return. Have `acquireScope` and `unlock` capture it on entry and reject if it has changed after every await:

```ts
#epoch = 0;
lock() { this.#epoch++; if (this.#closing) return this.#closing; ... }
// acquireScope / unlock:
const epoch = this.#epoch;
... const owner = await acquireVaultOwner(...);
if (this.#disposed || epoch !== this.#epoch || ...) { await owner.close(); throw closed; }
```

In `#migrate`, set a barrier flag before `lock()` so that `#assertIdle` rejects new scopes until migration settles. Clear the flag in `finally`.

### 2. A `lock-request` that arrives while this tab is busy is silently dropped, so the requesting tab's migration waits forever

**Evidence:**
- The constructor listener (`:44`) calls `lock().catch(() => undefined)`.
- `#closeScopes` (`:181-182`) throws `busy` whenever `state === 'busy'`. That is the case throughout `unlock()` (`:100`).
- After a failed close (`:185-188`), state is `'error'` and the owner and scopes are kept. A later lock-request retries, but if the same scope close keeps failing, nothing ever releases the lease.

**Trigger:** Tab A is typing its passphrase and `unlock` is in progress (a KDF can take hundreds of milliseconds). Tab B runs `changePassphrase`. A drops the request, A's unlock succeeds and keeps `#owner`, and B's `migrateLocalVault` blocks with no timeout. B's UI stays `busy` indefinitely.

**Smallest fix:** The epoch from finding 1 covers this. Because `lock()` bumps the epoch before `#closeScopes` throws, the in-flight `unlock` sees the change and closes its owner.

Also bound the requesting side. If `migrateLocalVault` accepts an `AbortSignal` or timeout, pass one and map expiry to `VaultError('busy')`. If it doesn't, that is a storage-API limitation to track.

### 3. Cancelling `OnlineRoom.open` is not a barrier; the open can keep running and hand the key to a new worker after lock resolves

**Evidence:** The close callback is at `apps/web/src/session/online-room.ts:307-324`. When `room` is still null, the callback does four things:
- tears down whatever resources exist at that moment;
- sets `scopeCancelled`;
- returns without waiting for `open()` to unwind;
- does not interrupt later steps.

`open()` checks `scopeCancelled` only at `:330` and again at `:454`, after the room has been constructed. `createWorkerClient` (`:298-304`) reads `vaultScope?.handoff()` without `assertActive()`.

**Trigger:**
1. The user presses Lock, or another tab migrates, while a resume is between `:331` and worker creation.
2. `#closeScopes` runs the callback, then `releaseScope`, then closes the tab owner, and `lock()` resolves. The UI now shows "locked".
3. `open()` continues. If `handoff()` on a closed lease still returns the key, the new protocol worker sends `unlockVault` and acquires its own shared lease. It then decrypts the identity and journals during `initialize`.
4. Only after that does `:454` throw.

Resources created after the callback ran (signaling, transport, worker) are cleaned up only by `open()`'s own `catch`. Meanwhile the other tab's migration is blocked by the worker's lease.

**Smallest fix:**
- Add a `checkOpen()` helper that throws if `scopeCancelled`, and call `vaultScope.assertActive()`. Call it after every await in `open()` and inside `createWorkerClient` before `handoff()` is read.
- Have the callback, after disposing transports and failing the worker client (which unblocks pending awaits), wait on `open()`'s settlement, e.g. `await openSettled.catch(() => {})`. This does not deadlock, because `open()`'s `catch` only calls `releaseScope` and never `lock()`.

### 4. A missed or failed `vault-changed` leaves the tab with a stale mode and no way to recover

**Evidence:**
- `#refreshStatus` (`:236-241`) returns early if `#owner` is set or any scope is live. A clear-mode settings refetch recreates both almost immediately after `lock()`.
- The listener (`:45-48`) skips the refresh entirely if `lock()` rejects (see finding 2).
- When `acquireScope` fails to get an owner (`:123`), it does not refresh or update state.
- `unlock` (`:98`) refuses with `invalid-key: Vault is not locked` whenever the cached mode is `'clear'`.

**Trigger:** Tab B enables the vault while A's lock is rejected, or while B's `BroadcastChannel` message is lost. A keeps `mode: 'clear'`. Storage (correctly) rejects `acquireVaultOwner({})`. Every scope in A fails, and the user cannot unlock A until they reload.

**Smallest fix:**
- On a `locked` or `stale-generation` `VaultError` from `acquireVaultOwner` in `acquireScope` or `unlock`, re-read `readLocalVaultStatus()` and `#set` the result.
- Make `#refreshStatus` always read status, since it is public metadata. If the status generation differs from `#owner.generation`, call `lock()`.
- Have `unlock` re-read status before it rejects on mode.

## Should fix before release

### 5. A failed initial status read is permanent

`ready()` (`:61-88`) retries only while `state === 'loading'`. After the `catch` sets `'error'`, every later `ready()` resolves with the error snapshot. `acquireScope` then acquires and immediately closes an owner (`:126-128`) on every call.

A transient IndexedDB failure, such as a blocked open during another tab's upgrade, therefore disables settings, rooms, and full-save in that tab until reload.

**Fix:** When `ready()` is called in `'error'` state and no owner exists, reset to `'loading'` and retry.

### 6. `lock()` waits on scope closers with no time limit

`#closeScopes` (`:184`) waits on every closer with no timeout:
- the settings closer waits on `active` (`hooks.ts:30-32`), an IndexedDB operation;
- the room closer waits on `room.close()`, which includes the worker shutdown.

One stuck closer holds the controller in `'busy'` indefinitely, and with it every other tab's migration. None of these closers call back into `lock()`, so I found no true self-wait here, but the wait is unbounded.

**Fix:** Race each closer against a deadline. On expiry, use the existing `'error'` path.

### 7. Settings now require an unlocked vault (needs wider app integration)

`hooks.ts:25-48` routes `get`, `update`, and `claimStoragePersistenceRequest` through `acquireScope`, which throws `locked` before unlock (`:122`). It also throws `busy` during any lock, unlock, or migration (`:120`).

`__root.tsx` and `settings.tsx` are modified but outside the diff. If either one gates rendering on `settings.get`, the app shell or the unlock UI itself may be unreachable while locked.

**Decide one of:**
- settings keys become public vault records via `isPublicVaultRecord`; or
- the settings query treats `VaultError('locked'|'busy')` as "defaults, no retry" and re-queries when the controller notifies.

## Hardening and limitations (not live defects on the production paths I could see)

**8. Optional vault parameters leave unvaulted construction paths open.**
- `online-full-save-inventory.ts:32-35` has an optional `createJournal`.
- `online-transfer-destination.ts:110,313-318` has `vault?`, and `#journal` falls back to a bare `IndexedDbProtocolJournal`.
- `online-worker-runtime.ts` uses `...(vault ? {...} : {})` spreads.

In production, `ensureVaultOwner` always runs before these are reached for a non-injected store, so each call does receive the vault. But a future caller that omits the parameter silently gets an unvaulted journal. Make the vault required whenever the store is vault-backed, and keep the optional form only behind the injected-store seam.

**9. The worker entries do not validate the handoff.**
- `online-full-save-worker-entry.ts:28-30` and `online-public-archive-worker-entry.ts:30-32` cast `supplied.handoff` without checks.
- A present-but-`undefined` key passes the key-set check and becomes `{ handoff: undefined }`.
- Reuse the protocol worker's `unlockVault` shape check (`online-protocol-worker.ts:83-98`), and accept only `null` or a valid handoff.
- In the public-archive entry, the `IndexedDbByteStore` created at `:39` is never closed; `finally` closes only the owner (`:41-42`). Close the store first. This is harmless today because the worker is terminated, but it inverts the store-then-owner order used elsewhere.

**10. Vault errors escape the full-save client's error type.** `VaultError` from `acquireScope` (`online-full-save-client.ts:147-152`) propagates as-is, so existing `OnlineFullSaveClientError` code mapping will not recognise locked or busy. `assertActive` failures at `:154-157` are reported as "worker could not start". Map vault errors to a `full-save-locked` client error, matching the worker entry's code.

**11. Scopes can be closed twice.** The settings, full-save, and archive paths call `releaseScope` in their own `finally`, while `#closeScopes` (`:190`) also releases every scope still registered after the closers settle. This is correct only if `VaultOwnerLease.close()` is idempotent; please confirm. `room.close()` racing `open()`'s catch (`online-room.ts:310` vs the catch) has the same dependency.

**12. `dispose()` can fail and leak.** If `lock()` rejects, `dispose()` (`:171-177`) also rejects and never closes the channel. Set `#disposed` and close the channel in a `finally`.

## Looks correct

- **One-shot workers:** the close callback terminates the worker, which releases its Web Lock and aborts its IndexedDB transactions. The microtask gap between `acquireScope` resolving and `factory()` is covered by `scope.assertActive()` (`online-full-save-client.ts:154`, `online-public-archive-client.ts:77`).
- **Protocol worker:** it validates that the key is a non-extractable AES-GCM `CryptoKey` both on the client (`online-worker-request-size.ts:14-26`) and in the worker. `ensureVaultOwner` pins generation and vaultId, rejects a handoff to an injected store, and closes the store before the owner on shutdown.
- **Full-save private-export inventory:** the nested journal factory reaches `loadStoredOnlineMasterInventory` with the owner-bound journal.
- **Transfer destination:** all four journal constructions in the diff go through `#journal`.
- **Worker resume:** the worker runtime uses `loadOnlineIdentity` rather than load-or-create, so it cannot mint an identity.

## Unverified; needs storage or out-of-diff confirmation

1. **Identity remint:** `OnlineRoom.open` calls `loadOrCreateOnlineIdentity(store)` for non-resume opens. If a vaulted `IndexedDbByteStore.get` returns `undefined` instead of throwing on a decrypt, AAD, or generation mismatch, a stale-key read would silently mint a new identity. The store must fail closed on these.
2. **Handoff after close:** whether `lease.handoff()` returns `null` once the lease is closed. This decides how severe finding 3 is.
3. **Other protected-store consumers:** whether `online-transfer-destination.ts` constructs `TransferImportStore` or any other store internally without the vault.
4. **Files outside the diff:** `LocalSavedGameRepository` (`hooks.ts:54`), `online-transfer-browser.ts`, and the `transfer/$code.tsx` and `full-save/$saveId.tsx` routes are modified but not in the diff. I could not confirm that they avoid opening protected records on the main thread without a scope.
