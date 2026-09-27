# Review: certified-prefix promotion with retained certificates, and the PeerLink stable-answer guard

**Verdict.** I found no authority, signer-binding, CAS or old-key-revival bypass in this delta. Three things need attention:

- **One real protocol-level gap:** fork evidence in active safety is discarded.
- **One availability defect:** the PeerLink guard is state-based, not offer-bound.
- **One verification item:** the promotion lease against a live old controller.

The remaining items are test gaps.

---

## Defects

### 1. Active-safety branch ignores a conflicting decision at the promotion height (fork evidence erased)

**Where:**
- `packages/storage/src/indexed-db-protocol-journal.ts` `#promoteTransfer`, lines 781–784
- Mirrored in `apps/web/src/session/online-transfer-destination.ts` `observeActivation`, lines 1338–1345

**How it happens:**
1. When the old key is still a voter in `storedContext`, the code only requires two things:
   - `restoreConsensusState(safety, storedContext, seat)` succeeds.
   - `localPublicKey === oldKey`.
2. The restored state may carry `decision` or `unappliedCertificate` at height `existingKeys.length + 1`. Both are certified entries (`consensus.ts:185,188`).
3. That height is the same one where the import supplies `fullEntries[existingKeys.length]`, which is a certified removal or transfer entry signed by `[1,2,3]`.
4. If the two certified entries hash differently, the device holds proof of two certificates at one height. The code then overwrites that proof with fresh safety and appends the imported suffix as if nothing happened.

**Exploitability:** A conflicting certificate needs more than f equivocating voters, so this is not exploitable under the honest-quorum assumption. But it silently destroys the only local fork proof, which is exactly the case this path now admits.

**Smallest fix (both sites):** After the active restore succeeds, reject the promotion if either `decision` or `unappliedCertificate` is present and its `entryHash(...entry)` differs from `entryHash(fullEntries[existingKeys.length].entry)`. In the web site, compare against `next.entries[saved.entries.length]`. Throw a distinct error such as "fork evidence" rather than "invalid safety".

This does not weaken replay or fresh safety.

### 2. PeerLink guard is keyed to signaling state, not to the outstanding local offer

**Where:** `packages/p2p/src/peer-link.ts` `receiveSignal`, lines 206–212

**What the guard gets right:**
- It drops answers received in `stable`/`have-remote-offer`, and a second answer while `isSettingRemoteAnswerPending` is set.
- It is synchronous up to the `await` at line 238, so the pending-flag race is closed.
- It returns before `remoteGeneration` pinning (line 225) and before `remoteRevision` advances, so a dropped answer can neither pin a generation nor consume revision space.
- The authenticated fingerprint check still runs afterwards.

**Residual hole:** Consider a duplicate of answer A1 that carries a *fresher* revision and arrives while a *newer* local offer O2 is outstanding (`have-local-offer`). The new test at `peer-link.test.ts` models exactly this pattern: the same answer resent at revisions 2 and 3.

- The duplicate passes the revision check.
- It passes the new guard, because state is `have-local-offer`.
- It passes the authenticated fingerprint check, because it has the same DTLS fingerprint as `currentRemoteDescription`.
- It is then applied to O2. For an ICE-restart offer this installs stale ICE credentials, or throws and triggers `negotiation-error`.

This is an availability problem only; there is no authentication bypass.

**Smallest fix:** In the guard, also return when `this.pc.currentRemoteDescription?.type === 'answer' && description.sdp === this.pc.currentRemoteDescription.sdp`. A genuine new answer always carries a new `o=` session version. The stronger fix is to have answers echo the local offer revision they answer.

**Minor, low severity:** Dropped answers leave their `earlyCandidates` bucket alive until the next accepted description, which consumes `MAX_EARLY_CANDIDATES` budget. Add `this.earlyCandidates.delete(`${blob.generation}/${blob.revision}`)` in the guard. Do **not** raise `ignoredRevision` there: line 271 would then reject candidates for the currently accepted revision.

---

## Verification items (not demonstrated defects)

### 3. Pre-removal active safety relies on stopping the live old controller

**Where:** web promotion call at lines 1367–1374; storage lines 781–784

**Why it matters:**
- The IDB transaction re-reads safety, binding and head atomically. The CAS on `expected.head.seq`/hash and on binding bytes (lines 743–765) is sound.
- However, a same-origin tab running `ConsensusController` with the old key at height H stays a voter at H in its own view after promotion.
- Web `observeActivation` passes no `leaseOptions`.

**What to confirm:**
- The default `promoteTransfer` lease is the same game-wide lock the running controller holds, so promotion cannot start while that controller is live.
- `saveSafety`'s CAS compares **height and revision**. The new record is `{height: activation.seq+1, revision: 0}`. An old controller with revision 0 would otherwise overwrite it with old-key safety.
  - That would cause a DoS on restore, not revival: `restoreConsensusState` binds to the new voter key.
  - It is still worth pinning down.

### 4. Retained local certificates vs. canonical comparisons elsewhere

Storage now persists the local certificate wrappers, and the test asserts `entries[0]` equals `full[0]`. Any later code that compares journal entries canonically to bootstrap entries, rather than by `transferEntryRef`, will fail closed after a mixed-certificate promotion. Check `#checkImportedCheckpoint` and `loadActiveOnlineResume`. This affects availability, not safety.

---

## Checked and sound

- **Prefix check** (web lines 1298–1316; storage lines 766–811): matching by `{seq, hash}` or `entryHash`, plus an independent `replayCertifiedPrefix` of the persisted prefix, is correct.
  - The appended suffix chains via `prevHash` to a hash equal to the persisted head.
  - An alternative valid certificate cannot change the signed entry.
- **Different valid entry at the same height** is rejected, and the new storage test proves the existing record is left untouched.
- **Retired branch:** it covers `existingKeys.length === activation.seq`, which replaces the removed special case. `restoreRetiredSafety` requires non-voter status, a used key, and height/parent equal to the replayed head.
- **Signer binding in `#returnIntent`** (web, new lines ~818–887). Signing requires all of:
  - a certified `returnRoot.activation`;
  - `lastHumanDevice === identity.peerId`;
  - the key's certified installation generation from replay;
  - `validateRetiredTransferBinding`;
  - a device/peer match.

  Key material is wiped in `finally`, after `signObject` returns. One caveat: `bytes.fill(0)` assumes `store.load` returns a fresh copy. It does for `IndexedDbByteStore`; confirm this for any caching store.

---

## Test gaps

1. There is no test where the pre-removal old safety holds a `decision` or `unappliedCertificate` for a different entry at H (finding 1).
2. There is no storage or web test where a persisted prefix has matching entry hashes but an **invalid** local certificate. That would exercise "Existing active journal has invalid certified history".
3. There is no active-safety test where the old key is a voter but the safety's `localSeat` is a different seat.
4. The first step of the peer-link test "an answer without a local offer…" (revision 1 while stable) is likely rejected by `blob.revision <= this.remoteRevision` if `pair()` already consumed revision 1. If so, it does not exercise the new guard. Use a revision above the current `remoteRevision`, or assert that it is.
5. There is no peer-link test for a duplicate old answer arriving with a fresh revision during a *new* local offer (finding 2).
6. The web `pre-removal` case does not assert the post-promotion state: a fresh safety bound to the new key, and the retained 3-signer certificate at index 0.
7. There is no test for promotion racing a live old controller or a concurrent `saveSafety` (finding 3).
