# Hexfield v4 private seat-transfer review: findings

I traced the main paths and found **no proven high-severity bypass** of source authority, destination binding or master disclosure. The four findings below are proven from the code shown, but all are Low severity. The more serious risks depend on files I don't have; they are listed at the end.

Paths I checked and consider sound:
- **Historical source authority:** `verifyTransferPrivateEnvelope` checks it at the replayed `sourceParent`.
- **Current pending check:** `stillPending` requires the exact authorization to still be pending at the current head.
- **Destination binding:** the private key is used only after authentication, the encryption point must match `transferEncryptionKey`, and the seal context binds every outer field.
- **Return disclosure:** a return packet must carry exactly the affected masters and no custody.
- **Live-successor custody:** `lawfulSuccessor` follows the chain of live transfers from the original recoverer key.
- **Buffer wiping on normal error paths:** secrets are wiped in `decodePlaintext`, `loadImportedCustody`, `collectCustody` and `importTransferPrivate`.

## Proven findings

### 1. Unauthenticated packets trigger two full chain replays: Low (resource exhaustion)
**Where:** `importTransferPrivate` → `verifyHistoricalPacket` (transfer-private.ts)

**What happens:** `importTransferPrivate` replays all of `input.entries` before it even schema-checks the packet. `verifyHistoricalPacket` then replays the prefix up to `sourceParent` a second time. Only after both replays does anyone look at the source key or signature.

**Counterexample:**
1. Any peer on the transfer bootstrap takes the public `authorization` and head `{seq, hash}`.
2. It sends a schema-valid packet with `sourceParent` set to the current head, a random `sourceSigner.publicKey` and a zero `sourceSig`.
3. The destination performs two full replays, then rejects the packet at `authorizeSource` or signature verification.
4. Repeating this costs the destination two full replays per junk packet.

The `MAX_PACKET` check is also effectively dead: the strict schema already bounds the encoding to roughly 6.3 KB.

**Fix:**
- Parse the packet and verify `sourceSig` against the claimed `sourceSigner.publicKey` before any replay.
- Capture the `sourceParent` context through the first replay's `onEntry` hook instead of replaying again.

### 2. Secret copies made before `try` are never wiped if a later copy throws: Low
**Where:** top of `prepareTransferPrivate`

**What happens:** `signingKey`, `entropy`, `nonce` and `supplied` are copied before the `try` block starts.

**Counterexample:**
- A caller passes a valid `signingKey` but `masters: [{ seat: 0, master: undefined }]`, or an `entropy` value without `.slice`.
- By the time the later copy throws, `signingKey.slice()` has already produced an owned copy of the key.
- That copy (and any earlier master copies) is never zeroed, and the function rejects instead of returning a `Result`.

A related issue: on a Node `Buffer`, `.slice()` returns a view, not a copy. The `finally` block would then zero the caller's own buffers. `importTransferPrivate` has the same `Buffer` issue with `destinationEncryptionSecret`.

**Fix:**
- Declare the variables before `try` and make the copies inside it, so `finally` always wipes them.
- Copy with `new Uint8Array(x)`, as `verifyRevealedMaster` already does.

### 3. A lawful return loads every custody record the recoverer holds: Low (least privilege and availability)
**Where:** `collectCustody` when called from the return branch of `prepareTransferPrivate`

**What happens:** In return mode, the roots loop loads the recovery-private record for every root where the source is a lawful recoverer, not just `statement.recovery.authorization`. Only afterwards does `prepareTransferPrivate` pick out the one it needs.

**Counterexample:**
1. Seat 1 is the recoverer for two completed recoveries: seat 0 (root X) and seat 3 (root Y).
2. Seat 1's `recovery-private` record for Y is missing or corrupt.
3. A certified return for seat 0 fails with a `loadRecoveryPrivate` error, even though X's record is intact.
4. When Y's record is present, seat 3's masters are loaded into memory for a packet that never uses them.

**Fix:** In return mode, load only the named final authorization.

### 4. A source that loses its signing key after writing the outbox cannot retransmit: Low (availability, forces extra disclosure)
**Where:** the outbox reuse path of `prepareTransferPrivate`, and `outboxId`

**What happens:** The outbox slot is keyed only by `(authorization, sourceSeat)`. Returning the saved packet requires the caller's `signingKey` to derive a signer that matches the saved packet's key and kind.

**Counterexample:**
1. A live owner prepares with `current-controller`; the packet is durably written to the outbox.
2. The owner then loses the game key before delivery.
3. Retrying with `certified-device` returns `Saved packet has a different source`.
4. Retrying with the game key is impossible. The valid, already-signed bytes can never be returned again.
5. The only way forward is cancel plus a fresh authorization, which discloses the masters to a second destination key.

This is exactly the key-loss case the design says the device path should cover.

**Fix:** Let a retransmit return a historically verified saved packet without re-deriving the signer, while keeping the current `authorizeSource` check for the requested kind.

## Missing context (not proven)

- **Recovery while a transfer is pending.** Everything above assumes `recovery-membership.ts` rejects `recovery-authorize` while any transfer is pending (that file is modified but not shown). If it doesn't:
  - A live source could be frozen or departed during pending, and its historical packet would still import, because import only checks source authority at `sourceParent`.
  - Import validates custody at the current head, but `loadImportedCustody` re-validates at the historical parent. The two could disagree, so a destination could activate and later be unable to reopen its own import.
- **Controller `status` values other than `'active'` for bots.**
  - The roots loop in `collectCustody` checks only `kind === 'bot'` for the departed seat.
  - `decodePlaintext` also requires `status === 'active'`.
  - If a latest-root departed bot can have another status, prepare seals custody that every destination rejects.
  - Because the outbox is immutable and prepare never runs its own plaintext through import-side validation first, that authorization is permanently wedged.
- **Rewrites of `activatedAt`.** If any certified transition rewrites a human's `activatedAt` without re-keying (for example, recovery activation touching the recoverer's record), `loadImportedCustody` silently returns `[]`. The `priorLive` guard doesn't fire either. The result fails closed through the missing recovery-private record, but a lawful transferred recoverer would lose its custody.
- **A spurious failure for returned humans.** For a human whose `activatedAt` comes from a return completion, passing `importStore` requires that old return-import record to exist. Omitting `importStore` succeeds instead. Please confirm this asymmetry is intended.
