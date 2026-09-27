# Stage 07 Step 6 cheat-candidate delivery review

This is a read-only review of the supplied source. I executed nothing. Planning tools were not used because you disabled them, so this review is the deliverable.

## Verdict

- **Prior fixes:** N1, N2, N3, T1, T3, the count bound and the steal ephemeral-point change all hold.
- **T2:** still not discriminating. The live/restore test never reaches the shared `entries` array through the resolver.
- **New slice:** persistence-before-gossip, first-retained-per-pair, certified deletion after commit, relay-versus-offender separation, and the budget-before-replay gates are implemented correctly.

Remaining issues in the implemented slice:

- **C1 (Medium):** a retained candidate suppresses the holder's own owed crypto work, not just its proposal order.
- **C2 (Low–Medium):** restore fails on a transport throw or on any unverifiable auxiliary record, which halts voting.
- **C3 (Low):** retained claims are rebroadcast only once. The shared `cheat` budget drops bulk rebroadcasts and competes with historical-cheat proposal validation.
- **Test gaps:** the deck-pass-after-finding test does not exercise the replica's own owed-work or cheat-priority path.

## Prior findings

| ID                    | Status               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1 nonce gap          | **Fixed**            | `badCommandProof` now relies on `validateCommandStatement` → `validateSignedCommand` (`nonce <= last`). The `gapped` test (nonce 2, last 0) discriminates the old `!== last + 1`. **Weak negative:** `replayedNonce` uses nonce 0, which fails `positiveInteger` in the schema, so it never reaches the replayed-nonce check. Use `lastNonces = new Map([[0, 1]])` with nonce 1 to get code `replayed-nonce` and a `cheat-unproven` result.    |
| N2 parent hash        | **Fixed**            | `replay.ts` resolver compares `at.hash` against the genesis head or `certified[atSeq-1]` before the signer check, cache or replay. The `wrongParent` and `forged` tests assert `replayCreates` is unchanged.                                                                                                                                                                                                                                   |
| N2 proposal budget    | **Fixed, weak test** | `receive` → `PROPOSAL` runs `authenticateSignedProposal` and then `admitExpensiveRequest(..., 'cheat')` when `at.seq < head.seq`. `at.seq === head.seq` with a wrong hash is rejected cheaply in `log.ts`, so no budget is needed there. **Test gap:** the bad-parent test uses bogus hashes, so no replay happens with or without the budget. `seen.size === 3` shows the gate ran but not that it prevented work. See C3 for the regression. |
| N3 stale context      | **Fixed**            | `log.ts` rejects `at.seq >= head.seq` unless it equals the head. `selfCiting` against the stale head-1 context discriminates: before the fix it would have resolved through the grown array. Correction to the prior review: `verifyHistoricalAccusation` is already context-bounded, because `objectiveProofParentHash` rejects `atSeq > height` first.                                                                                       |
| Count bound           | **Fixed**            | Uses `MAX_HAND_RESOURCE_COUNT`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Steal ephemeral point | **Fixed**            | Route shape passes, then owner signature, then strict parse, then `validSealedEphemeral`. `badPoint` carries a finding; the version with a forged signature does not. The earlier throw-versus-false note for nested points is still open.                                                                                                                                                                                                     |
| T1 cost               | **Fixed**            | `replayCreates - beforeFour === 4`. That is 1 top-level plus nested replays for C₂, C₃ and C₄, each hitting the shared cache inside. Pre-fix code gives 5.                                                                                                                                                                                                                                                                                     |
| T3 signer             | **Fixed**            | `wrongSigner` is chosen with `seat !== firstClaim.seat`.                                                                                                                                                                                                                                                                                                                                                                                       |
| T2 shared array       | **Still open**       | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### T2 trace

1. `futureClaim` (at = `firstEntry`, seq 1) is validated on `resumed` after `firstEntry` commits. The head is seq 1, so `at === head` and `log.ts` takes the direct `verifyCheatProof` path. The resolver is not called.
2. `liveResult` validates `secondEntry`, which cites genesis (seq 0). `atSeq 0` resolves from `initial.value.log.head` and never reads `certified`.
3. Code where `persistCommit` pushed into a different array than the resolver captures would therefore pass both.
4. The design doc's "a focused live/restore test verifies this path" is still inaccurate.

**Minimal discriminating addition:**

- On `restored`, before the `owed` COMMIT: `restored.getContext().verifyHistoricalCheat?.(claim(seatX, owed))` should return `cheat-history`, because `atSeq 2 > length 1`.
- After the COMMIT has been pushed live, the same call should return `ok: true` with seat X.
- The beacon operation is unchanged across the deck pass, so the claim is valid at `owed`.

## Defects in the implemented slice

### C1 — Medium: holding a candidate withholds the holder's owed contributions

**Location:** `replicated-log.ts` `offerAvailableInput`

**Trace:**

1. `if (this.cheatCandidates.size > 0 || this.accusation !== null) { …; return this.maybePropose(); }` returns before `prepareDeck`, `prepareCount`, `prepareSteal` and `prepareBeacon`.
2. `pulse()` calls `offerAvailableInput(true)`, so retransmission is suppressed as well.
3. Every peer that retains a claim stops producing and resending its own deck unlocks, count reveals, steal deliveries and beacon reveals until that claim is certified. With several candidates, this lasts until all of them are certified (up to 48 heights).
4. If a holder is not the proposer, the height needs its contribution but no one proposes the cheat entry. The height then waits through round timeouts (1 s·2^(r−1)) until rotation reaches a holder.
5. The case of an excluded proposer holding a candidate that no one else has:
   - It never proposes.
   - It never sends its owed beacon reveal or unlock.
   - Its only rebroadcast happens at restore.
   - The frozen operation cannot complete, so play stalls.
6. Today, candidates originate only from gossip, so the relay also holds the claim and will eventually propose it. Once local capture lands, the capturing peer can be the excluded proposer, and the stall becomes a real deadlock.

The design only asks for priority in `candidate()`, which already puts cheat before crypto and commands. It does not ask holders to withhold their own work.

**Minimal fix:** Replace the early return with a flag. Dispatch `input-available` when candidates exist, then fall through to the normal `prepare*` calls, and include `this.cheatCandidates.size > 0` in `available`.

```ts
const hasCheat = this.cheatCandidates.size > 0;
// …prepare* unchanged…
const available = this.accusation !== null || hasCheat || …;
```

**Regression test:**

1. Use a fixture after deck setup with an active beacon, where the local non-proposer seat owes a reveal.
2. Inject a valid `CHEAT_CLAIM` and flush.
3. Assert that a `SYS_CONTRIB` for the local seat is broadcast.
4. Advance the pulse and assert it is broadcast again.

Current code emits neither.

### C2 — Low–Medium: the auxiliary store and transport can prevent restart

**Location:** `restore` → `recoverCheatCandidates` and `broadcastRetainedCheatClaims`

**Trace:**

1. `broadcastRetainedCheatClaims` returns the transport failure. `restore` then disposes the replica and fails, so a peer whose transport throws while offline cannot restart. Every other broadcast site records a status and continues; see `prepareBeacon`.
2. `recoverCheatCandidates` returns failure for any record that is corrupt, has a mismatched ID, or fails `verifiedCheatClaim`. In particular, `cheat-future` happens when `at` is past the replayed head.
3. The browser journal and the candidate store are separate stores with no joint atomicity. A crash that keeps the candidate `put` but loses a relaxed-durability journal commit produces exactly that `cheat-future` record.
4. Result: one auxiliary record permanently blocks consensus. This contradicts the plan's rule that no candidate may halt voting.

**Minimal fix:**

- In recovery, delete or skip records that fail decoding or re-verification, and report a status for them. Keep an `at > head` record unloaded; skipping it is also acceptable.
- Treat the restore rebroadcast failure as a status, as `prepareBeacon` does.
- Only a `loadAll` throw should remain fail-closed, and arguably even that should only disable cheat gossip.

**Regression tests:**

- Pre-seed the store with a schema-valid claim whose `at = {seq: 5, hash}` sits beyond an empty journal. `restore` should succeed with the record ignored or removed.
- Use a transport whose `broadcast` throws. `restore` should still succeed.

### C3 — Low: the one-shot rebroadcast and a shared `cheat` bucket drop honest work

**Trace:**

1. Retained claims are sent once when retained (`rememberCheatClaim`) and once at `restore`. `pulse` never resends them.
2. `restore` sends every retained claim at once, up to 48. The receiver's `cheat` bucket admits 3 per peer per 10 s, so the rest are dropped and never retried.
3. The same bucket covers `historical-cheat/<proposal>`. A peer that just re-gossiped 3 claims has its next valid historical cheat proposal dropped silently by that voter for 10 s. That costs a round at best.

**Minimal fix:**

- In `pulse`, rebroadcast a bounded number of retained claims, e.g. one per pulse in ID order. This is cheap for receivers, because the `cheatCandidates.has(id)` no-op runs before the budget.
- Give historical-cheat proposals their own category, as `trade` already has.

**Regression tests:**

- Retain 4 candidates and restore. After 10 s plus a pulse, a receiver should retain all 4.
- Send 3 claims from peer P, then a valid historical-cheat proposal from P in the same window. It should be validated, measured by a `replayCreates` delta of 1.

### Hardening notes (not demonstrated failures)

- **Unvalidated cheat candidate:** `candidate()` signs the cheat entry without running `validateNextEntry`, unlike `entryCandidate`. The design says "the sequencer still revalidates". I found no reachable invalid case: a pair that was certified elsewhere is deleted by ID in `persistCommit`. Routing it through validation keeps a future bug from turning into a self-strike.
- **Store delete inside the controller swap:** `persistCommit` awaits `cheatCandidateStore.delete` after disposing the old controller and before `openController`. If the store hangs, the serialized queue stalls. Move the delete after `openController`, or enqueue it.
- **Budget ordering:** the already-certified `(seat, kind)` check runs after the `cheat` budget in `receive`, so re-gossip of certified claims spends budget. Move that check ahead of `admitExpensiveRequest`.
- **Replay cache insertion order:** `verifiedFindings.set` still runs before `advanceContext`/`onEntry`. This is harmless.

## Required checks

| Check                                                | Status  | Notes                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistence before gossip and proposal               | OK      | `putIfAbsent` runs before `cheatCandidates.set`, broadcast and offer. A write failure means nothing is retained or sent, and the test covers it.                                                                              |
| Exact retry after restart                            | OK      | Canonical bytes are rebroadcast and the test compares byte-identical output. Within one session, a retry after a local write failure is blocked by the claim-hash budget key for 10 s. The test advances `now` to cover this. |
| First valid retained claim per seat/kind             | OK      | The ID is `cheat/seat/kind`. The store winner is re-verified before retention.                                                                                                                                                |
| Certified deletion after journal commit              | OK      | Deletion happens after `journal.commit`. A failed delete is cleaned up on restore by the certified check.                                                                                                                     |
| Relay identity versus offender                       | OK      | The offender comes only from the artifact signature and role. `from` only selects the budget bucket and the voter gate.                                                                                                       |
| Budgets before proof replay                          | OK      | For gossip: signer, then future check, then candidate check, then budget. For proposals: authentication, then budget. Restore re-verification is unbudgeted and synchronous (known gap).                                      |
| Priority during owed crypto work                     | Partial | `validateCryptoTransition` admits `cheat-proof` before the deck and beacon gates, and `candidate()` orders cheat first. C1 over-applies the priority.                                                                         |
| Live test commits the next deck pass after a finding | Partial | `nextPass + 1` with unchanged state is asserted. The commit arrives as an externally certified COMMIT, so the replica's own `deckSetupCandidate`, cheat priority and resume path are not exercised, and C1 goes undetected.   |

## Known integration gaps (not defects)

These are planned but not yet implemented:

- Automatic artifact capture. Without it, candidates enter only through `CHEAT_CLAIM`.
- `invalid-crypto` proposer accusations.
- UI and session exposure of findings.
- Incremental historical replay in worker jobs. Restore and proposals can still replay a full certified prefix synchronously, within the per-peer budgets and the 16-parent cache.

Still-open classifier notes from earlier reviews:

- A nested proof with well-shaped but invalid points gives an unproven result when the verifier throws.
- D4 check order.
