Four findings, most severe first. Finding 1's storage-level behaviour is proven; turning it into a safety violation depends on context I don't have, which is stated separately.

---

### 1. High (conditional): an already-promoted activation can be staged and promoted again with fresh safety

**Where:** `packages/storage/src/transfer-import-store.ts` `TransferImportStore.stage` / `saveReadiness`, and `packages/storage/src/indexed-db-protocol-journal.ts` `#promoteTransfer`.

**Proven:**
- `stage` replays only the supplied prefix. It accepts any authorization that was pending at that prefix's head, and never checks the local journal, binding, or any record of past promotions.
- `#promoteTransfer` deletes exactly `stageKey` and its readiness, which frees that slot for a new `putIfAbsent`.
- Promotion accepts an activation at any depth in history. With `expectedActive: null`, it only checks that four records are absent.

**Counterexample:**
1. Device D promotes authorization X at parent P, with activation A. Key K2 then votes at heights A+1 through N.
2. The source retransmits the sealed package because it never saw an ack. The participant decrypts it and calls `stage(prefix…P, B2)`. This succeeds: the prefix still shows X pending, and `validatePendingTransferMaterial` passes. `saveReadiness` succeeds too.
3. Result (a), proven: a second durable copy of the active K2 signing key and every hosted master now sits outside the binding. It survives any later rekey or transfer-away that erases the binding.
4. Result (b), conditional: suppose `games`/`entries`/`consensus` and `online-game/<digest>/keys` are later removed while `transfer-import/*` keys remain. Examples would be a leave/delete-game path, a reset, or the same destination credentials restored in another profile or origin. Then `promoteTransfer({expectedActive: null, activation: A})` passes every check and writes `{height: A+1, revision: 0, votes: []}` for K2. K2 can then sign a second, conflicting vote at A+1.

**Missing context:** whether any such deletion path or credential export exists.

**Fix:** In the promotion transaction, write a never-deleted tombstone keyed per game and authorization hash, or per destination game key. Reject in `stage`, `saveReadiness`, and `#promoteTransfer` when the tombstone exists. The tombstone check in `stage` must run in the same readwrite transaction as the insert; the current single-key `putIfAbsent` can't express that.

---

### 2. Medium: imports that are never promoted keep signing keys and masters forever

**Where:** `#promoteTransfer`, which deletes only `options.stageKey` and its readiness. `TransferImportStore` has no delete API at all.

**Counterexample:** Readiness binds the exact parent, and a pending authorization persists while the game continues, so staging more than one parent is normal:
- **Stale parent:** stage at P1, the head advances, stage at P2, activation lands at P2. The P1 record stays forever with B2 (the new signing key and the master of every hosted seat) plus `privateReplayBytes`.
- **Cancelled authorization:** every stage for it stays, including on a destination device that never activated.

Masters reproduce the shuffle, lock, and steal secrets (`verifyRevealedMaster`), which amounts to that seat's full hidden information for the whole game. These records also outlive the binding erasure that `validateRetiredTransferBinding` is designed to precede.

**Fix:** Inside the promotion transaction, delete the whole `transfer-import/<gameId>/` key range (or at least that authorization's range). Add the same cleanup when a certified cancellation or a newer authorization is replayed.

**Missing context:** whether a sweeper exists elsewhere.

---

### 3. Low: secret copies are never wiped

- **`indexed-db-byte-store.ts` `load`:** it returns `value.slice()` and drops the original `value` without wiping it. That original is the full stage record including the binding. This happens on every `TransferImportStore.load`: the stage retry comparison, `saveReadiness`, and promotion.
- **`indexed-db-byte-store.ts` `putIfAbsent`:** the `value` copy is never wiped, on either the insert path or the already-exists path.
- **`indexed-db-protocol-journal.ts` `#load`, `#loadSafety`, `#saveSafety`, `#commit`, `#initialize`:** the fetched `bindingBytes`/`bindingExists` is compared and then dropped unwiped. Every persisted vote leaves another heap copy of the active signing key and masters. By contrast, `#promoteTransfer` does call `existingBinding?.fill(0)`.
- **`#promoteTransfer`:**
  - The `keyBinding.bytes.slice()` passed to `put` is never wiped.
  - `storedStage` is left unwiped if the readiness `get` rejects before the `fill`.
  - `staged.sealedPackage` is never wiped. That is only acceptable if it's ciphertext the device can no longer open.

---

### 4. Low: size bounds

- **`stage`:** `entryHash(last)` runs on unvalidated input. Then a full `v.parse` over an unbounded `v.array(certifiedEntrySchema)` and a full `canonicalEncode` both run before the `MAX_RECORD_BYTES` check. Replay correctly comes after the bound; the parse, encode, and hash don't. Whether the participant bounds decrypted plaintext is missing context.
- **`#promoteTransfer`:** it writes staged entries with `entries.add(canonicalEncode(entry))` without applying `this.#maxRecordBytes`. The only bound is the 16 MiB whole-stage limit from a separate, default-limit store. On a journal configured below 16 MiB, a successful promotion can commit an entry that `#load`/`decodeRecord` then rejects permanently. At that point the old key is erased and the new key is certified-active, so the seat is bricked. This doesn't apply if production always uses the default limit.

---

**Checked and found sound:**
- The in-transaction re-comparison of stage, readiness, binding, genesis, and head, plus the rollback on abort.
- Old key-bound instances failing `saveSafety`/`commit`/`initialize` after the binding is replaced.
- The retired-marker branch being limited to `existingKeys.length === activation.seq`.
- Return-root selection by exact activation reference.
- The same-device and same-seat check against `oldMaterialKey`.
- No path lets a staged record be opened as a voting journal.
