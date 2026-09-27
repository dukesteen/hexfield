# Review: local passphrase lock design

The overall shape is sound: a WebCrypto-only vault, AAD bound to the record key, no remint on a locked read, and public journal, replay and quorum left untouched. HXFS1 chunks are correctly treated as already-encrypted. Below are five corrections, ordered by severity. Items 1–3 are **proven conflicts** with the pinned code. Items 4–5 are **implementation risks** that need targeted tests. None of them requires a new dependency or a protocol change.

---

### 1. Blocker: transfer promotion uses the same binding bytes as plaintext and as the stored comparand (proven conflict)

**Design section:** "A transparent wrapper is insufficient…" (journal receives both plaintext and stored representations).

**Source:**
- `indexed-db-protocol-journal.ts:#promoteTransfer`, lines 492, 543, 734, 572–605 and 643–647
- `indexed-db-protocol-journal.ts:482`
- `online-game.ts:196–211`

The design splits plaintext from ciphertext only for the constructor's `keyBinding`. Inside `#promoteTransfer`, one `keyBinding.bytes` value is used in three incompatible ways:
- It is compared with the plaintext `staged.bindingBytes` (line 492).
- It is decoded as plaintext material (line 543).
- It is written verbatim as the stored record (line 734), which later `saveSafety`/`commit` compare byte-exactly.

`options.expectedActive.bindingBytes` has the same problem. It is compared with the stored record at line 647, and it is also passed to `historicalOldMaterialContext`, which apparently decodes it (lines 572–605; the line 605 error is about device and seat).

Separately, line 482 creates `new TransferImportStore()` with a default, non-vault `IndexedDbByteStore`. The promotion path therefore cannot receive the unlocked vault at all.

**Failure sequence:**
1. The vault is enabled and a transfer is staged.
2. The caller passes plaintext `keyBinding.bytes` so that the checks at 492 and 543 pass.
3. Line 734 writes **plaintext destination signing keys and masters** to `online-game/<d>/keys`.
4. On the next restore, the journal is built with the ciphertext comparand. `#load` throws "missing or mismatched", so the seat is stuck after activation.

If the caller instead passes ciphertext, line 543 throws and the promotion never completes.

**Correction:**
- Change both `keyBinding` and `expectedActive` to `{ plaintext, stored }` pairs.
- Precompute the new binding ciphertext before opening the transaction, and `put` that value at line 734.
- Compare the existing record against `expectedActive.stored` in the transaction. Validate `expectedActive.plaintext` before the transaction.
- Inject the vault-aware `TransferImportStore` instead of constructing it at line 482.

**Test:** a promotion after rotation, followed by `saveSafety`/`commit`, then a reload.

---

### 2. Blocker: random-nonce AEAD breaks in-transaction byte-equality idempotency on direct IDB paths (proven conflict)

**Design section:** "Storage contract and envelope" (the envelope "remains byte-exact and immutable for `putIfAbsent`") and the public allowlist.

**Source:**
- `transfer-import-store.ts:stage` 168–172; `saveReadiness` 246–249 and 256–260; cancellation 386–390
- `indexed-db-protocol-journal.ts:#promoteTransfer` 626–637
- `online-game-deletion.ts:deleteTransaction` 190–239

These paths re-encode plaintext and compare it byte-for-byte against the stored value *inside* the transaction. With a fresh 96-bit nonce per write, identical plaintext never produces identical bytes. Decrypting inside the transaction is not an option, because awaiting WebCrypto there would end it.

**Failure sequences:**
- **Promotion:** line 628 `canonicalEncode(staged)` never equals the stored ciphertext, so every promotion throws "Transfer import changed during promotion".
- **Stage retry after reload:** line 171 throws "already exists with different bytes". The authorization attempt cannot be resumed without a new attempt.
- **Readiness:** line 249 compares the stage in the same way.
- **Locked deletion** (which the design explicitly offers): `deleteTransaction` parses `online-game/<d>/start`, the tombstone byte marker and the catalogue in the transaction. If `/start` falls into the default-protected class, locked deletion always aborts.

**Correction (WebCrypto only):**
- For each protected direct-IDB record, read and decrypt *outside* the transaction and keep the raw ciphertext. Inside the transaction, compare only against that captured ciphertext (the design's CAS pattern, applied to stage, readiness and promotion).
- Alternatively, add to the envelope a keyed HMAC-SHA-256 commitment over `AAD‖plaintext`, computed before the transaction. Idempotent-retry equality then becomes a comparison of tags inside the transaction.
- Name every key family that is parsed or compared in a transaction as an explicit allowlist entry: `online-game/<d>/start`, `start-digest`, the catalogue, the byte tombstone, and `transferImportFinalKey`. Do not rely on "pointer/catalogue" wording.

---

### 3. High: envelope overhead conflicts with the 16 MiB caps, and the escrow registry's `null` means "empty" (proven conflict)

**Design section:** the "Current durable copies" table (escrow row, "Default to protected") and "Enable… step 2".

**Source:**
- `database.ts:13` (`MAX_RECORD_BYTES = 16 MiB`)
- `escrow-lifecycle.ts:39` (`MAX_REGISTRY_BYTES = 16 MiB`), `:40–41` headroom, `:428–429` `loadRegistry`
- `indexed-db-byte-store.ts:copyBytes`
- `transfer-import-store.ts:110` (the plaintext is checked against the cap)

Plaintext admission limits equal the hard record cap. After adding the envelope (header, 12-byte nonce, 16-byte tag, and a MAC if item 2 is adopted), a record that was legal in v4 can exceed the cap.

**Failure sequences:**
- A registry or stage near 16 MiB makes migration step 2 reject the device, so the user can never enable the lock.
- After enabling, a consent or retirement CAS on a near-cap registry fails with a size error. The retirement headroom was computed on plaintext.

The registry is also default-protected under the current wording. `loadRegistry` maps `null` to `emptyRegistry()`. Any wrapper path that reports a locked or undecryptable record as `null` would silently drop the irreversible consent and retirement anti-equivocation state.

**Correction:**
- Allowlist `escrow-lifecycle/device-index-v1` as public. By the design's own description it holds commitments, already-encrypted envelopes and status, not a scalar.
- For protected families, set plaintext caps to `MAX_RECORD_BYTES − ENVELOPE_OVERHEAD` in every size check.
- Add a test with a registry at its cap.

---

### 4. High: Web Locks FIFO plus non-reentrancy can deadlock (implementation risk)

**Design section:** "Enable, disable and change passphrase" (shared vault lease on "every protected read/write"; vault lease acquired before per-game and ceremony locks).

**Source:**
- `online-credentials.ts:194, 415` (`withCeremonyLock` inside the loaders)
- `indexed-db-protocol-journal.ts:464` (`promoteTransfer` acquires the writer lease internally)
- `online-game.ts:180` (the writer lease is held for the game's lifetime, while `masterReveal.store` and other stores are used)

Web Locks grant requests in queue order, so a pending exclusive request blocks later shared requests. Locks are also not reentrant. If the shared vault lease is taken per operation (for example, in the byte-store wrapper), then:

**Failure sequence:**
1. The game worker holds its lifetime shared vault lease and the writer lease.
2. A migration requests the exclusive lock and queues.
3. The game's next master-reveal or escrow load requests shared again, and queues behind the exclusive request.
4. The exclusive request waits for the outer shared lease, and the outer lease waits for the inner request. The system deadlocks.

The same cycle appears when any path acquires the writer lease or a ceremony lock *before* the vault lease. `promoteTransfer` does exactly this unless its caller already holds the vault lease.

**Correction:**
- Take one shared vault lease per *owner* (room, worker, game session, transfer job, deletion) at the top level.
- Inner store calls assert an in-memory `{lease, generation}` token and never request the vault lock.
- Document that `promoteTransfer` and deletion require the caller to hold the lease.

**Test:** an exclusive request queued between an outer and an inner acquisition, in both a tab and a worker.

---

### 5. High: migration does not detect records inserted outside the fence (implementation risk)

**Design section:** "Enable… steps 2–3" ("compare every original record byte-for-byte").

**Source:**
- `transfer-import-store.ts:154, 232, 377` (each opens `openDatabase` directly, bypassing `IndexedDbByteStore`)
- `indexed-db-protocol-journal.ts:#initialize` 257 and promotion 734
- `online-game-deletion.ts:165`

Step 3 checks that scanned records are unchanged. It does not check that *no new keys appeared*. Several writers put `bytes` records through their own connections, so a lease added only to the byte-store wrapper does not fence them.

**Failure sequence:** a lingering transfer job, or an initializing journal, in another tab adds a plaintext stage or binding after the scan but before the migration transaction. The migration commits vault mode with a plaintext private record, or leaves ciphertext behind after a disable. That mixed generation later surfaces as "corrupt", with no repair path.

**Correction:**
- Inside the migration transaction, run `getAllKeys()` on `bytes` and assert it equals the scanned set. Abort on any difference.
- Route every direct writer through the owner lease from item 4.
- On the positive side, the v5 schema bump already forces old-code tabs closed through the `versionchange` handler at `database.ts:43–46`, and later opens by those tabs fail with `VersionError`. Keep that behaviour, and test it alongside a concurrent-stage-during-migration abort.
