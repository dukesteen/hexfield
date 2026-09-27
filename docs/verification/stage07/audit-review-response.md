# Review: certified audit and reveal (`24b7296`) with live recovery integration

This was a static read of the supplied bundle. I ran nothing and wrote no plan file, because no tools were available. The line of code for each finding is quoted by function name.

## Demonstrated defects

### 1. Any `historyError` report becomes a generic `audit-report-context` error. Severity: High

**Where:** `P2PSession.finishAudit` in `p2p-session.ts`.

**What happens:** `finishAudit` requires `report.terminal` and `report.finalHead` to be non-null and to match the session head. `auditCertifiedGame` sets `finalHead` only after the whole public replay succeeds, and sets `terminal` only if replay reaches the first result entry.

**Failure sequence:**

1. The session certified history under its own `options.policy`.
2. The worker replays it under the stricter `baseAuditPolicy`, and replay fails at some entry.
3. The worker returns `{historyError, finalHead: null, terminal: null or set}`.
4. The session discards the report and stores `{kind:'error', code:'audit-report-context'}`.
5. `retryAudit()` reruns the same audit and gets the same result, forever.

**Impact:** The most important independent-audit outcome, "certified history does not verify under built-in policy", can never reach the UI.

**Minimal correction:**

- Correlate on the job identity, which `auditJob === running` already provides.
- Correlate on the input's own head: compute `{seq, hash}` from `input.entries.at(-1)` when the job starts.
- Check `terminal` and `finalHead` only when they are non-null. When `historyError` is set, require `finalHead === null` or an exact match.

**Regression:** Use an injected runner that returns `auditCertifiedGame` over entries with a corrupted certificate, as in the existing `audit.test.ts` case. Expect `getAudit()` to be `{kind:'complete', report}` with `report.historyError` set, not `error`.

### 2. Reveals are never relayed, so late or restarted peers can stay in `awaiting-reveals` permanently. Severity: High (liveness and durability)

**Where:** `ReplicatedLog.receiveMasterReveal`. It requires `membership.voters[publisherSeat].publicKey === from`, and nothing re-broadcasts accepted packets.

**Why relay is safe:** The packet is signed, and `verifyMasterReveal` authenticates the publisher from the certified context. The `from` check is therefore anti-spam, not authentication.

**Failure sequence:**

1. Human A's reveal reaches B but not C, because C is offline or behind the terminal commit.
2. A closes the tab after the game.
3. C syncs to the result. Only A can deliver A's master, so C waits forever.
4. The same happens to any peer whose reveal store is lost or reset.

A recovery cannot rescue this. `validateRecoveryTransition` rejects any change after a result (`recovery-finished`), so no other peer can ever become A's authorized publisher.

**Minimal correction:**

- Accept `MASTER_REVEAL` from any current voter. Keep the signature check against the certified publisher.
- Rate-limit per sender and per `(originalSeat, hash)`.
- In `pulse`, rebroadcast the exact accepted packets from `coordinator.reveals()`, not only local ones.

**Regression:** Use three humans, drop A→C reveal traffic, deliver A→B, then dispose A. C must reach `verifying` or `complete`. On the current code, C stays `awaiting-reveals` with A's seat missing.

### 3. Reveal-stage failures abort `offerAvailableInput`, which blocks post-result consensus. Severity: Medium

**Where:** `ReplicatedLog.prepareMasterReveals` runs first in `offerAvailableInput`. It returns failure from four places:

- `if (!sent.ok) return sent;` on a transport broadcast failure. Every other preparer only reports status in this case.
- A failed `eligibleSeats` or `metadata` call, from a journal read error.
- A `metadata` head mismatch.
- A failed `restoreMasterReveals`.

**Failure sequence:**

1. The game ends.
2. A cheat claim or accusation, or a locked `valid` value, needs proposing at a post-result height.
3. The local reveal store holds one record whose `receivedAt` is outside the journal. This can happen after an import, device transfer, or a journal and store that were not written atomically.
4. `restoreAccepted` returns `master-reveal-accepted` on every call, and `masterRevealsRestored` never becomes true.
5. Every `offerAvailableInput` returns early, so this peer never proposes. Rounds time out through it.
6. Every incoming reveal also reruns the failing restore, including a full journal replay, before `admitExpensiveRequest` is checked.

**Minimal correction:**

- Make `prepareMasterReveals` best-effort: `this.status({kind:'rejected', …})` and `return success`.
- In `restoreAccepted`, quarantine or skip each invalid record per seat instead of failing the whole restore.
- Move `admitExpensiveRequest` before `restoreMasterReveals` in `receiveMasterReveal`.

**Regression:** Pre-seed the reveal store with a record whose `receivedAt.seq > head`, then submit a valid historical cheat claim after the result. It must certify. The other seats' good records must still restore.

### 4. The session never gives the coordinator its recovery private store, so recovered seats can never be revealed. Severity: Medium (integration)

**Where:** `P2PSession.open` passes `options.masterReveal` through unchanged. `MasterRevealCoordinator.prepare` in recovered mode needs `recoveryPrivateStore`. Without it, `master` stays null and every pulse reports `master-reveal-source`.

The session already holds the same store as `options.recoveryStore` or `recoveryParticipant.store`, which `installRecovery` uses. A caller who configures recovery but not `masterReveal.recoveryPrivateStore` therefore gets an audit stuck in `awaiting-reveals` after any recovered game. This is exactly the untested "complete recovered-game audit" path.

**Minimal correction:** Default `masterReveal.recoveryPrivateStore` to `options.recoveryStore ?? options.recoveryParticipant?.store`. Alternatively, fail `open` when recovery is configured and the store is missing.

**Regression:** Continue the live-recovery session regression to a result. The recoverer sessions must publish the departed seat's original master (`verdict: 'valid'`), and the audit must complete with `missingSeats: []`.

### 5. Private-replay seat attribution is broader than owner-provable faults. Severity: Medium

**Where:** `auditCertifiedGame`, in the second `replayCertifiedPrefix` callback. `failureSeat` is set from the entry type (the draw recipient or the steal victim) before any work runs. It is then used for every failure in that entry, including:

- `audit-draw-context` and `audit-steal-context`, which mean certified context is missing.
- The `audit-private-input` catch-all.
- Engine `applyRecorded` failures such as `private-invariant` or a hand-bounds failure on another seat.
- `audit-state-hash`.

None of these proves misconduct by that seat. Separately, `audit-internal-failure`, `genesis-failed`, `audit-genesis-state` and cross-check exceptions (`private-replay-failed`) all land in `violations`. That field is documented as "authenticated inconsistency".

**Minimal correction:**

- Attribute a seat only for specific proof or opening codes: `audit-steal-resource`, a failed steal contribution open, and a draw decode mismatch.
- Use `null` for everything else.
- Route internal failures and engine mismatches to a distinct field, for example `auditError: {code}`. This keeps missing input, proof or processing failure, and cheating separable without parsing `kind` strings.

**Regression:** Inject an engine whose `applyAllPrivates` throws at a `CARD_DEALT` entry. Expect `seat: null`, and expect the failure outside the cheating field.

### 6. Reveal packets share the 3-per-10-second `repair` budget. Severity: Low to medium

**Where:** `admitExpensiveRequest(from, 'master-reveal/…')` uses the default category.

**Effect:**

- A host with four or more original seats (one human plus bots) loses the extra packets each window.
- Those packets consume the same budget as that peer's `SYNC_REQ` and `SNAPSHOT_REQ`, so a peer syncing to the terminal head can have its sync dropped.
- Exact retransmits within the window are also dropped via `seen`.

**Correction:** Add a separate `reveal` category with a limit of at least the roster size.

**Regression:** Use one human hosting five bots. All six reveals must be accepted within one pulse window, and a concurrent sync request must still be served.

### 7. A hung worker leaves the audit in `verifying` with no retry. Severity: Low to medium

**Where:** `createSessionAuditJob` has no timeout, and `retryAudit` requires `auditState.kind === 'error'`. The proof-performance target is still open, so long or hung runs are plausible.

**Correction:** Add a client-side deadline that rejects with a timeout, which `finishAudit` maps to `audit-worker`. Alternatively, allow `retryAudit` to cancel and restart from `verifying`.

**Regression:** A fake worker that never replies must end in `error` after the deadline, and must then complete on retry.

### Minor issues

- **`publisher()` indexes by position:** it uses `genesis.seats[publisherSeat]`, which assumes seat numbers equal array positions. Use `.find(s => s.seat === publisherSeat)`.
- **Double strike on a bad signature:** `receiveMasterReveal` strikes on `master-reveal-signature`, and the `attachTransport` completion strikes again on the `-signature` suffix.
- **`checkMaster` overclassifies failures:** any post-F0 failure from `verifyRevealedMaster` becomes `'inconsistent-genesis'`. That includes context codes (`master-deck-pending`, `master-deck-context`) and the catch-all `master-reveal`. Only the derived-key codes (`master-encryption-key`, `master-beacon-tip`, `master-shuffle-key`, `master-lock-key`) should produce that verdict. The same applies to `audit.ts`, which puts context codes in `violations` against the seat.
- **Missing emit:** `maybeAudit` sets `'unavailable'` without calling `emit`.

## Conditional finding (needs omitted source)

### C1. Non-canonical scalar encodings could falsely accuse the original owner. Severity: High if the condition holds

**Condition:** `@cp2p/crypto`'s `scalarFromBytes` reduces its input mod the group order instead of rejecting values at or above the order.

**What would happen:** The bytes for `s + L` would pass the F0 check in `checkMaster` and in `audit.ts`, which only has an input error for `master-public-key`. The derived keys, however, are computed from the raw bytes in `createStealSecretSource`, `createDeckSecretSource` and `createBeaconSecretSource`. Those keys would not match, so:

- The reveal verdict becomes `'inconsistent-genesis'`.
- The audit records `violations: [{seat, 'master-encryption-key'}]`.
- The original owner is accused because of a publisher's or supplier's encoding.

A recoverer publishing an honest seat's master could trigger this. It would also turn an equal scalar into a `master-reveal-conflict` strike in `receive`.

**Correction (cheap either way):** In both `checkMaster` and the audit's master intake, require `sameBytes(scalarToBytes(scalarFromBytes(b)), b)` before F0. A mismatch is an input error.

**Regression:** Pass the dedicated F0-matching fixture that is still missing, plus a `master + L` case:

- The non-canonical encoding must give `master-reveal-f0`, or an input error, with `violations: []`.
- A genuinely inconsistent genesis must give `'inconsistent-genesis'` and an attributed violation.

## Questions that need omitted source

1. **Built-in proof verification:** With `baseAuditPolicy.entry = {}` (no `verifyCommand`), does `validateCommandForEntry` still verify hand proofs, or does it accept the command? The claim of "mandatory built-in proof verification" depends on `command-validation.ts` and `crypto-context.ts`.
2. **Base64 canonicality:** Does `key32Schema` or `fromBase64Url` reject non-canonical base64 (trailing bits)? `receive` compares masters as strings.
3. **Private-state ownership:** Does `driver.privateState()` return a detached copy? `decideBot` receives it directly.
4. **Result during a pending recovery:** Can a result be certified while a recovery is still pending? A turn player could win by building while the departed seat is frozen. If so, that seat's master can never be revealed, because no completed authorization exists and no recovery can happen after the result. The audit then waits forever with no distinct "unrecoverable" meaning. This is a design question, not a defect, but the report or UI needs a meaning for it.
5. **Post-recovery replay:** Does `replayCertifiedPrefix` verify certificates across post-recovery epochs under `baseAuditPolicy`? The audit fixture contains no recovery.

## Verified as correct in the supplied code

- **Disclosure gating:** Reveals are gated on a durable journal replay reaching the first result. Owned mode requires original, never-replaced controllers. Recovered mode requires a completed authorization and uses the original master from the verified private record. The stored packet is reused, so no new signature is made after restart. Receipts are reauthenticated at their historical head.
- **Disposal paths:** Disposal during journal, source, store or restore work cannot return or retain master buffers in `MasterRevealCoordinator`.
- **Observer failures:** A failure in `onMasterReveal` is retried on the next pulse or receipt.
- **Session audit lifecycle:** Stale jobs are cancelled on a head change, late replies are ignored, buffers are wiped, and a worker failure can be retried without a new entry.
- **Retired keys:** Former humans are limited to `SYNC_REQ`. Bot policy receives only the hosted seat's hand. Recovered steal and draw secrets derive from the original genesis public key and master.

## Integration assessment

The checkpoint is **not yet suitable to wire into the online flow**. Milestones C and D remain incomplete. Essential fixes, in order:

1. **Report correlation (finding 1):** stop masking `historyError`.
2. **Relay and sender relaxation (finding 2):** without it, audits cannot complete once a publisher leaves.
3. **Recovered-seat wiring (finding 4):** default the session's recovery store and add the complete recovered-game audit regression.
4. **Best-effort reveal stage (finding 3):** reveal failures must not block post-result consensus, and restore must be per-record.
5. **Canonical scalar check (C1) and fixture:** add the check plus the F0-matching inconsistent-genesis terminal fixture.
6. **Report fields (finding 5), budget (finding 6) and timeout (finding 7):** narrower seat attribution, a distinct internal-error field, a separate reveal budget, and a worker timeout.

After these changes, rerun the full unit suite; it was not repeated after the scoped fixes. Then run a real browser worker audit.
