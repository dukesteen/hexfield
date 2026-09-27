# Follow-up review: return-prefix fixes

**Verdict:** Fix (1) is sufficient as a fail-closed guard and I found no regression in it. Fix (2) closes only the exact replay of the immediately previous answer. Replay of an older answer, or a trivially altered one, still gets through. That is an availability bug, not an integrity bug. Item (3) looks correct at the call site I can see, but the excerpts don't prove the promotion side.

## (1) Conflicting certified next-height decision: sufficient

**Decision and unapplied certificate handling:**
- `indexed-db-protocol-journal.ts:785-793` and `online-transfer-destination.ts:1346-1358` check both `decision` and `unappliedCertificate` against the imported entry at the next height.
- The indexing is consistent in both layers. `fullEntries[i]` is seq `i+1` (`:809-817`), so index `existingKeys.length` is the next height.
- If the import has no next entry, any retained certificate is rejected. That is correct.

**Same signed entry vs divergent fork:**
- Both layers compare by `entryHash` or `transferEntryRef` (seq + hash), not by certificate bytes.
- A different quorum certificate over the same signed entry is therefore accepted (`:807-808`). A different entry at the same height is rejected.
- This matches the stated intent. A false rejection would need two certificates for different entries at one height, which is already a quorum-intersection failure.

**Active vs retired after certified removal:**
- The branch is chosen by whether `retiredKey` is a voter in the replayed stored prefix (`:781`), not in the imported context. That is the right frame.
- Before removal: the full safety state is restored and pinned to `localPublicKey === retiredKey` (`:783`).
- After removal: `restoreRetiredSafety` is required, and an active marker fails there. The test at `online-transfer-destination.test.ts:834-841` covers this.
- The fork check (`:809-820`) runs after the safety check. Because everything throws inside one transaction, the order only changes which error message you see.

**Transaction-held replay:**
- Binding bytes, genesis, key count, head hash, safety height, prefix replay, safety restore and the prefix match are all re-derived inside the IDB transaction (`:720-820`).
- The web pre-check at `:1280-1373` is therefore advisory only; its time-of-check/time-of-use gap is closed by the storage recheck.
- `existingBinding?.fill(0)` (`:729`) runs after `bindingMatches` is computed, and the `!== undefined` check at `:737` is unaffected by zeroing.

**Minor (liveness only, fails closed):**
- `online-transfer-destination.ts:1320-1326` derives `oldKey` from `next.replay.context.log.transfer.returnRoots` (post-activation context).
- Storage derives it from `before.value.context` via `oldMaterialKey` (`:777`).
- If activation changes `returnRoots` for that seat, the two layers could disagree. The result would be a spurious rejection, not an acceptance.
- Fix: derive the web-side key from the pre-activation replay with the same `oldMaterialKey` helper.

**Hygiene (not a vulnerability):**
- `online-transfer-destination.ts:1335` zeroes `saved.safety.bytes` before `restoreConsensusState` uses `marker`.
- This is only safe if `canonicalDecode` copies byte fields rather than returning subarrays. If it returns views, the result is again a spurious rejection.
- The storage side uses the correct order: decode, use, then `wipeDecodedBytes` (`:805`). Mirror that ordering in the web layer.

## (2) Old RTC answer with a fresh revision: incomplete

**Remaining issue:** `packages/p2p/src/peer-link.ts:213-214`.

The stale-answer filter only matches an answer byte-identical to `currentRemoteDescription`, which is the most recently applied answer. Two cases still pass while a newer local offer is outstanding:
- An answer from two or more negotiations ago (A1 replayed during O3, after A2 was applied).
- The previous answer with any SDP change, such as an extra attribute line.

Either one is applied to the new offer at `:243`. After authentication, the fingerprint gate at `:219-230` does not stop it, because the DTLS certificate is unchanged for the life of the connection. On an ICE-restart offer this installs stale remote ICE credentials, and the link can fail.

- **Impact:** availability only. The DTLS fingerprint pin means the attacker cannot substitute a peer.
- **Exploitability:** it depends on whether the relay can mint `revision` values. If `revision` is covered by the peer's signature, only a buggy peer can trigger this, which makes it a proof gap rather than an attack.

**Possible regression from the fix:** under JSEP, the session version is only bumped when the generated SDP changes. A legitimate answer to a renegotiation offer that changes nothing can therefore be byte-identical to the previous answer. The new check would drop it and leave the link stuck in `have-local-offer`. This is unlikely for a data-channel-only link, but real.

**Minimal fix:** bind each answer to the offer it answers.
- Send `inReplyTo: blob.revision` with the answer at `:254-258`.
- Record the revision of the local offer when it is sent.
- At `:209`, drop any answer whose `inReplyTo` doesn't equal the current local offer revision.
- Remove the SDP-equality clause.

This handles exact replays, older replays and mutated replays, and it lets a legitimate identical answer through.

If a protocol change isn't acceptable, a stopgap is to keep a per-generation set of every applied remote answer SDP and reject any member. That covers exact old replays but not mutated ones.

**Test gaps:** add a case that replays A1 while O3 is outstanding after A2 was applied. It fails today. Also add a case where a legitimate answer to a no-change renegotiation is identical to the previous answer.

## (3) Game-wide promotion lease: confirmed at the call site, not proven for promotion

- `online-game.ts:180` uses `acquireActiveGameWriterLease` with the game-wide name `cp2p/game-active/…` (`game-writer.ts:38-44`). On loss it disposes the session and transport.

**Proof gaps:**
- `promoteTransfer` receives `leaseOptions`, but the excerpt doesn't show which lease it acquires. Confirm it is `acquireActiveGameWriterLease(gameId)`, not the per-voter `acquireGameWriterLease` (`:29-35`). Confirm it is acquired before the reads at `:720-732` and held until the transaction commits.
- Confirm no remaining caller uses the per-voter lease for active journal writes. That lease name differs per voter, so it would not exclude a session running under the old key.
- Confirm the same promotion transaction overwrites the old binding (the old signing key) at `recordKey`. Otherwise the old key isn't fenced after its safety is superseded.

## Missing tests for (1)

These are proof gaps, not vulnerabilities:
1. A conflicting `unappliedCertificate`. Only `decision` is exercised in both suites.
2. A positive case: a retained `decision` or `unappliedCertificate` for the same signed entry under a different quorum certificate. Promotion should succeed and keep the local certificates.
3. A storage-level promotion that succeeds with an existing active or retired journal. This would prove the in-transaction replay stays synchronous, since an awaited non-IDB promise would auto-commit the transaction and fail the later writes.
