# Review: Hexfield protocol v4 transfer follow-up

Three findings. #1 and #2 are proven mismatches in the code shown; for each I note which part depends on code that wasn't included. #3 only applies if the codec returns Buffer views.

---

### 1. Medium–High: a live-transferred, formerly-human bot has no path to a beacon provider

**Where:** `p2p-session.ts` `installRecovery`, `recovered-host.ts` `loadRecoveredHost`, `replicated-log.ts` `installAuthorityOwnership`

**Proven:** the replica's contract and the session's install hook can't both be satisfied for a seat whose key is present but whose beacon source is missing.

**Counterexample:**
1. Seat 0 (human) departs. Seat 1 recovers it. R=0 becomes a bot hosted by seat 1, with a beacon chain because it was formerly human.
2. Seat 1 live-transfers to device D with replacements `[1, 0]`. R's controller now has a fresh key and `activatedAt` = the transfer activation.
3. D restores with `botKeys` containing seat 0. `installAuthorityOwnership` sees the key matches, but `hasBeaconChain(0)` is true and there is no beacon source. So `missing = [0]` and `beaconSeats = [0]`.
4. The hook runs `installRecovery`, which keeps only seats where `!this.keys.has(seat)`. That leaves `seats = []`, so it returns `success(null)`.
5. Omitting seat 0 from `botKeys` doesn't help. `loadActivatedRecoveryKeys` has no readiness key for a transfer-installed key, and `recovery.completed.find(activation === controller.activatedAt)` misses because the activation is a transfer, not a recovery.
6. Even a hook that returned only the beacon would fail the replica's `ownership.keys.size !== missing.length` check, because `missing` includes seats that are only missing a beacon.

**Missing context:** what happens next depends on two things not shown:
- how `installAuthorityOwnership` handles a `null` ownership;
- whether `ReplicatedLogOptions` can seed bot beacon sources at restore.

The outcome is either a `replica-recovery-keys` failure, or R silently has no provider until a beacon step stalls the game.

**Minimal fix:**
- In the replica, split `missing` into key-missing seats and beacon-only seats. Compare `ownership.keys` against the key-missing set only.
- In `installRecovery`, build providers for beacon-only seats from the certified imported master (`ImportedTransferPrivate.masters`, or validated `TransferOwnedMaterial`). Use the same chain-tip check as `loadRecoveredHost`.
- If seeding from restore options is the intended path instead, make `P2PSession.open` fail closed when a hosted bot with a chain has no source.
- Add a test that live-transfers a host carrying a recovered bot.

---

### 2. Medium: restore reconciles `this.keys` but validates and forwards the unreconciled `options.botKeys`

**Where:** `p2p-session.ts` `open` (restore branch)

**Proven:** `reconcileBotOwnership` only removes seats that came from `options.botKeys`. `validateSessionKeys(replayed…, options)` then checks every one of those same keys against current authority. So on restore, reconciliation either does nothing or the whole restore fails. `safeOptions.botKeys` also still hands the retired key to `ReplicatedLog.restore`.

**Counterexample:**
1. D from finding #1 hosts R. Seat 0 then returns via a certified return.
2. While D's session is live, this works correctly: `applyCommit` runs reconcile and the replica prunes seat 0.
3. D reloads with its stored binding. The driver is built owning `[1, 0]`, replay succeeds, and reconcile relinquishes seat 0.
4. `validateSessionKeys` then fails with `session-bot-key` because seat 0 is now human.
5. The session is disposed, so seat 1's human and its remaining bots are unusable. This contradicts "without wiping remaining seats".
6. The caller has no helper to pre-filter the stale key: `validateTransferOwnedMaterial` rejects the old binding because its seat set no longer matches.

Non-transfer old hosts don't hit this, because their recovered keys arrive through `installRecovery` rather than `botKeys`. That is why the p2p-recovery test passes.

**Minimal fix:**
- After reconcile, derive `retained` = `this.keys` minus `options.seat`.
- Run `validateSessionKeys` over `{ seat, secretKey, botKeys: retained }`.
- Pass `botKeys: retained` in `replicaOptions`.
- Add a test: restore after a return with a stale bot key, and assert seat 1's private state survives.

---

### 3. Low (only if the codec yields Buffer views): the restored encryption secret may alias memory that is later wiped

**Where:** `online-transfer-credentials.ts` `restoreRecord` / `prepareOnlineTransferCredentials`

**Counterexample:**
1. `restoreRecord` returns `record.encryptionSecret.slice()`, and its `finally` then runs `bytes.fill(0)` and `wipe(record)`.
2. If `canonicalDecode` returns a Buffer, or a Buffer-backed subarray (e.g. the Node store or tests), then `Buffer#slice` is a view, not a copy.
3. The returned secret is then all zeros. `importTransferPrivate` rejects it via `scalarFromBytes(…, { nonzero: true })`.

In browsers, `Uint8Array#slice` copies, so this is safe there. It is the same pattern this diff replaced in `replicated-log.ts`.

**Fix:** use `new Uint8Array(record.encryptionSecret)`, and likewise `new Uint8Array(recordBytes)` for the `restoreRecord` argument.

---

### Checked and holding
- **Import ordering:** `importTransferPrivate` authenticates the bounded signature before replay, captures the source context during the single public replay, re-checks `stillPending`, and binds the destination key before opening.
- **Plaintext ownership:** `decodePlaintext` returns fresh copies and wipes the decoded plaintext.
- **Master ownership:** `reconstructPrivateSeats` and `loadRecoveredHost` keep independent master copies, and the test covers this.
- **Return filtering:** the recovery-store loop filters by `onlyAuthorization` before `loadRecoveryPrivate`. The prior-import path necessarily opens the whole sealed plaintext and only filters the copies afterwards. Given a single seal, that is unavoidable, not a leak.
- **Outbox retransmit:** the current caller is authorized now, the saved envelope is re-verified at its historical parent, and it is checked against the current pending authorization.
- **Retirement:** retirement is now keyed by (seat, publicKey) on both restore and commit.
- **Old-host cleanup after a return:** session reconcile, replica prune and `RecoveredHost.releaseSeat` together remove the old host's signing, driver, deck and beacon access for seat 0 without touching seat 1. Historical replay still works.
- **Credential generation:**
  - human key first, then bots in ascending seat order;
  - device, game and bot keys use distinct signing domains;
  - collision checks against reserved keys;
  - the reservation is written under the lock before any public key or signature is returned.

### Missing context, not reported as bugs
- **`VerifiedSessionDriver.relinquishSeats`:**
  - It deletes `blindings` without zeroing them. That matters only if they are byte arrays.
  - It calls `wipePrivateBytes` on `ext`, which assumes no `ext` object is shared with another seat or with public context.
- **Retry signatures:** `restoreRecord` re-signs on every retry. If `signObject` is randomized, a retry produces a different change hash. `enqueueMembership` then returns `recovery-intent-pending`, or `settleMembership` returns `renewed-intent`, even though the same statement actually committed.
- **Recovery during a pending live transfer:** if a recovery can complete while a live transfer is pending, `collectCustody` on the destination fails outright for any root whose private record exists only on the old device.
