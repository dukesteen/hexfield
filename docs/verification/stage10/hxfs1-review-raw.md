# HXFS1 full-save review: findings

Six findings, ordered by severity. Each is marked **Proven** (the supplied source shows it) or **Contract** (it depends on an input contract the source doesn't enforce).

---

### 1. Private plaintext copies are never wiped (Proven, Medium)

**Where:** `online-full-save.ts`
- `encodeOnlineFullSave`, line 526
- `validateOnlineFullSave`, line 705
- `checkedPrivate` store stub, line 270

**Trace:**
- **Encode.** `plaintext = canonicalEncode(privateValue)` holds every master and accepted share, and the `finally` at line 550 zeroes it. However, `crypto.subtle.encrypt(..., new Uint8Array(plaintext))` passes a second full copy. Nothing keeps a reference to that copy, so it is never zeroed.
- **Import.** `sameBytes(canonicalEncode(parsedPrivate.output), plaintext)` re-encodes the decrypted capsule into a fresh buffer and then drops it without zeroing. This happens on every `openOnlineFullSave` with a passphrase and every private `importOnlineFullSave`.
- **Store stub.** `records.get(id)?.slice()` gives `loadAcceptedShare` a copy of each accepted-share record. Nothing wipes those copies.

**Fix:**
- **Encode.** Pass `plaintext` directly to `encrypt`. It is already an owned buffer, and WebCrypto copies its input.
- **Import.** Keep the re-encoded buffer in a local and `fill(0)` it in the inner `finally`.
- **Store stub.** Collect the slices returned by `load` in an array and zero them after the `loadAcceptedShare` loop.

---

### 2. Escrow export zeroes whatever buffer the store returns (Contract, Medium: possible irreversible share loss)

**Where:** `collectOnlineFullSavePrivate`, lines 363–365, together with `ownedPrivate().dispose` at line 189 and `exportOnlineFullSaveFromJournal` at line 639.

**Trace:**
1. `bytes = await escrowStore.load(id)` is pushed into `escrow` as-is. No copy is made.
2. When export finishes, `privateMaterial.dispose()` calls `bytes.fill(0)` on that same buffer.
3. `IndexedDbByteStore.load` returns `.slice()`, so it is safe. But nothing in the `EscrowCeremonyStore` type requires a fresh buffer. Compare `loadOwnedMaster`, whose doc comment does promise a fresh owned buffer.
4. Any store that returns its retained buffer would therefore have its only copy of the holder's accepted share zeroed by an export. Examples: an in-memory adapter, or a cache in front of IndexedDB.

**Fix:** Push `new Uint8Array(bytes)` and zero `bytes` in a `finally`. This matches how masters are already handled at lines 345–347.

---

### 3. Untrusted outer structure is decoded and fully traversed before any shape bound (Proven for the traversal; decoder limits are missing context; Medium, local DoS)

**Where:** `validateOnlineFullSave`, line 658 (decode) and line 750 (`wipe(decoded)`); `wipe`, lines 131–139.

**Trace:**
1. A crafted file of up to 25 MiB decodes to, for example, a top-level array of about 25 million `null`s.
2. `saveSchema` rejects it. But `decoded` was already assigned, so the `finally` still runs `wipe(decoded)`.
3. `Reflect.ownKeys` on that array builds an array of about 25 million index strings, on top of the decoded array itself. That is enough to exhaust memory and crash the tab.
4. `wipe` is also unbounded recursion. If `canonicalDecode` allows nesting deeper than the JS stack, `wipe` throws from inside `finally`. That throw replaces the `Result` with a rejected promise for direct callers such as the UI query.
5. The outer file contains no plaintext secrets. Its only byte fields are `publicArchive`, `safety.bytes` and `ciphertext`. So this generic traversal protects nothing.

**Fix:**
- Remove `wipe(decoded)`.
- In the `finally`, zero only the schema-parsed byte fields (`parsed.output.publicArchive`, `parsed.output.safety.bytes`, `parsed.output.private?.ciphertext`).
- Optionally run the existing node/depth preflight (`withinCanonicalBounds`) before `safeParse`.

---

### 4. The KDF guard throws, and the throw is reported as a corrupt file (Proven, Low–Medium)

**Where:** `cryptoKey`, line 391, as called from `validateOnlineFullSave` line 684 and `encodeOnlineFullSave` line 512.

**Trace:**
1. Two passphrase operations overlap. For example: an open query refetches while an import is running, or an export overlaps an unlock.
2. The second call throws `'A full-save key derivation is already running'`.
3. In `validate`, line 684 is outside the inner try, so the outer catch at lines 745–746 returns `full-save-format` ("could not be validated"). The UI will tell the user a valid save is malformed.
4. In `encode`, the same throw surfaces as `full-save-encode`.
5. Separately, the passphrase has a minimum length of 12 but no maximum before `TextEncoder` and `importKey` run.

**Fix:**
- Serialize derivations through a module-level promise chain so they queue instead of throwing. At minimum, catch the throw and return a distinct `full-save-busy` failure.
- Reject passphrases longer than a fixed cap, for example 1024 characters, before any encoding.

---

### 5. Safety metadata `revision` is authenticated by nothing (Proven, Low)

**Where:** `safetySchema` (line 44), `checkedSafety`, `aad` (lines 416–424) and `privateBinding`.

**Trace:**
1. `safetyHash` covers only `safety.bytes`.
2. `seat` and `publicKey` are indirectly pinned, because `checkedSafety` restores the record against them.
3. `revision` is checked by neither `checkedSafety`, the AAD, nor the private capsule.
4. Anyone who edits the file can therefore set any revision. The capsule still decrypts, and `VerifiedOnlineFullSave.safety.revision` returns the forged value as "evidence of prior local safety."

**Fix:** Either include `revision`, `seat` and `publicKey` in both `aad()` and `privateBinding`, or drop `revision` from the format. Backwards compatibility is not required, so either is cheap.

---

### 6. Export unseals and verifies masters before checking the passphrase (Proven, Low)

**Where:** `exportOnlineFullSaveFromJournal`, lines 601–614, compared with the passphrase check in `encodeOnlineFullSave` at lines 466–470.

**Trace:**
1. A caller sets `includePrivate: true` with a passphrase that is missing or shorter than 12 characters.
2. `loadOwnedMaster` is called for every hosted seat. Each master is copied and put through a full `verifyRevealedMaster` check, and escrow records are loaded.
3. Only afterwards does `encode` reject the export with `full-save-passphrase`.
4. Secrets are pulled into memory, and an expensive replay is done, for an export that could never succeed.

**Fix:** Check `passphrase` (present and at least 12 characters) at the top of `exportOnlineFullSaveFromJournal`, before calling `collectOnlineFullSavePrivate`. Also reject `passphrase` when `includePrivate` is false.

---

### Missing context (not reported as defects)

- **Holder rule on import.** Export requires the holder to be an active human controller (line 322). The import path, `checkedPrivate`, only requires the holder to be a voter whose key equals `safety.publicKey`. Whether a non-human or inactive holder can still be a voter depends on the authority rules, which weren't supplied. Moving the human/active check into `checkedPrivate` would make both paths enforce the same rule.
- **Byte views from the decoder.** The supplied test round-trips import then open, which implies `canonicalDecode` copies byte strings rather than returning views. If it ever returned views, `wipe(decoded)` would zero the caller's input before the chunks are written. Finding 3's fix removes that hazard as well.
- **Size budget.** Whether the 25 MiB cap covers the byte-tag expansion of a 16 MiB archive plus 1 MiB of safety plus 1 MiB of private data depends on the codec's byte encoding, which wasn't supplied. At a 4/3 expansion it fits, at about 24 MiB.

### Untested paths

The supplied tests never exercise:
- `escrowComplete: true`, meaning the `EscrowCeremony` validation inside `checkedPrivate`
- concurrent KDF calls
- tampering with safety metadata

The chunk/manifest crash handling, content-address checks, capsule transplant resistance (via `publicHash` and `safetyHash` in both the AAD and the plaintext) and the export stale-head recheck all look correct as written.
