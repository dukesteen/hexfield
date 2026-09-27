# Local vault review: five findings

Ordered by severity. Each finding is tagged **Proven** (follows from the excerpted code and platform semantics) or **Risk** (needs a test to confirm).

---

## 1. Proven: deletion's exclusive vault lock waits forever and blocks new owners

**Lines:** `local-vault.ts:475-484`, `online-game-deletion.ts:138-153`, `local-vault.ts:85` (owners are lifetime-scoped)

`withExclusiveVault` calls `manager.request(LOCK_NAME, { mode: 'exclusive' }, …)` without `ifAvailable`. So `lock` is never null, and the guard at `:481` is dead code. The `'busy'` result at `online-game-deletion.ts:153` is only reachable after the vault lock is granted. The vault lock is only granted once every live `VaultOwnerLease` on the origin has closed.

**Failure sequence:**
1. Tab A holds an owner for game G1. This is the normal lifetime per `:85`.
2. Tab B deletes G2. Its exclusive request queues and does not settle while G1 is open.
3. Tab C calls `acquireVaultOwner` (shared). That request queues behind B's pending exclusive request, so C cannot open any room or game until A closes.
4. If tab B itself holds any owner, its own deletion never resolves.

**Why exclusivity isn't needed for safety:** deletion writes only public records and only deletes protected ones. A migration racing a deletion is already caught by the full key-set CAS at `local-vault.ts:254-259`.

**Fix:** use `mode: 'shared'` for deletion, or `ifAvailable: true` and map a null lock to `'busy'`.

**Test:** hold an owner, call `deleteOnlineGameData` for another game, and assert it settles. This needs a real-semantics lock manager (see finding 2).

---

## 2. Risk: a worker's handoff can deadlock behind a queued migration, and the test lock manager can't show it

**Lines:** `local-vault.ts:138-163`, `local-vault.test.ts:18-43`, `:110`, `:202-229`

A worker using `acquireVaultOwner({ handoff })` requests a second shared lock. Under Web Locks queueing, a later shared request is not granted ahead of an earlier queued exclusive request.

**Failure sequence:**
1. Tab A holds owner O1 (locked mode).
2. Tab B queues `migrateLocalVault`.
3. Tab A starts a worker with `O1.handoff()`. The worker's shared request queues behind B.
4. If A waits for the worker to become ready before it would ever close O1, you get a cycle: A waits on the worker, the worker waits on B, and B waits on A.

**Why the tests don't catch it:** `TestLocks` ignores both `name` and `mode`. It serializes every request into one FIFO queue and reports `mode: 'exclusive'`.
- Test `:202`, "queued migration does not block owner work", only passes because the owner's inner calls never touch the lock manager.
- Test `:110` acquires the worker only after `owner.close()`.
- No test has two concurrent shared holders or a shared request queued behind an exclusive one.

**Fix:** let the worker run under the parent lease instead of reacquiring. Build `VaultRecordAccess` from the handoff without a lock, and have the parent keep O1 open until the worker has terminated.

**Test:** replace `TestLocks` with a model that is per-name, supports shared mode, and is FIFO. Then assert this interleaving does not hang.

---

## 3. Risk (proven for the excerpted code): journal transactions can call `pin()` inside an open IDB transaction

**Lines:** `local-vault.ts:357-363`, `indexed-db-protocol-journal.ts:115`, and:
- `#load` at `:126-141`
- `#loadSafety` at `:310-325`
- `#saveSafety` at `:370-379` (`#captureBinding` returns null without pinning when there is no binding)
- `#initialize` at `:217-237` when there is no `keyBinding`

`assertGeneration` awaits `this.pin()`. If `#ready` is null, `pin` opens a separate connection and reads it (`:330-335`), and in locked mode it also runs PBKDF2 or verifier decryption. All of that crosses event-loop turns while the caller's transaction has no pending request.

**Failure sequence (default-off):**
1. `new IndexedDbProtocolJournal(id)` gets a fresh, unpinned `VaultRecordAccess(true)`.
2. The first call to `load()` (or to `initialize()` without a binding) opens a transaction.
3. `assertGeneration` then pins inside it. The empty transaction auto-commits.
4. The `vaultStore.get` at `:363` throws `InvalidStateError`/`TransactionInactiveError`.

The same thing recurs after any pin failure, because `:351` resets `#ready`.

The other stores pin explicitly before opening a transaction (`indexed-db-byte-store.ts:70`, `transfer-import-store.ts:438`, `online-game-deletion.ts:192`). The journal does not in this excerpt. This is only safe if `#runOperation` or `#database`, which are not in the bundle, pin first.

**Fix:** make `assertGeneration` throw if the access is not already pinned instead of pinning. Also pin at the start of `#runOperation`.

**Test:** a fresh default-off journal whose first call is `load()`, and one whose first call is `initialize()` without a binding. Run both under fake-indexeddb and in a real browser.

---

## 4. Proven: an unguarded `transaction.abort()` hides quota and commit failures

**Lines:** `local-vault.ts:277-281`, `transfer-import-store.ts:189-193`, `transfer-import-store.ts:305-309`

When `await transaction.done` rejects, the transaction has already finished. Typical causes are a `QuotaExceededError` at commit or a strict-durability failure. The catch block then calls `transaction.abort()`, which throws `InvalidStateError` synchronously and replaces the real error.

**Failure sequence:**
1. Migration rewrites every protected record in one transaction, and each record grows by 36 bytes. That is the likeliest place to hit quota.
2. `done` rejects with a quota error.
3. `abort()` throws `InvalidStateError` instead.
4. The UI cannot tell "free space and retry" apart from a bug.

Promotion already guards this correctly at `indexed-db-protocol-journal.ts:834-838`. Apply the same `try { abort() } catch {}` in these three places.

---

## 5. Proven: errors the UI needs to branch on are untyped or mis-coded

Each of these needs a stable code:

| Line | Current error | What the UI needs |
|---|---|---|
| `local-vault.ts:259,265,270` | "records/metadata changed during migration" (`TypeError`) | A retryable code such as `'busy'` or `'changed'`. After fix 1, deletion racing migration triggers this. |
| `local-vault.ts:450` | Handoff generation mismatch after rotation (`TypeError`) | `'stale-generation'`, so the worker asks the parent for a new key instead of failing hard. |
| `local-vault.ts:592` | Wrong envelope or generation header (`TypeError`) | `'corrupt'`, or `'stale-generation'` if the header generation is lower. |
| `local-vault.ts:343`, `:362` | Closed access reported as `'locked'` | A distinct `'closed'` code. Today the UI would prompt for a passphrase. |
| `local-vault.ts:365` via `close()` at `:397-398` | A close mid-operation wipes `#raw`, so an in-flight write reports `'stale-generation'` | `'closed'` instead. |
| `indexed-db-byte-store.ts:84,122`; `local-vault.ts:222,231,636` | Identity missing or changed (`TypeError`) | `'identity-missing'` / `'identity-mismatch'`, which are unrecoverable-corruption screens. |
| `local-vault.ts:645` | Passphrase policy (`TypeError`) | `'weak-passphrase'` for form validation. |
| `local-vault.ts:404` | Web Locks unavailable (`Error`) | `'unsupported'`. |
| `local-vault.ts:611` | Per-record `'corrupt'` in migration carries no record key | Some remediation hook. As test `:228` shows, one bad record permanently blocks rotation and disabling. |

---

## Checked with no finding

- **Byte CAS** is ciphertext against ciphertext: `indexed-db-byte-store.ts:169`, `transfer-import-store.ts:184,292,300`, promotion `:709-726`.
- **Migration** checks the complete key set and bytes, and does no WebCrypto inside its write transaction (`:250-277`).
- **Journal binding** is compared as stored ciphertext in `saveSafety` and `commit` before persisting (persist-before-vote holds). The fresh promotion path is atomic with fresh safety.
- **Identity no-remint** holds in `putIfAbsent`, `loadPinned` and migration.
- **Locked deletion** touches only public records plus deletes.
- **Default-off stores** are protected by the metadata CAS in `assertGeneration` even though they hold no lock.
