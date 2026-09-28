# Derived context repair: focused follow-up review

Read-only review of fixes to the original source review below. Identify concrete remaining safety/liveness defects, with severity, path/function, mechanism and smallest correction. Do not infer full scenario8 acceptance from unit tests. Original review input and manifest are preserved unchanged.

## Disposition and evidence

H1 was reproduced before the source fix: an authentic proposal, local prevote, polka and local precommit persisted a real lock; bank corruption returned terminal consensus-restore. The opening guard now classifies a changed/noncanonical context as consensus-context without validating stored records against known-corrupt context. Owned-state opening/restore and detached-state comparison remain intact. Actual terminal safety still must pass exact restore against trusted durable replay; no safety reset/initialization path was added.

M1: fatal proposal dispatch returns before rejected-proof capture. Capture itself checks context on verified failure paths. Retained cheat candidates are revalidated against fresh context before resume.

M2: failed-message strikes first check the controller context and enter repair rather than blaming peers; repair clears rejection/strike caches. Pulse and peer-change authority observations now occur only after the context guard succeeds. While held, synchronous requestTradeProof returns replica-repairing before validation, pending-state mutation or sends; cancellation remains available.

M3: the first trusted replay is cached for the hold with expected snapshot hash and canonical durable-prefix hash. Later distinct forged snapshots fail the hash gate without loading/replaying the journal. A matching snapshot still rereads the durable journal, checks original genesis/prefix/head and opening stamp, matches exact safety revision/bytes, restores exactly and rereads safety before adoption.

L1: held hints require the entry signature and full precommit certificate against frozen anchor membership and do not replace a retained entry hash. Full entry validation still happens after repair. L3: a stopped controller remembers a context fault; enqueue quarantines it even if an intermediate snapshot failure was swallowed. Persisted bytes come from an owned copy of exactly the encoding handed to storage before await.

L2: a bounded real verified fixture compared incremental contexts with full durable replay at genesis and two certified public deck passes; all opening stamps and nonce insertion orders matched. No actual nonce-order divergence was observed, so sorting/equivalence widening was not retained. This covers representative early verified metadata, not later transfer/recovery epochs or every possible prefix. The allowed replay-reference omissions remain only rebuilt wrapper identity (including depth-zero aliases) and the two locally rebuilt ancestry verifier closures.

L4: tests now repair a real locked replica and preserve exact safety revision/bytes; erase a real persisted lock without changing the revision and fail closed; mutate context while a replica safety write is paused and retransmit exactly one byte-identical durable prevote only after repair; suppress failed-proposal proof capture; retain a swallowed context diagnosis; avoid peer strikes while faulty; exercise SUBMIT/VOTE/SYS_CONTRIB/pulse and synchronous trade-request quarantine; reject repeated distinct snapshots without another journal read; reject garbage held certificates without overwriting an authentic hint.

Checks: 55 cheap cases from the two unit files passed (verified-prefix case excluded to avoid repeating crypto); the real verified prefix case passed separately in7.5s. The final nine parameterized repair cases passed after test refinement. Protocol build, complete test-source typecheck and scoped lint passed. No full scenario8 game, browser run, commit or push. Quarantine packets are schema-valid; the SYS_CONTRIB signature is intentionally untrusted. The proposal capture spy uses stub mode and proves control flow, not objective-cheat verification.


## Original source review findings

```text
# Review: derived-context repair (frozen source, read-only)

I found one high-severity defect, three medium and four low. The high one means the repair path only works when the height's voting record is empty, and the scenario 8 harness is shaped to produce exactly that case.

I didn't run anything. I worked from the frozen source you pasted, so locations are given as function names rather than line numbers.

## H1 — High (liveness, hidden by the harness): a corrupted context becomes a terminal `consensus-restore` whenever the height has recorded proposal data

**Where:** `consensus.ts`, `OwnedConsensusStateImpl.checkContext`. Also `ReplicatedLog.enqueue`, which treats `consensus-restore` as fatal.

**Mechanism:**
- When the stamp doesn't match, `checkContext` runs `restoreConsensusState(this.state, this.context)` against the mutated, untrusted context. It returns `consensus-context` only if that restore succeeds with identical bytes.
- `restoreConsensusState` calls `validateProposal` on every stored proposal, proposal hint, `valid`/`locked` record, and `validateCertifiedEntry` on `decision`. Under state corruption those all fail on the state hash, so the result is `consensus-restore`.
- `consensus-restore` is in `FATAL_CONTROLLER_ERRORS`, so the replica disposes and never enters `enterDerivedRepair`.
- Your own controller test ("corrupt local derivation stops an active controller…") shows this: with a stored proposal the code is `consensus-restore`.

**Consequences:**
- Repair is only reachable when the local record at that height has no proposals, locks, hints or decision.
- `tools/sim/src/net.ts:455-460` drops the corrupted height's `PROPOSAL` and `VOTE` messages for peer 0 ("Keep this peer's target-height voting record empty"). That is what makes scenario 8 pass.
- A peer holding a lock can never reach the "exact vote/lock restore" at replica level.
- Organic scenario-8 corruption, for example after the peer has prevoted a proposal, is terminal. That contradicts doc 06 §6.

**Smallest fix:** when the stamp differs and nothing is pending, return `failure('consensus-context', …)` directly. Drop the restore against the untrusted context. Deciding from a context that is already known to be wrong proves nothing. The repair's exact restore against a trusted replay still fails closed on real terminal evidence, and the stopped controller persists nothing either way.

**Test:** at replica level, receive a proposal, prevote, reach a polka and lock, then corrupt the bank. Assert the replica enters the hold (not a dispose), repairs, and keeps safety bytes and revision identical. Then remove the drop filter in `net.ts` and rerun scenario 8.

## M1 — Medium (quarantine breach): side effects run in the same operation after the controller reports the corruption

**Where:** `ReplicatedLog.receive`, `PROPOSAL` case.

**Mechanism:**
- Repair is only entered when the operation returns to `enqueue`, or from inside `acceptCertified`.
- The `PROPOSAL` branch calls `captureRejectedProofs(from, bytes)` unconditionally after a failed dispatch, including when the failure is `consensus-context`.
- That verifies claims against the corrupted `this.context.log`, then:
  - writes a durable `cheatCandidateStore.putIfAbsent`,
  - broadcasts `CHEAT_CLAIM`,
  - keeps the claim in `this.cheatCandidates`.
- `repairNow` never clears or rechecks `cheatCandidates`. After repair, `candidate()` proposes the first cheat claim first. If that claim is false, `validateProposal` rejects our proposal every time we are proposer, so our proposer rounds stall.

**Fix:**
- In the `PROPOSAL` branch, `if (!received.ok && FATAL_CONTROLLER_ERRORS.has(received.error.code)) return received;` before any capture or accusation logic.
- In the shared reset in `repairNow`, recheck each `cheatCandidates` entry with `verifiedCheatClaim`, as `recoverCheatCandidates` does.

## M2 — Medium (liveness): strikes and rejection caches built from the corrupted context survive repair

**Where:** the `receive` branches that validate against `this.context` without calling the controller, and `repairNow`'s reset list.

**Mechanism:**
- Corruption is detected lazily, on the next controller call or pulse.
- Before detection, these branches validate against the corrupted state:
  - `SUBMIT` → `deriveCandidate` (bank+1 breaks invariants) → `command-proof-invalid` → strike.
  - `DECK_CONTRIB`, `COUNT_CONTRIB`, `STEAL_*` → rejection cache plus strike.
  - `TRADE_PROOF_REQUEST` → strike.
- None of those return `consensus-context`, so the hold is never entered from them.
- Repair clears `rejectedCommands`, `rejectedProposals` and `rejectedDeckContributions`. It does not reset:
  - `invalidByPeer` or `blockedPeers`,
  - `rejectedCountContributions` or `rejectedStealMessages`,
  - `rejectedMasterReveals`.
- If honest voters get disconnected this way, they can't deliver the `SNAPSHOT_RES` the hold needs.

**Fix:**
- In `strikePeer` (only reached on failure paths), first check `this.controller?.snapshot()`. If it fails, call `enterDerivedRepair()` and return without striking.
- In `repairNow`'s shared reset, clear `invalidByPeer`, `rejectedCountContributions` and `rejectedStealMessages`. Also unblock peers whose strikes landed after `controllerAnchor` was installed. The simplest version clears the strike state entirely on repair.

## M3 — Medium/low (ingress amplification): every admitted snapshot triggers a full journal replay before the cheap check

**Where:** `repairNow`, hold path.

**Mechanism:**
- The order is `journal.load` → `replayCertifiedPrefix` over the whole history → `opensOn` → `verifyReplaySnapshot`.
- `receiveDuringRepair` admits 3 distinct snapshot hashes per voter per 10 s. So one Byzantine voter can force about 3 full replays every 10 s, including verified-crypto proofs late in a game.
- The replica queue is serialized and drops messages beyond 32, so honest snapshots queue behind this work.

**Fix:**
- Cache `{ safety revision + bytes, fresh, expected = hashValue(snapshotFromContext(fresh)) }` in the hold after the first successful replay and `opensOn` check.
- For later snapshots, compare the hash first. Re-read only `journal.loadSafety` and the head before restoring.

## L1 — Low (liveness; sync is the fallback): held commits are unauthenticated and can be overwritten

**Where:** `retainHeldCommit`.

**Mechanism:**
- The only checks are `seq` and `prevHash`.
- `Map.set` overwrites an existing key. A Byzantine voter can resend the honest entry with a garbage certificate and replace the honest one, or fill all 4 slots first.
- After repair, `acceptCertified` rejects the bad copies, so "automatic held-commit continuation" silently degrades to `requestSync`.

**Fix:**
- Freeze a copy of the anchor's membership.
- Before retaining, check the entry signature and run `verifyCertificate` against that frozen membership.
- Don't overwrite an existing key.

## L2 — Low (liveness; untested): opening stamp vs. full replay for honest peers

**Where:** `matchesOpenedContext`.

**Mechanism:**
- The opening stamp comes from the incremental `advanceContext`. The comparison candidate comes from a full replay.
- Equivalence is tested for one stub commit only. It isn't tested for verified games, where these can differ:
  - optional `transfer`, `timers`, `recovery` or `authority` keys that are absent in one and `undefined` in the other,
  - crypto epochs,
  - `lastNonces` Map insertion order (the stamp uses `[...log.lastNonces]`, which is unsorted).
- Any byte difference makes an honest peer's repair end in terminal `replica-authority`.

**Fix:**
- Sort `lastNonces` in `contextStamp`.
- Add a sim assertion after every commit in a verified lifecycle game: `opensOn(replayCertifiedPrefix(journal))` must be true.

The omission list itself looks sound. It only names the depth-0 wrappers and the two ancestry closures. Engine and policy identity, their prototypes and methods, and `randomDerivations` are all still compared. The candidate is always the local durable replay.

## L3 — Low: a swallowed snapshot failure makes the next dispatch fatal instead of entering repair

**Mechanism:** `controller.snapshot()` calls `stopVoting()` when it fails. Some callers ignore the result, for example the `handleEffects` `halt` case. The next dispatch then returns `consensus-stopped`, which is fatal, and the replica disposes.

**Fix:** have the controller expose a `contextFault` flag. In `enqueue`, enter repair when `this.controller?.contextFault` is set, whatever the operation's own result code.

## L4 — Evidence and coverage gaps

- **`locked-safety` test:** it writes a schema-invalid lock (`polka`). It shows the byte guard fires first, but no test shows a locked replica actually repairing, which H1 prevents.
- **Pending write:** tested only at controller level. The replica-level version (a context mutation during `saveSafety`, then exactly one retransmitted prevote whose bytes equal the durable copy) is untested.
- **Quarantine:** there are no tests that fire `SUBMIT`, `SYS_CONTRIB`, `DECK_CONTRIB`, `CHEAT_CLAIM`, timers or pulses during the hold.
- **Scenario 8 evidence in `net.ts`:**
  - `desyncObserved` accepts any `error` status on seat 0, not specifically `consensus-context`.
  - `snapshotResponsePairs` only proves a `SNAPSHOT_RES` arrived, not that the repair used it.
  - Together with the proposal/vote drop filter, a passing run doesn't prove organic repair.

## Checked and found sound

- **Anchor:** frozen when the controller is installed, and read only from the anchor during the hold. Snapshot requests, sender admission and held commits all use it.
- **Durable authority:** genesis is byte-compared against both sources. The journal height and head must match the anchor.
- **Safety record:** revision and bytes are compared before the exact restore and rechecked after it (`matchesPersistedRecord`). Because revisions only increase, a changed-then-restored record can't slip through.
- **No reset path:** there is no `create` or `initialize`. `requireExactRestore` refuses to normalize terminal evidence.
- **Ordering:**
  - The context swap happens only after the restore succeeds.
  - `derivedRepair` is cleared before `resume`, so retransmission sends the stored bytes exactly.
  - Operations that don't carry the repair flag are rejected when they run, not just when they're queued.
  - `handleEffects` returns early during the hold.
  - Timers are cleared.
  - The pulse during the hold only sends rate-limited `SNAPSHOT_REQ`.
- **Forged snapshots:** a hash mismatch leaves the replica held, with no strike and no mutation.
- **Pending write at controller level:** a stopped controller doesn't emit after its write resolves. `persistedBytes` and `revision` follow the durable record even when `owned.commit()` fails.

**Not verified:** no full scenario 8 game has been run. With H1 unfixed, I wouldn't infer scenario acceptance from these unit results.

Separately, the Atlassian and Google Drive connectors need to be authorized in your claude.ai connector settings before they can be used.
```

## Changes since original review: packages/protocol/src/consensus.ts

```diff
--- original-review/packages/protocol/src/consensus.ts
+++ current/packages/protocol/src/consensus.ts
@@ -239,7 +239,11 @@
   return {
     contextBytes: canonicalEncode({
       ...other,
-      log: { ...log, lastNonces: [...log.lastNonces], engine: nonfunctions(engine) },
+      log: {
+        ...log,
+        lastNonces: [...log.lastNonces],
+        engine: nonfunctions(engine),
+      },
       policy: {
         ...nonfunctions(context.policy),
         randomDerivations: nonfunctions(context.policy.randomDerivations ?? {}),
@@ -1645,7 +1649,6 @@
   constructor(
     private state: ConsensusState,
     private readonly context: ProposalContext,
-    private readonly seat: Seat,
     private readonly stamp: ContextStamp,
   ) {
     ownedStates.add(state);
@@ -1686,15 +1689,13 @@
     try {
       current = contextStamp(this.context);
     } catch {
-      return failure('consensus-restore', 'Certified context is not canonical data');
+      return failure('consensus-context', 'Certified context changed to noncanonical data');
     }
     if (sameContextStamp(this.stamp, current)) return success(undefined);
     if (this.pending)
       return failure('consensus-context', 'Certified context changed during persistence');
-    const restored = restoreConsensusState(this.state, this.context, this.seat);
-    if (!restored.ok) return restored;
-    if (!sameBytes(canonicalEncode(restored.value), canonicalEncode(this.state)))
-      return failure('consensus-restore', 'Restore to persist newly verified terminal evidence');
+    // Once the opening stamp differs, this context cannot validate stored
+    // proposals or locks. Only durable replay may establish their authority.
     return failure('consensus-context', 'Certified context changed; restore this voting record');
   }
 
@@ -1785,7 +1786,7 @@
   if (!restored.ok) return restored;
   try {
     return success(
-      new OwnedConsensusStateImpl(restored.value, context, seat, contextStamp(context)),
+      new OwnedConsensusStateImpl(restored.value, context, contextStamp(context)),
     );
   } catch {
     return failure('consensus-restore', 'Certified context is not canonical data');

```

## Changes since original review: packages/protocol/src/consensus-controller.ts

```diff
--- original-review/packages/protocol/src/consensus-controller.ts
+++ current/packages/protocol/src/consensus-controller.ts
@@ -45,6 +45,7 @@
 export class ConsensusController {
   private queue: Promise<unknown> = Promise.resolve();
   private stopped = false;
+  private contextFault = false;
   private persistedBytes: Uint8Array;
   private readonly secretKey: Uint8Array;
   private readonly rejectedProposals = new Map<string, { code: string; message: string }>();
@@ -133,7 +134,7 @@
   snapshot(): Result<ConsensusState> {
     const snapshot = this.owned.snapshot();
     if (!snapshot.ok) {
-      this.stopVoting();
+      this.stopVoting(snapshot.error.code);
       return snapshot;
     }
     if (!sameBytes(canonicalEncode(snapshot.value), canonicalEncode(this.state))) {
@@ -146,6 +147,10 @@
   /** The opening stamp remains usable after the mutable derived context fails its guard. */
   opensOn(context: ProposalContext): boolean {
     return this.owned.matchesOpenedContext(context);
+  }
+
+  hasContextFault(): boolean {
+    return this.contextFault;
   }
 
   settled(): Promise<void> {
@@ -192,7 +197,7 @@
       const next = this.reduce(event);
       if (!next.ok) {
         if (next.error.code === 'consensus-restore' || next.error.code === 'consensus-context')
-          this.stopVoting();
+          this.stopVoting(next.error.code);
         else if (
           proposalKey &&
           next.error.details?.proposalEntryRejected === true &&
@@ -221,8 +226,10 @@
         this.owned.discard();
         return admitted;
       }
+      let persistedBytes: Uint8Array;
       try {
         const bytes = canonicalEncode(candidate);
+        persistedBytes = bytes.slice();
         if (!(await this.options.store.save(this.revision, bytes))) {
           this.owned.discard();
           this.stopped = true;
@@ -239,12 +246,12 @@
           'Voting stopped because its state could not be persisted',
         );
       }
-      this.persistedBytes = canonicalEncode(candidate);
+      this.persistedBytes = persistedBytes;
       this.revision += 1;
       const committed = this.owned.commit();
       if (!committed.ok) {
         this.owned.discard();
-        this.stopVoting();
+        this.stopVoting(committed.error.code);
         return committed;
       }
       this.state = copyConsensusStateData(candidate);
@@ -259,7 +266,8 @@
     this.stopVoting();
   }
 
-  private stopVoting(): void {
+  private stopVoting(code?: string): void {
+    if (code === 'consensus-context') this.contextFault = true;
     this.stopped = true;
     this.secretKey.fill(0);
     this.rejectedProposals.clear();

```

## Changes since original review: packages/protocol/src/consensus-controller.test.ts

```diff
--- original-review/packages/protocol/src/consensus-controller.test.ts
+++ current/packages/protocol/src/consensus-controller.test.ts
@@ -821,7 +821,7 @@
     };
     // The same persisted proposal can no longer be derived from corrupted local state.
     options.context.log.state = corruptContext.log.state;
-    expect(errorCode(controller.snapshot())).toBe('consensus-restore');
+    expect(errorCode(controller.snapshot())).toBe('consensus-context');
     expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
       'consensus-stopped',
     );
@@ -836,7 +836,7 @@
     const dispatchController = await restore({ ...options, context: dispatchContext });
     dispatchContext.log.state = corruptContext.log.state;
     expect(errorCode(await dispatchController.dispatch({ kind: 'input-available' }))).toBe(
-      'consensus-restore',
+      'consensus-context',
     );
     expect(errorCode(await dispatchController.resume())).toBe('consensus-stopped');
 
@@ -846,7 +846,7 @@
     };
     const resumeController = await restore({ ...options, context: resumeContext });
     resumeContext.log.state = corruptContext.log.state;
-    expect(errorCode(await resumeController.resume())).toBe('consensus-restore');
+    expect(errorCode(await resumeController.resume())).toBe('consensus-context');
     expect(errorCode(await resumeController.dispatch({ kind: 'input-available' }))).toBe(
       'consensus-stopped',
     );

```

## Changes since original review: packages/protocol/src/replicated-log.ts

```diff
--- original-review/packages/protocol/src/replicated-log.ts
+++ current/packages/protocol/src/replicated-log.ts
@@ -112,6 +112,7 @@
 import { genesisSchema, logEntrySchema } from './schemas.js';
 import { MAX_MESSAGE_BYTES, parseCanonical } from './validation.js';
 import { validateVote, verifyCertificate } from './votes.js';
+import type { VoteContext } from './votes.js';
 import { authenticatedCheatSigner, verifyCheatProof } from './cheat-proof.js';
 import type { CheatClaim, CheatFinding } from './cheat-proof.js';
 import {
@@ -344,12 +345,19 @@
     hash: string;
     genesisDigest: string;
     voters: readonly string[];
+    membership: VoteContext;
   } | null = null;
   private derivedRepair: {
     stopped: ConsensusController;
     anchor: NonNullable<ReplicatedLog['controllerAnchor']>;
     heldCommits: Map<string, CertifiedEntry>;
     lastRequestAt: number;
+    replayed?: {
+      context: ProposalContext;
+      entries: CertifiedEntry[];
+      snapshotHash: string;
+      prefixHash: string;
+    };
   } | null = null;
 
   private constructor(
@@ -512,6 +520,12 @@
       if (state.value.haltKind !== 'certified-validation')
         return failure('replica-repair', 'Only a certified validation halt can be repaired');
     }
+    if (
+      hold?.replayed &&
+      snapshot !== undefined &&
+      toHex(hashValue(snapshot)) !== hold.replayed.snapshotHash
+    )
+      return failure('snapshot-mismatch', 'Snapshot differs from the certified replay');
     let record: Awaited<ReturnType<ProtocolJournal['load']>>;
     try {
       record = await this.options.journal.load();
@@ -525,12 +539,17 @@
       !sameBytes(canonicalEncode(record.genesis), canonicalEncode(this.options.genesisEntry))
     )
       return this.failClosed('replica-genesis', 'Repair journal differs from the original genesis');
-    const replayed = replayCertifiedPrefix(
-      record.genesis,
-      record.entries,
-      this.options.engine,
-      this.options.policy,
-    );
+    const prefixHash = toHex(hashValue({ genesis: record.genesis, entries: record.entries }));
+    if (hold?.replayed && prefixHash !== hold.replayed.prefixHash)
+      return this.failClosed('replica-journal', 'Certified journal changed during repair');
+    const replayed = hold?.replayed
+      ? success(hold.replayed)
+      : replayCertifiedPrefix(
+          record.genesis,
+          record.entries,
+          this.options.engine,
+          this.options.policy,
+        );
     if (!replayed.ok)
       return hold ? this.failClosed(replayed.error.code, replayed.error.message) : replayed;
     const fresh = replayed.value.context;
@@ -545,6 +564,13 @@
         'replica-authority',
         'Durable replay differs from the controller opening context',
       );
+    if (hold && !hold.replayed)
+      hold.replayed = {
+        context: fresh,
+        entries: replayed.value.entries,
+        snapshotHash: toHex(hashValue(snapshotFromContext(fresh))),
+        prefixHash,
+      };
     if (hold && snapshot === undefined)
       return failure('replica-repairing', 'Derived repair requires a replay-verified snapshot');
     if (snapshot !== undefined) {
@@ -589,10 +615,17 @@
     this.rejectedCommands.clear();
     this.rejectedProposals.clear();
     this.rejectedDeckContributions.clear();
+    this.rejectedCountContributions.clear();
+    this.rejectedStealMessages.clear();
+    this.rejectedMasterReveals.clear();
+    this.invalidByPeer.clear();
+    this.blockedPeers.clear();
     this.preparedDeckPrefix = null;
     this.sentDeckPrefix = null;
     this.entries = replayed.value.entries;
     this.refreshHistoricalHumanPeers();
+    for (const [id, claim] of this.cheatCandidates)
+      if (!this.verifiedCheatClaim(claim).ok) this.cheatCandidates.delete(id);
     if (!restored) {
       const opened = await this.openController();
       if (!opened.ok) return this.failClosed(opened.error.code, opened.error.message);
@@ -985,6 +1018,8 @@
   /** Send one authorized trade-proof request directly to its counterparty host. */
   requestTradeProof(value: SignedTradeProofRequest): Result<void> {
     if (this.disposed) return failure('replica-disposed', 'Replica has been disposed');
+    if (this.derivedRepair || this.controller?.hasContextFault())
+      return failure('replica-repairing', 'Awaiting certified derived-state repair');
     const checked = verifyTradeProofRequest(value, this.context.log);
     if (!checked.ok) return checked;
     const request = checked.value;
@@ -1183,6 +1218,12 @@
       hash: entryHash(context.log.head),
       genesisDigest: context.membership.genesisDigest,
       voters: Object.freeze(context.membership.voters.map((voter) => voter.publicKey)),
+      membership: Object.freeze({
+        ...context.membership,
+        voters: Object.freeze(
+          context.membership.voters.map((voter) => Object.freeze({ ...voter })),
+        ),
+      }),
     });
   }
 
@@ -1233,7 +1274,25 @@
       hold.heldCommits.size >= 4
     )
       return;
-    hold.heldCommits.set(entryHash(certified.entry), copyCanonical(certified));
+    const hash = entryHash(certified.entry);
+    if (hold.heldCommits.has(hash)) return;
+    if (
+      !verifyObject(
+        'entry',
+        entryBody(certified.entry),
+        certified.entry.sig,
+        parsePeerId(certified.entry.sequencer),
+      )
+    )
+      return;
+    const certificate = verifyCertificate(certified.certificate, hold.anchor.membership, {
+      seq: certified.entry.seq,
+      term: certified.entry.term,
+      phase: 'precommit',
+      valueHash: hash,
+    });
+    if (!certificate.ok) return;
+    hold.heldCommits.set(hash, copyCanonical(certified));
   }
 
   private receiveDuringRepair(from: PeerId, message: ProtocolMessage): Promise<Result<void>> {
@@ -1263,8 +1322,12 @@
         return failure('replica-repairing', 'Awaiting certified derived-state repair');
       try {
         const outcome = await operation();
-        if (!outcome.ok && outcome.error.code === 'consensus-context' && this.enterDerivedRepair())
-          return outcome;
+        if (
+          (this.controller?.hasContextFault() ||
+            (!outcome.ok && outcome.error.code === 'consensus-context')) &&
+          this.enterDerivedRepair()
+        )
+          return failure('consensus-context', 'Certified context changed; awaiting durable replay');
         if (!outcome.ok && FATAL_CONTROLLER_ERRORS.has(outcome.error.code)) {
           this.status({ kind: 'halted', code: outcome.error.code });
           this.dispose();
@@ -1306,7 +1369,12 @@
         this.queuedMessages += 1;
         void this.enqueue(async () => {
           const result = await this.receive(from, copy);
-          if (!this.derivedRepair && !result.ok && !FATAL_CONTROLLER_ERRORS.has(result.error.code))
+          if (
+            !this.derivedRepair &&
+            !this.controller?.hasContextFault() &&
+            !result.ok &&
+            !FATAL_CONTROLLER_ERRORS.has(result.error.code)
+          )
             await this.captureRejectedProofs(from, copy);
           return result;
         }, true).then((result) => {
@@ -1331,6 +1399,8 @@
       this.options.transport.onPeerChange((peer, online) => {
         void this.enqueue(async () => {
           if (this.derivedRepair) return this.pulse();
+          const checked = this.activeController().snapshot();
+          if (!checked.ok) return checked;
           this.observeAllRecoveryPresence();
           if (online) this.cancelRecoveryForReturningPeer(peer);
           return this.pulse();
@@ -1368,6 +1438,13 @@
   }
 
   private strikePeer(peer: PeerId): void {
+    if (this.derivedRepair) return;
+    const checked = this.controller?.snapshot();
+    if (checked && !checked.ok) {
+      if (checked.error.code === 'consensus-context') this.enterDerivedRepair();
+      else this.failClosed(checked.error.code, checked.error.message);
+      return;
+    }
     const count = (this.invalidByPeer.get(peer) ?? 0) + 1;
     this.invalidByPeer.set(peer, count);
     if (count >= INVALID_MESSAGE_LIMIT) this.rejectPeer(peer);
@@ -2076,6 +2153,7 @@
           proposal: message.proposal,
         });
         if (!received.ok) {
+          if (FATAL_CONTROLLER_ERRORS.has(received.error.code)) return received;
           await this.captureRejectedProofs(from, bytes);
           if (
             received.error.code === 'recovery-approval-required' &&
@@ -3526,7 +3604,18 @@
   private async captureRejectedProofs(from: PeerId, bytes: Uint8Array): Promise<void> {
     if (
       this.disposed ||
-      this.context.log.genesis.security !== 'verified' ||
+      this.derivedRepair ||
+      this.controller?.hasContextFault() ||
+      this.context.log.genesis.security !== 'verified'
+    )
+      return;
+    const checked = this.controller?.snapshot();
+    if (checked && !checked.ok) {
+      if (checked.error.code === 'consensus-context') this.enterDerivedRepair();
+      else this.failClosed(checked.error.code, checked.error.message);
+      return;
+    }
+    if (
       !this.context.membership.voters.some((voter) => voter.publicKey === from) ||
       !this.admitExpensiveRequest(from, `capture/${toHex(hashValue(bytes))}`, 'cheat')
     )
@@ -4018,10 +4107,10 @@
   private async pulse(): Promise<Result<void>> {
     try {
       if (this.derivedRepair) return this.requestDerivedSnapshot();
+      const snapshot = this.activeController().snapshot();
+      if (!snapshot.ok) return snapshot;
       this.observeAllRecoveryPresence();
       this.notifyAutoTakeoverEligibility();
-      const snapshot = this.activeController().snapshot();
-      if (!snapshot.ok) return snapshot;
       const body = {
         genesisDigest: this.context.membership.genesisDigest,
         epoch: this.context.membership.epoch,

```

## Changes since original review: packages/protocol/src/replicated-log.test.ts

```diff
--- original-review/packages/protocol/src/replicated-log.test.ts
+++ current/packages/protocol/src/replicated-log.test.ts
@@ -3,18 +3,21 @@
 import type { Engine, Result, Seat, SystemInput } from '@cp2p/engine';
 import { describe, expect, test } from 'vitest';
 import type { ConsensusState } from './consensus.js';
+import { createConsensusState, openOwnedConsensusState } from './consensus.js';
 import { entryHash, genesisDigest, genesisId, signEntry, signGenesis } from './genesis.js';
 import { MemoryProtocolJournal } from './journal.js';
 import { signCommand, stubEvidence } from './log.js';
 import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
 import type { ProtocolMessage } from './messages.js';
-import { proposerFor, signProposal, validateCertifiedEntry } from './proposal.js';
-import type { ProposalContext } from './proposal.js';
+import { advanceContext, proposerFor, signProposal, validateCertifiedEntry } from './proposal.js';
+import type { CertifiedEntry, ProposalContext } from './proposal.js';
 import { ReplicatedLog } from './replicated-log.js';
 import { initialProposalContext, replayCertifiedPrefix, snapshotFromContext } from './replay.js';
 import { fixtureAt, protocolFixture } from './testing/fixtures.js';
+import { createVerifiedNetworkFixture } from './testing/verified-network-fixture.js';
 import type { PeerId, ProtocolClock, Transport, Unsubscribe } from './transport.js';
 import { signVote } from './votes.js';
+import { signTradeProofRequest } from './trade-proof-delivery.js';
 
 function value<T>(result: Result<T>): T {
   if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
@@ -23,6 +26,39 @@
 
 function mutateNonceMap(nonces: ReadonlyMap<Seat, number>): void {
   if (nonces instanceof Map) nonces.set(0, 999);
+}
+
+class PausableJournal extends MemoryProtocolJournal {
+  pauseUpdates = false;
+  safetyWrites = 0;
+  loads = 0;
+  private notify: () => void = () => undefined;
+  private release: () => void = () => undefined;
+  readonly entered = new Promise<void>((resolve) => {
+    this.notify = resolve;
+  });
+  private readonly resumed = new Promise<void>((resolve) => {
+    this.release = resolve;
+  });
+
+  releaseWrite(): void {
+    this.pauseUpdates = false;
+    this.release();
+  }
+
+  override load() {
+    this.loads++;
+    return super.load();
+  }
+
+  override async saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean> {
+    this.safetyWrites++;
+    if (this.pauseUpdates) {
+      this.notify();
+      await this.resumed;
+    }
+    return super.saveSafety(height, revision, bytes);
+  }
 }
 
 class ManualClock implements ProtocolClock {
@@ -2500,7 +2536,79 @@
     replica.dispose();
   });
 
-  test.each(['unchanged', 'safety', 'locked-safety', 'engine'] as const)(
+  test('verified incremental contexts match durable replay at genesis and two certified deck passes', () => {
+    const fixture = createVerifiedNetworkFixture({ seed: 42 });
+    try {
+      const options = fixture.sessionOptions(0);
+      let context = value(
+        replayCertifiedPrefix(fixture.entry, [], fixture.engine, options.policy),
+      ).context;
+      const entries: CertifiedEntry[] = [];
+      const passes = options.deckSetupPasses?.slice(0, 2);
+      if (!passes || passes.length !== 2)
+        throw new Error('Missing representative public deck passes');
+      for (let prefix = 0; prefix <= passes.length; prefix++) {
+        const opened = value(
+          openOwnedConsensusState(value(createConsensusState(context, 3)), context, 3),
+        );
+        const replayed = value(
+          replayCertifiedPrefix(fixture.entry, entries, fixture.engine, options.policy),
+        );
+        expect(opened.matchesOpenedContext(replayed.context)).toBe(true);
+        expect([...context.log.lastNonces]).toEqual([...replayed.context.log.lastNonces]);
+        const pass = passes[prefix];
+        if (!pass) break;
+        const proposer = fixtureAt(
+          [...fixture.identities.values()],
+          proposerFor(context.log.head.seq + 1, 1, context.membership).seat,
+        );
+        const entry = signEntry(
+          {
+            seq: context.log.head.seq + 1,
+            term: 1,
+            prevHash: entryHash(context.log.head),
+            payload: { kind: 'crypto', action: 'deck-pass', evidence: pass },
+            stateHash: context.log.head.stateHash,
+            sequencer: proposer.peerId,
+          },
+          proposer.secretKey,
+        );
+        const certified = {
+          entry,
+          certificate: ([0, 1, 2] as const).map((seat) =>
+            signVote(
+              {
+                genesisDigest: context.membership.genesisDigest,
+                epoch: 0,
+                seat,
+                seq: entry.seq,
+                term: 1,
+                phase: 'precommit',
+                valueHash: entryHash(entry),
+              },
+              fixtureAt([...fixture.identities.values()], seat).secretKey,
+            ),
+          ),
+        };
+        context = value(advanceContext(context, value(validateCertifiedEntry(certified, context))));
+        entries.push(certified);
+      }
+    } finally {
+      fixture.dispose();
+    }
+  }, 30_000);
+
+  test.each([
+    'unchanged',
+    'locked',
+    'proposal',
+    'pending',
+    'swallowed',
+    'bad-submit',
+    'safety',
+    'locked-safety',
+    'engine',
+  ] as const)(
     'repairs a corrupted derived context only with unchanged durable authority (%s)',
     async (mutation) => {
       const fixture = fourHumanFixture();
@@ -2508,8 +2616,9 @@
       const first = fixtureAt(fixture.identities, 0);
       const second = fixtureAt(fixture.identities, 1);
       const local = fixtureAt(fixture.identities, 3);
-      const journal = new MemoryProtocolJournal();
+      const journal = new PausableJournal();
       const transport = new CapturingTransport(local.peerId);
+      const clock = new ManualClock();
       const statuses: string[] = [];
       const replica = value(
         await ReplicatedLog.create({
@@ -2519,26 +2628,14 @@
           seat: 3,
           secretKey: local.secretKey,
           transport,
-          clock: new ManualClock(),
+          clock,
           journal,
           onStatus: (status) => statuses.push(status.kind === 'halted' ? status.code : status.kind),
         }),
       );
       const parent = replica.getContext();
-      const safetyBefore = await journal.loadSafety(1);
+      let safetyBefore = await journal.loadSafety(1);
       if (!safetyBefore) throw new Error('Missing initial durable safety record');
-
-      let derived: unknown = replica;
-      for (const property of ['context', 'log', 'state', 'bank']) {
-        if (typeof derived !== 'object' || derived === null)
-          throw new Error(`Cannot corrupt derived state at ${property}`);
-        derived = Reflect.get(derived, property);
-      }
-      if (typeof derived !== 'object' || derived === null)
-        throw new Error('Missing derived bank state');
-      const brick = Reflect.get(derived, 'brick');
-      if (typeof brick !== 'number' || !Reflect.set(derived, 'brick', brick + 1))
-        throw new Error('Could not corrupt derived bank state');
 
       const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
       const applied = value(fixture.engine.apply(parent.log.state, input));
@@ -2571,10 +2668,106 @@
         ),
       };
 
-      transport.inject(second.peerId, { t: 'COMMIT', certified });
+      const proposal = signProposal(
+        {
+          genesisDigest: parent.membership.genesisDigest,
+          epoch: 0,
+          entry,
+          validRound: null,
+          prevotes: [],
+        },
+        first.secretKey,
+      );
+      const commandBody = {
+        gameId: parent.log.genesis.gameId,
+        genesisDigest: parent.membership.genesisDigest,
+        seat: 0 as const,
+        nonce: 1,
+        headSeq: 0,
+        headHash: entryHash(parent.log.head),
+        command: { type: 'END_TURN' },
+      };
+      if (mutation === 'locked' || mutation === 'locked-safety') {
+        transport.inject(first.peerId, {
+          t: 'PROPOSAL',
+          proposal,
+        });
+        await replica.flush();
+        for (const seat of [0, 1] as const) {
+          transport.inject(fixtureAt(fixture.identities, seat).peerId, {
+            t: 'VOTE',
+            vote: signVote(
+              { ...fixtureAt(certified.certificate, seat).body, phase: 'prevote' },
+              fixtureAt(fixture.identities, seat).secretKey,
+            ),
+          });
+          // oxlint-disable-next-line no-await-in-loop -- Persist each authentic prevote before reaching the polka.
+          await replica.flush();
+        }
+        const locked = value(replica['activeController']().snapshot());
+        if (
+          locked.locked?.hash !== entryHash(entry) ||
+          !locked.votes.some((vote) => vote.body.seat === 3 && vote.body.phase === 'precommit')
+        )
+          throw new Error('Fixture did not persist a real local lock and precommit');
+        safetyBefore = await journal.loadSafety(1);
+        if (!safetyBefore) throw new Error('Missing locked safety');
+      }
+      let capturedRejectedProofs = 0;
+      const capture = replica['captureRejectedProofs'];
+      replica['captureRejectedProofs'] = async (from, bytes) => {
+        capturedRejectedProofs++;
+        return capture.call(replica, from, bytes);
+      };
+      const votesBefore = transport.sent.filter((message) => message.t === 'VOTE').length;
+      if (mutation === 'pending') {
+        journal.pauseUpdates = true;
+        transport.inject(first.peerId, {
+          t: 'PROPOSAL',
+          proposal,
+        });
+        await journal.entered;
+      }
+      let derived: unknown = replica;
+      for (const property of ['context', 'log', 'state', 'bank']) {
+        if (typeof derived !== 'object' || derived === null)
+          throw new Error(`Cannot corrupt derived state at ${property}`);
+        derived = Reflect.get(derived, property);
+      }
+      if (typeof derived !== 'object' || derived === null)
+        throw new Error('Missing derived bank state');
+      const brick = Reflect.get(derived, 'brick');
+      if (typeof brick !== 'number' || !Reflect.set(derived, 'brick', brick + 1))
+        throw new Error('Could not corrupt derived bank state');
+
+      if (mutation === 'pending') journal.releaseWrite();
+      else if (mutation === 'swallowed') {
+        const fault = replica['activeController']().snapshot();
+        if (fault.ok || fault.error.code !== 'consensus-context')
+          throw new Error('Swallowed snapshot did not detect the context fault');
+        transport.inject(second.peerId, { t: 'VOTE', vote: fixtureAt(certified.certificate, 1) });
+      } else if (mutation === 'bad-submit')
+        transport.inject(first.peerId, {
+          t: 'SUBMIT',
+          cmd: signCommand(commandBody, second.secretKey),
+        });
+      else if (mutation === 'locked')
+        transport.inject(second.peerId, { t: 'VOTE', vote: fixtureAt(certified.certificate, 1) });
+      else if (mutation === 'proposal')
+        transport.inject(first.peerId, {
+          t: 'PROPOSAL',
+          proposal,
+        });
+      else transport.inject(second.peerId, { t: 'COMMIT', certified });
       await replica.flush();
+      if (mutation === 'pending') {
+        safetyBefore = await journal.loadSafety(1);
+        if (!safetyBefore || safetyBefore.revision !== 1)
+          throw new Error('Pending write did not durably retain the signed prevote');
+      }
       expect(statuses).toContain('consensus-context');
-      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(0);
+      expect(capturedRejectedProofs).toBe(mutation === 'bad-submit' ? 1 : 0);
+      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
       expect(transport.sent).toContainEqual({
         t: 'SNAPSHOT_REQ',
         genesisDigest: parent.membership.genesisDigest,
@@ -2583,6 +2776,66 @@
       expect((await journal.load())?.height).toBe(1);
       expect(await journal.loadSafety(1)).toEqual(safetyBefore);
       expect(replica.getContext().log.head.seq).toBe(0);
+
+      const writesBeforeHoldTraffic = journal.safetyWrites;
+      const tradeRequest = replica.requestTradeProof(
+        signTradeProofRequest(
+          {
+            gameId: parent.log.genesis.gameId,
+            genesisDigest: parent.membership.genesisDigest,
+            seat: 3,
+            nonce: 1,
+            headSeq: 0,
+            headHash: entryHash(parent.log.head),
+            command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
+          },
+          local.secretKey,
+        ),
+      );
+      expect(tradeRequest.ok ? null : tradeRequest.error.code).toBe('replica-repairing');
+      expect(replica['pendingTradeProofs'].size).toBe(0);
+      replica.cancelTradeProofRequest('absent');
+      transport.inject(first.peerId, {
+        t: 'SUBMIT',
+        cmd: signCommand(commandBody, first.secretKey),
+      });
+      transport.inject(second.peerId, { t: 'VOTE', vote: fixtureAt(certified.certificate, 1) });
+      transport.inject(second.peerId, {
+        t: 'COMMIT',
+        certified: {
+          entry,
+          certificate: certified.certificate.map((vote) => ({
+            ...vote,
+            sig: fixtureAt(certified.certificate, 0).sig,
+          })),
+        },
+      });
+      transport.inject(first.peerId, {
+        t: 'SYS_CONTRIB',
+        genesisDigest: parent.membership.genesisDigest,
+        contribution: {
+          kind: 'beacon-reveal',
+          signed: {
+            body: {
+              operationId: entryHash(entry),
+              seat: 0,
+              index: 1,
+              value: parent.membership.genesisDigest,
+            },
+            sig: fixtureAt(certified.certificate, 0).sig,
+          },
+        },
+      });
+      clock.advance(2_000);
+      clock.fireFirst();
+      await replica.flush();
+      expect(journal.safetyWrites).toBe(writesBeforeHoldTraffic);
+      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
+      expect(transport.sent.filter((message) => message.t === 'CHEAT_CLAIM')).toHaveLength(0);
+      expect(transport.sent.filter((message) => message.t === 'TRADE_PROOF_REQUEST')).toHaveLength(
+        0,
+      );
+      expect(transport.disconnected).toHaveLength(0);
 
       transport.inject(second.peerId, {
         t: 'SNAPSHOT_RES',
@@ -2593,7 +2846,16 @@
       await replica.flush();
       expect((await journal.load())?.height).toBe(1);
       expect(await journal.loadSafety(1)).toEqual(safetyBefore);
-      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(0);
+      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
+      const loadedAfterReplay = journal.loads;
+      transport.inject(second.peerId, {
+        t: 'SNAPSHOT_RES',
+        genesisDigest: parent.membership.genesisDigest,
+        atSeq: 0,
+        snapshot: { forged: 'distinct' },
+      });
+      await replica.flush();
+      expect(journal.loads).toBe(loadedAfterReplay);
 
       if (mutation === 'safety') {
         if (!(await journal.saveSafety(1, safetyBefore.revision, safetyBefore.bytes)))
@@ -2602,9 +2864,9 @@
         const changed: unknown = canonicalDecode(safetyBefore.bytes);
         if (typeof changed !== 'object' || changed === null || !journal['record'])
           throw new Error('Missing durable safety fixture');
-        Reflect.set(changed, 'locked', { round: 1, hash: entryHash(entry), polka: [] });
+        Reflect.set(changed, 'locked', null);
         // Deliberately corrupt durable bytes without advancing its CAS revision.
-        journal['record'].safety.bytes = canonicalEncode(changed);
+        Reflect.set(journal['record'].safety, 'bytes', canonicalEncode(changed));
       } else if (mutation === 'engine') {
         const apply = engine.apply;
         engine.apply = (state, nextInput) => apply(state, nextInput);
@@ -2618,9 +2880,9 @@
       });
       await replica.flush();
       // oxlint-disable vitest/no-conditional-expect -- Parameterized authority mutations intentionally have different terminal outcomes.
-      if (mutation !== 'unchanged') {
+      if (mutation === 'safety' || mutation === 'locked-safety' || mutation === 'engine') {
         expect((await journal.load())?.height).toBe(1);
-        expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(0);
+        expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
         expect(statuses).toContain(
           mutation === 'engine' ? 'replica-authority' : 'consensus-write-conflict',
         );
@@ -2628,6 +2890,33 @@
         return;
       }
       // oxlint-enable vitest/no-conditional-expect
+      if (
+        mutation === 'locked' ||
+        mutation === 'proposal' ||
+        mutation === 'pending' ||
+        mutation === 'swallowed' ||
+        mutation === 'bad-submit'
+      ) {
+        if (JSON.stringify(await journal.loadSafety(1)) !== JSON.stringify(safetyBefore))
+          throw new Error('Repair changed locked durable safety');
+        if (mutation === 'pending') {
+          const saved: unknown = canonicalDecode(safetyBefore.bytes);
+          if (typeof saved !== 'object' || saved === null)
+            throw new Error('Missing decoded pending safety');
+          const durableVotes: unknown = Reflect.get(saved, 'votes');
+          const emitted = transport.sent
+            .filter((message) => message.t === 'VOTE')
+            .map((message) => message.vote);
+          if (
+            !Array.isArray(durableVotes) ||
+            durableVotes.length !== 1 ||
+            toHex(canonicalEncode(emitted)) !== toHex(canonicalEncode(durableVotes))
+          )
+            throw new Error('Repair did not retransmit exactly the persisted local prevote');
+        }
+        transport.inject(second.peerId, { t: 'COMMIT', certified });
+        await replica.flush();
+      }
       expect((await journal.load())?.height).toBe(2);
       expect(replica.getContext().log.head).toEqual(entry);
       expect((await journal.load())?.entries).toEqual([certified]);

```

## Current packages/protocol/src/consensus.ts:191

```text
interface ContextStamp {
  contextBytes: Uint8Array;
  functions: readonly (readonly [string, unknown])[];
}

// Only an OwnedConsensusState's private state enters this set. Public transition
// functions continue to verify every caller-supplied state in full.
const ownedStates = new WeakSet<ConsensusState>();

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function nonfunctions(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== 'function'));
}

function runtimeReferences(value: object, name: string): (readonly [string, unknown])[] {
  const references: (readonly [string, unknown])[] = [[name, value]];
  let current: object | null = value;
  for (let depth = 0; current && current !== Object.prototype && depth < 8; depth++) {
    references.push([`${name}/prototype/${depth}`, current]);
    for (const key of Object.getOwnPropertyNames(current).toSorted()) {
      const property = Object.getOwnPropertyDescriptor(current, key);
      if (typeof property?.value === 'function')
        references.push([`${name}/${key}`, property.value]);
      if (property?.get) references.push([`${name}/${key}/get`, Reflect.get(property, 'get')]);
      if (property?.set) references.push([`${name}/${key}/set`, Reflect.get(property, 'set')]);
    }
    current = Object.getPrototypeOf(current);
  }
  return references;
}

function contextStamp(context: ProposalContext): ContextStamp {
  const functions: (readonly [string, unknown])[] = [
    ...runtimeReferences(context, 'context'),
    ...runtimeReferences(context.log, 'log'),
    ...runtimeReferences(context.log.engine, 'engine'),
    ...runtimeReferences(context.policy, 'policy'),
    ...(context.policy.randomDerivations
      ? runtimeReferences(context.policy.randomDerivations, 'randomDerivations')
      : [['randomDerivations', null] as const]),
  ];
  const { engine, ...log } = context.log;
  const other = nonfunctions(context);
  delete other.log;
  delete other.policy;
  return {
    contextBytes: canonicalEncode({
      ...other,
      log: {
        ...log,
        lastNonces: [...log.lastNonces],
        engine: nonfunctions(engine),
      },
      policy: {
        ...nonfunctions(context.policy),
        randomDerivations: nonfunctions(context.policy.randomDerivations ?? {}),
      },
    }),
    functions,
  };
}

function sameContextStamp(left: ContextStamp, right: ContextStamp): boolean {
  return (
    sameBytes(left.contextBytes, right.contextBytes) &&
    left.functions.length === right.functions.length &&
    left.functions.every(
      ([name, value], index) =>
        name === right.functions[index]?.[0] && value === right.functions[index]?.[1],
    )
  );
}


```

## Current packages/protocol/src/consensus.ts:1633

```text
/** Private, validated state for one controller height. Public reducers stay fully validating. */
export interface OwnedConsensusState {
  matchesOpenedContext(candidate: ProposalContext): boolean;
  snapshot(): Result<ConsensusState>;
  dispatch(
    event: ConsensusEvent,
    secretKey: Uint8Array,
    admitValue?: LocalVoteAdmissibility,
  ): Result<ConsensusTransition>;
  commit(): Result<void>;
  discard(): void;
}

class OwnedConsensusStateImpl implements OwnedConsensusState {
  private pending: ConsensusState | null = null;

  constructor(
    private state: ConsensusState,
    private readonly context: ProposalContext,
    private readonly stamp: ContextStamp,
  ) {
    ownedStates.add(state);
  }

  matchesOpenedContext(candidate: ProposalContext): boolean {
    try {
      const replayed = contextStamp(candidate);
      // Full replay rebuilds these record wrappers and ancestry closures. Engine,
      // policy, prototypes and their function references must remain identical.
      const rebuilt = new Set([
        'context',
        // runtimeReferences depth zero repeats the wrapper itself; deeper
        // prototype references remain part of the comparison.
        'context/prototype/0',
        'log',
        'log/prototype/0',
        'context/verifyHistoricalCheat',
        'context/verifyHistoricalAccusation',
      ]);
      const openedFunctions = this.stamp.functions.filter(([name]) => !rebuilt.has(name));
      const replayedFunctions = replayed.functions.filter(([name]) => !rebuilt.has(name));
      return (
        sameBytes(this.stamp.contextBytes, replayed.contextBytes) &&
        openedFunctions.length === replayedFunctions.length &&
        openedFunctions.every(
          ([name, reference], index) =>
            name === replayedFunctions[index]?.[0] && reference === replayedFunctions[index]?.[1],
        )
      );
    } catch {
      return false;
    }
  }

  private checkContext(): Result<void> {
    let current: ContextStamp;
    try {
      current = contextStamp(this.context);
    } catch {
      return failure('consensus-context', 'Certified context changed to noncanonical data');
    }
    if (sameContextStamp(this.stamp, current)) return success(undefined);
    if (this.pending)
      return failure('consensus-context', 'Certified context changed during persistence');
    // Once the opening stamp differs, this context cannot validate stored
    // proposals or locks. Only durable replay may establish their authority.
    return failure('consensus-context', 'Certified context changed; restore this voting record');
  }

  snapshot(): Result<ConsensusState> {
    const checked = this.checkContext();
    return checked.ok ? success(copyConsensusStateData(this.state)) : checked;
  }

  dispatch(
    event: ConsensusEvent,
    secretKey: Uint8Array,
    admitValue?: LocalVoteAdmissibility,
  ): Result<ConsensusTransition> {
    const checked = this.checkContext();
    if (!checked.ok) return checked;
    if (this.pending) return failure('consensus-pending', 'Persist the previous transition first');
    let next: Result<ConsensusTransition>;
    switch (event.kind) {
      case 'input-available':
        next = inputAvailable(this.state, this.context);
        break;
      case 'propose':
        next = propose(this.state, this.context, secretKey, event.candidate, admitValue);
        break;
      case 'proposal':
        next = receiveProposal(this.state, this.context, secretKey, event.proposal, admitValue);
        break;
      case 'vote':
        next = receiveVote(this.state, this.context, secretKey, event.vote, admitValue);
        break;
      case 'commit':
        next = receiveCommit(this.state, this.context, event.certified);
        break;
      case 'stage-accusation':
        next = stageAccusation(this.state, this.context, event.control);
        break;
      case 'clear-stale-accusation':
        next = clearStaleAccusation(this.state, this.context);
        break;
      case 'terminal-halt':
        next = terminalHalt(this.state, this.context, event.reason);
        break;
      case 'resume-after-replay':
        next = resumeAfterReplay(this.state, this.context);
        break;
      case 'timeout':
        next = timeout(this.state, this.context, secretKey, event.phase, event.round, admitValue);
        break;
      default: {
        const unknownEvent: never = event;
        return failure('consensus-event', `Unknown consensus event: ${String(unknownEvent)}`);
      }
    }
    const after = this.checkContext();
    if (!after.ok) return after;
    if (!next.ok) return next;
    this.pending = copyConsensusStateData(next.value.state);
    ownedStates.add(this.pending);
    return success({ state: copyConsensusStateData(this.pending), effects: next.value.effects });
  }

  commit(): Result<void> {
    if (!this.pending) throw new Error('No persisted consensus transition to install');
    let current: ContextStamp;
    try {
      current = contextStamp(this.context);
    } catch {
      return failure('consensus-context', 'Certified context changed during persistence');
    }
    if (!sameContextStamp(this.stamp, current))
      return failure('consensus-context', 'Certified context changed during persistence');
    this.state = this.pending;
    this.pending = null;
    return success(undefined);
  }

  discard(): void {
    this.pending = null;
  }
}

export function openOwnedConsensusState(
  value: ConsensusState,
  context: ProposalContext,
  seat: Seat,
): Result<OwnedConsensusState> {
  const restored = restoreConsensusState(value, context, seat);
  if (!restored.ok) return restored;
  try {
    return success(
      new OwnedConsensusStateImpl(restored.value, context, contextStamp(context)),
    );
  } catch {
    return failure('consensus-restore', 'Certified context is not canonical data');
  }
}

```

## Current packages/protocol/src/consensus-controller.ts:1

```text
import { canonicalDecode, canonicalEncode, sha256, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import {
  copyConsensusStateData,
  createConsensusState,
  openOwnedConsensusState,
  recoverConsensusEffects,
  restoreConsensusState,
} from './consensus.js';
import type {
  ConsensusEffect,
  ConsensusEvent,
  LocalVoteAdmissibility,
  OwnedConsensusState,
  ConsensusState,
  ConsensusTransition,
} from './consensus.js';
import type { ProposalContext } from './proposal.js';
import type { SafetyStore, StoredSafety } from './safety-store.js';
import { MAX_MESSAGE_BYTES } from './validation.js';

export type { ConsensusEvent } from './consensus.js';

export interface ConsensusControllerOptions {
  context: ProposalContext;
  seat: Seat;
  secretKey: Uint8Array;
  /** One record for this game/key/height, retained across controller crashes. */
  store: SafetyStore;
  /** Repair must reuse exact durable bytes without normalizing newly found terminal evidence. */
  requireExactRestore?: boolean;
  /** Effects are at-least-once. Handlers must deduplicate committed sequence/value. */
  onEffects: (effects: readonly ConsensusEffect[]) => void | Promise<void>;
  /** Local admission only. It must not alter replay or objective validity. */
  beforePersist?: (previous: ConsensusState, next: ConsensusState) => Result<void>;
  admitLocalValue?: LocalVoteAdmissibility;
}

/**
 * Serializes a single height's transitions and persists before emission.
 * Opening the next height requires a separately persisted certified parent.
 */
export class ConsensusController {
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private contextFault = false;
  private persistedBytes: Uint8Array;
  private readonly secretKey: Uint8Array;
  private readonly rejectedProposals = new Map<string, { code: string; message: string }>();

  private constructor(
    private readonly options: ConsensusControllerOptions,
    private state: ConsensusState,
    private revision: number,
    private readonly owned: OwnedConsensusState,
  ) {
    this.secretKey = options.secretKey.slice();
    this.persistedBytes = canonicalEncode(state);
  }

  /** Only for a genuinely new height; existing or lost stores are not reset here. */
  static async create(options: ConsensusControllerOptions): Promise<Result<ConsensusController>> {
    const validKey = checkLocalKey(options);
    if (!validKey.ok) return validKey;
    const initial = createConsensusState(options.context, options.seat);
    if (!initial.ok) return initial;
    try {
      if (await options.store.load())
        return failure(
          'consensus-store-exists',
          'Restore existing vote records instead of resetting',
        );
      const owned = openOwnedConsensusState(initial.value, options.context, options.seat);
      if (!owned.ok) return owned;
      const saved = await options.store.save(null, canonicalEncode(initial.value));
      if (!saved)
        return failure('consensus-write-conflict', 'Another writer initialized this voting record');
      return success(new ConsensusController(options, initial.value, 0, owned.value));
    } catch {
      return failure('consensus-storage', 'Could not persist the initial voting record');
    }
  }

  /** An absent or damaged record fails closed; this never creates round-one state. */
  static async restore(options: ConsensusControllerOptions): Promise<Result<ConsensusController>> {
    const validKey = checkLocalKey(options);
    if (!validKey.ok) return validKey;
    let record: StoredSafety | null;
    try {
      record = await options.store.load();
    } catch {
      return failure('consensus-storage', 'Could not read the voting record');
    }
    if (!record)
      return failure(
        'consensus-store-missing',
        'The voting record is missing; key replacement is required',
      );
    if (!Number.isSafeInteger(record.revision) || record.revision < 0)
      return failure('consensus-storage', 'Stored voting revision is invalid');
    let restored: Result<ConsensusState>;
    try {
      restored = restoreConsensusState(
        canonicalDecode(record.bytes),
        options.context,
        options.seat,
      );
    } catch {
      return failure('consensus-storage', 'Stored voting data is not valid canonical data');
    }
    if (!restored.ok) return restored;
    let revision = record.revision;
    const normalized = canonicalEncode(restored.value);
    if (!sameBytes(normalized, record.bytes)) {
      if (options.requireExactRestore || restored.value.haltKind !== 'terminal')
        return failure('consensus-restore', 'Voting record changed without a terminal proof');
      try {
        if (!(await options.store.save(revision, normalized)))
          return failure('consensus-write-conflict', 'Voting record changed during terminal halt');
      } catch {
        return failure('consensus-storage', 'Could not persist the verified terminal halt');
      }
      revision++;
    }
    const owned = openOwnedConsensusState(restored.value, options.context, options.seat);
    return owned.ok
      ? success(new ConsensusController(options, restored.value, revision, owned.value))
      : owned;
  }

  /** Returns a detached, verified snapshot, never the mutable internal record. */
  snapshot(): Result<ConsensusState> {
    const snapshot = this.owned.snapshot();
    if (!snapshot.ok) {
      this.stopVoting(snapshot.error.code);
      return snapshot;
    }
    if (!sameBytes(canonicalEncode(snapshot.value), canonicalEncode(this.state))) {
      this.stopVoting();
      return failure('consensus-restore', 'Restore to persist newly verified terminal evidence');
    }
    return snapshot;
  }

  /** The opening stamp remains usable after the mutable derived context fails its guard. */
  opensOn(context: ProposalContext): boolean {
    return this.owned.matchesOpenedContext(context);
  }

  hasContextFault(): boolean {
    return this.contextFault;
  }

  settled(): Promise<void> {
    return this.queue.then(
      () => undefined,
      () => undefined,
    );
  }

  matchesPersistedRecord(record: StoredSafety): boolean {
    return record.revision === this.revision && sameBytes(record.bytes, this.persistedBytes);
  }

  /** Expected CAS revision for atomically committing this controller's height. */
  persistedRevision(): number {
    return this.revision;
  }

  /** Call after restoring to retransmit signed records and re-arm timers. */
  resume(): Promise<Result<void>> {
    return this.enqueue(async () => {
      const snapshot = this.snapshot();
      if (!snapshot.ok) return snapshot;
      const recovered = recoverConsensusEffects(this.state, this.options.context);
      if (!recovered.ok) {
        this.stopVoting();
        return recovered;
      }
      return this.emit(recovered.value);
    });
  }

  dispatch(event: ConsensusEvent): Promise<Result<void>> {
    return this.enqueue(async () => {
      if (event.kind === 'proposal' && this.isRecordedProposalReplay(event.proposal))
        return success(undefined);
      const proposalKey = event.kind === 'proposal' ? this.proposalKey(event.proposal) : null;
      const rejected = proposalKey ? this.rejectedProposals.get(proposalKey) : undefined;
      if (rejected)
        return failure(rejected.code, rejected.message, {
          proposalEntryRejected: true,
          cached: true,
        });
      const next = this.reduce(event);
      if (!next.ok) {
        if (next.error.code === 'consensus-restore' || next.error.code === 'consensus-context')
          this.stopVoting(next.error.code);
        else if (
          proposalKey &&
          next.error.details?.proposalEntryRejected === true &&
          next.error.details.proposalControl !== true
        ) {
          // Entry validation depends on this controller's fixed certified parent,
          // not its current round/votes. Controls can discover a second offender
          // after another proof is retained, so always reconsider them.
          this.rejectedProposals.set(proposalKey, {
            code: next.error.code,
            message: next.error.message,
          });
          if (this.rejectedProposals.size > 16) {
            const oldest = this.rejectedProposals.keys().next().value;
            if (oldest !== undefined) this.rejectedProposals.delete(oldest);
          }
        }
        return next;
      }
      const candidate = next.value.state;
      const admitted = this.options.beforePersist?.(
        copyConsensusStateData(this.state),
        copyConsensusStateData(candidate),
      );
      if (admitted && !admitted.ok) {
        this.owned.discard();
        return admitted;
      }
      let persistedBytes: Uint8Array;
      try {
        const bytes = canonicalEncode(candidate);
        persistedBytes = bytes.slice();
        if (!(await this.options.store.save(this.revision, bytes))) {
          this.owned.discard();
          this.stopped = true;
          return failure(
            'consensus-write-conflict',
            'Voting stopped because a newer record exists',
          );
        }
      } catch {
        this.owned.discard();
        this.stopped = true;
        return failure(
          'consensus-storage',
          'Voting stopped because its state could not be persisted',
        );
      }
      this.persistedBytes = persistedBytes;
      this.revision += 1;
      const committed = this.owned.commit();
      if (!committed.ok) {
        this.owned.discard();
        this.stopVoting(committed.error.code);
        return committed;
      }
      this.state = copyConsensusStateData(candidate);
      // A dispose/crash during the write must not transmit after the write resolves.
      if (this.stopped)
        return failure('consensus-stopped', 'Controller stopped during persistence');
      return this.emit(next.value.effects);
    });
  }

  dispose(): void {
    this.stopVoting();
  }

  private stopVoting(code?: string): void {
    if (code === 'consensus-context') this.contextFault = true;
    this.stopped = true;
    this.secretKey.fill(0);
    this.rejectedProposals.clear();
  }

  private proposalKey(value: unknown): string | null {
    try {
      const bytes = canonicalEncode(value);
      return bytes.length <= MAX_MESSAGE_BYTES ? toHex(sha256(bytes)) : null;
    } catch {
      return null;
    }
  }

  /** Stored proposals were validated before persistence; exact replays need no transition. */
  private isRecordedProposalReplay(value: unknown): boolean {
    let bytes: Uint8Array;
    try {
      bytes = canonicalEncode(value);
    } catch {
      return false;
    }
    if (bytes.byteLength > MAX_MESSAGE_BYTES) return false;
    const recorded = [
      ...this.state.proposals,
      ...this.state.hints.flatMap((hint) => (hint.kind === 'proposal' ? [hint.proposal] : [])),
    ].find((proposal) => sameBytes(bytes, canonicalEncode(proposal)));
    if (!recorded) return false;
    // A proposal retained before entering its round may still need its first vote.
    return !(
      recorded.body.entry.term === this.state.round &&
      this.state.step === 'propose' &&
      !this.state.votes.some(
        (vote) =>
          vote.body.seat === this.state.localSeat &&
          vote.body.term === this.state.round &&
          vote.body.phase === 'prevote',
      )
    );
  }

  private enqueue(operation: () => Promise<Result<void>>): Promise<Result<void>> {
    const result = this.queue.then(async (): Promise<Result<void>> => {
      if (this.stopped)
        return failure('consensus-stopped', 'Restore the persisted record before continuing');
      try {
        return await operation();
      } catch {
        this.owned.discard();
        this.stopVoting();
        return failure('consensus-controller', 'Consensus transition failed; voting has stopped');
      }
    });
    this.queue = result;
    return result;
  }

  private reduce(event: ConsensusEvent): Result<ConsensusTransition> {
    return this.owned.dispatch(event, this.secretKey, this.options.admitLocalValue);
  }

  private async emit(effects: readonly ConsensusEffect[]): Promise<Result<void>> {
    if (effects.length === 0) return success(undefined);
    try {
      await this.options.onEffects(effects);
      return success(undefined);
    } catch {
      // The saved state can reproduce signed messages after a partial delivery.
      this.stopped = true;
      return failure('consensus-effects', 'Effect delivery failed; restore before retrying');
    }
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function checkLocalKey(options: ConsensusControllerOptions): Result<void> {
  try {
    const identity = identityFromSecret(options.secretKey);
    const voter = options.context.membership.voters.find((member) => member.seat === options.seat);
    return voter?.publicKey === identity.peerId
      ? success(undefined)
      : failure('consensus-key', 'The local key does not match the certified voter');
  } catch {
    return failure('consensus-key', 'The local voting key is invalid');
  }
}

```

## Current packages/protocol/src/replicated-log.ts:343

```text
  private controllerAnchor: {
    seq: number;
    hash: string;
    genesisDigest: string;
    voters: readonly string[];
    membership: VoteContext;
  } | null = null;
  private derivedRepair: {
    stopped: ConsensusController;
    anchor: NonNullable<ReplicatedLog['controllerAnchor']>;
    heldCommits: Map<string, CertifiedEntry>;
    lastRequestAt: number;
    replayed?: {
      context: ProposalContext;
      entries: CertifiedEntry[];
      snapshotHash: string;
      prefixHash: string;
    };
  } | null = null;


```

## Current packages/protocol/src/replicated-log.ts:514

```text
  private async repairNow(snapshot?: unknown): Promise<Result<void>> {
    const hold = this.derivedRepair;
    if (hold) await hold.stopped.settled();
    else {
      const state = this.activeController().snapshot();
      if (!state.ok) return state;
      if (state.value.haltKind !== 'certified-validation')
        return failure('replica-repair', 'Only a certified validation halt can be repaired');
    }
    if (
      hold?.replayed &&
      snapshot !== undefined &&
      toHex(hashValue(snapshot)) !== hold.replayed.snapshotHash
    )
      return failure('snapshot-mismatch', 'Snapshot differs from the certified replay');
    let record: Awaited<ReturnType<ProtocolJournal['load']>>;
    try {
      record = await this.options.journal.load();
    } catch {
      return failure('replica-storage', 'Could not read the certified journal for repair');
    }
    if (!record)
      return this.failClosed('replica-journal', 'Certified journal is missing during repair');
    if (
      !sameBytes(canonicalEncode(record.genesis), canonicalEncode(this.genesisEntry)) ||
      !sameBytes(canonicalEncode(record.genesis), canonicalEncode(this.options.genesisEntry))
    )
      return this.failClosed('replica-genesis', 'Repair journal differs from the original genesis');
    const prefixHash = toHex(hashValue({ genesis: record.genesis, entries: record.entries }));
    if (hold?.replayed && prefixHash !== hold.replayed.prefixHash)
      return this.failClosed('replica-journal', 'Certified journal changed during repair');
    const replayed = hold?.replayed
      ? success(hold.replayed)
      : replayCertifiedPrefix(
          record.genesis,
          record.entries,
          this.options.engine,
          this.options.policy,
        );
    if (!replayed.ok)
      return hold ? this.failClosed(replayed.error.code, replayed.error.message) : replayed;
    const fresh = replayed.value.context;
    if (
      record.height !== fresh.log.head.seq + 1 ||
      fresh.log.head.seq !== (hold?.anchor.seq ?? this.context.log.head.seq) ||
      entryHash(fresh.log.head) !== (hold?.anchor.hash ?? entryHash(this.context.log.head))
    )
      return this.failClosed('replica-journal', 'Certified parent changed during repair');
    if (hold && !hold.stopped.opensOn(fresh))
      return this.failClosed(
        'replica-authority',
        'Durable replay differs from the controller opening context',
      );
    if (hold && !hold.replayed)
      hold.replayed = {
        context: fresh,
        entries: replayed.value.entries,
        snapshotHash: toHex(hashValue(snapshotFromContext(fresh))),
        prefixHash,
      };
    if (hold && snapshot === undefined)
      return failure('replica-repairing', 'Derived repair requires a replay-verified snapshot');
    if (snapshot !== undefined) {
      const checked = verifyReplaySnapshot(snapshot, fresh);
      if (!checked.ok) return checked;
    }
    let restored: ConsensusController | null = null;
    if (hold) {
      const safety = record.safety;
      if (!hold.stopped.matchesPersistedRecord(safety))
        return this.failClosed(
          'consensus-write-conflict',
          'Durable vote or lock record changed during repair',
        );
      const local = checkLocalKey(this.options, fresh);
      if (!local.ok) return this.failClosed(local.error.code, local.error.message);
      for (const key of local.value.keys.values()) key.fill(0);
      const opened = await this.restoreController(fresh, true);
      if (!opened.ok) return this.failClosed(opened.error.code, opened.error.message);
      restored = opened.value;
      let stillStored: Awaited<ReturnType<ProtocolJournal['loadSafety']>>;
      try {
        stillStored = await this.options.journal.loadSafety(record.height);
      } catch {
        restored.dispose();
        return failure('replica-storage', 'Could not recheck durable safety during repair');
      }
      if (!stillStored || !hold.stopped.matchesPersistedRecord(stillStored)) {
        restored.dispose();
        return this.failClosed(
          'consensus-write-conflict',
          'Durable safety changed while restoring repair',
        );
      }
    }
    if (!hold) this.activeController().dispose();
    this.controller = null;
    this.context = fresh;
    this.timerObserver.advance(fresh.log.timers ?? []);
    this.clearTimedVoteRetry();
    this.clearRecoveryCandidate();
    this.rejectedCommands.clear();
    this.rejectedProposals.clear();
    this.rejectedDeckContributions.clear();
    this.rejectedCountContributions.clear();
    this.rejectedStealMessages.clear();
    this.rejectedMasterReveals.clear();
    this.invalidByPeer.clear();
    this.blockedPeers.clear();
    this.preparedDeckPrefix = null;
    this.sentDeckPrefix = null;
    this.entries = replayed.value.entries;
    this.refreshHistoricalHumanPeers();
    for (const [id, claim] of this.cheatCandidates)
      if (!this.verifiedCheatClaim(claim).ok) this.cheatCandidates.delete(id);
    if (!restored) {
      const opened = await this.openController();
      if (!opened.ok) return this.failClosed(opened.error.code, opened.error.message);
      return this.activeController().dispatch({ kind: 'resume-after-replay' });
    }
    this.installController(restored, fresh);
    this.derivedRepair = null;
    const resumed = await restored.resume();
    if (!resumed.ok) return resumed;
    for (const certified of hold?.heldCommits.values() ?? []) {
      // oxlint-disable-next-line no-await-in-loop -- Retained untrusted hints are fully validated on the freshly restored parent.
      const accepted = await this.acceptCertified(certified);
      if (!accepted.ok && FATAL_CONTROLLER_ERRORS.has(accepted.error.code)) return accepted;
    }
    this.schedulePulse();
    return this.requestSync(this.context.log.head.seq + 1);
  }


```

## Current packages/protocol/src/replicated-log.ts:1018

```text
  /** Send one authorized trade-proof request directly to its counterparty host. */
  requestTradeProof(value: SignedTradeProofRequest): Result<void> {
    if (this.disposed) return failure('replica-disposed', 'Replica has been disposed');
    if (this.derivedRepair || this.controller?.hasContextFault())
      return failure('replica-repairing', 'Awaiting certified derived-state repair');
    const checked = verifyTradeProofRequest(value, this.context.log);
    if (!checked.ok) return checked;
    const request = checked.value;
    const finalizerHost = tradeProofHost(
      this.context.log.genesis,
      request.body.seat,
      this.context.log.authority,
    );
    const ownerHost = tradeProofHost(
      this.context.log.genesis,
      request.body.command.withSeat,
      this.context.log.authority,
    );
    if (
      !this.deckKeys.has(request.body.seat) ||
      finalizerHost !== this.self ||
      !ownerHost ||
      ownerHost === this.self
    )
      return failure('trade-proof-route', 'Request is not for a remotely hosted trade owner');
    const requestId = tradeProofRequestId(request.body);
    const existing = this.pendingTradeProofs.get(requestId);
    if (existing && !sameBytes(canonicalEncode(existing.request), canonicalEncode(request)))
      return failure('trade-proof-request-id', 'Request identifier is already reserved');
    if (!existing && this.pendingTradeProofs.size >= MAX_TRADE_PROOF_CACHE)
      return failure('trade-proof-capacity', 'Too many trade-proof requests are pending');
    this.pendingTradeProofs.set(requestId, { request, ownerHost });
    return this.send(ownerHost, { t: 'TRADE_PROOF_REQUEST', request });
  }

  /** Cancel a pre-admission proof wait; late responses are then ignored. */
  cancelTradeProofRequest(requestId: string): void {
    this.pendingTradeProofs.delete(requestId);
  }

  private activeController(): ConsensusController {
    if (!this.controller) throw new Error('No active consensus controller');
    return this.controller;
  }


```

## Current packages/protocol/src/replicated-log.ts:1195

```text
  private restoreController(
    context: ProposalContext,
    exact = false,
  ): Promise<Result<ConsensusController>> {
    return ConsensusController.restore({
      context,
      requireExactRestore: exact,
      seat: this.options.seat,
      secretKey: this.secretKey,
      store: journalSafetyStore(this.options.journal, context.log.head.seq + 1),
      onEffects: (effects) => this.handleEffects(effects),
      admitLocalValue: (proposal) => this.canVoteForRecoveryProposal(proposal),
      beforePersist: (previous, next) => {
        const timed = this.admitTimedVotes(previous, next);
        return timed.ok ? this.admitRecoveryVotes(previous, next) : timed;
      },
    });
  }

  private installController(controller: ConsensusController, context: ProposalContext): void {
    this.controller = controller;
    this.controllerAnchor = Object.freeze({
      seq: context.log.head.seq,
      hash: entryHash(context.log.head),
      genesisDigest: context.membership.genesisDigest,
      voters: Object.freeze(context.membership.voters.map((voter) => voter.publicKey)),
      membership: Object.freeze({
        ...context.membership,
        voters: Object.freeze(
          context.membership.voters.map((voter) => Object.freeze({ ...voter })),
        ),
      }),
    });
  }

  private async openController(): Promise<Result<void>> {
    const opened = await this.restoreController(this.context);
    if (!opened.ok) return opened;
    this.installController(opened.value, this.context);
    return success(undefined);
  }

  private enterDerivedRepair(): boolean {
    if (this.derivedRepair) return true;
    if (!this.controller || !this.controllerAnchor) return false;
    const stopped = this.controller;
    stopped.dispose();
    this.controller = null;
    this.derivedRepair = {
      stopped,
      anchor: this.controllerAnchor,
      heldCommits: new Map(),
      lastRequestAt: -Infinity,
    };
    this.clearConsensusTimers();
    this.clearTimedVoteRetry();
    this.status({ kind: 'halted', code: 'consensus-context' });
    this.requestDerivedSnapshot();
    this.schedulePulse();
    return true;
  }

  private requestDerivedSnapshot(): Result<void> {
    const hold = this.derivedRepair;
    if (!hold || this.options.clock.now() - hold.lastRequestAt < 2_000) return success(undefined);
    hold.lastRequestAt = this.options.clock.now();
    return this.broadcast({
      t: 'SNAPSHOT_REQ',
      genesisDigest: hold.anchor.genesisDigest,
      atSeq: hold.anchor.seq,
    });
  }

  private retainHeldCommit(certified: CertifiedEntry): void {
    const hold = this.derivedRepair;
    if (
      !hold ||
      certified.entry.seq !== hold.anchor.seq + 1 ||
      certified.entry.prevHash !== hold.anchor.hash ||
      hold.heldCommits.size >= 4
    )
      return;
    const hash = entryHash(certified.entry);
    if (hold.heldCommits.has(hash)) return;
    if (
      !verifyObject(
        'entry',
        entryBody(certified.entry),
        certified.entry.sig,
        parsePeerId(certified.entry.sequencer),
      )
    )
      return;
    const certificate = verifyCertificate(certified.certificate, hold.anchor.membership, {
      seq: certified.entry.seq,
      term: certified.entry.term,
      phase: 'precommit',
      valueHash: hash,
    });
    if (!certificate.ok) return;
    hold.heldCommits.set(hash, copyCanonical(certified));
  }

  private receiveDuringRepair(from: PeerId, message: ProtocolMessage): Promise<Result<void>> {
    const hold = this.derivedRepair;
    if (!hold || !hold.anchor.voters.includes(from)) return Promise.resolve(success(undefined));
    if (message.t === 'SNAPSHOT_RES') {
      if (
        message.genesisDigest !== hold.anchor.genesisDigest ||
        message.atSeq !== hold.anchor.seq ||
        !this.admitExpensiveRequest(from, `snapshot-response/${toHex(hashValue(message.snapshot))}`)
      )
        return Promise.resolve(success(undefined));
      return this.repairNow(message.snapshot);
    }
    if (message.t === 'COMMIT') this.retainHeldCommit(message.certified);
    if (message.t === 'PING') return Promise.resolve(this.send(from, { t: 'PONG', n: message.n }));
    return Promise.resolve(success(undefined));
  }

  private enqueue<T>(
    operation: () => Promise<Result<T>>,
    duringRepair = false,
  ): Promise<Result<T>> {
    const result = this.queue.then(async (): Promise<Result<T>> => {
      if (this.disposed) return failure('replica-disposed', 'Replicated log is closed');
      if (this.derivedRepair && !duringRepair)
        return failure('replica-repairing', 'Awaiting certified derived-state repair');
      try {
        const outcome = await operation();
        if (
          (this.controller?.hasContextFault() ||
            (!outcome.ok && outcome.error.code === 'consensus-context')) &&
          this.enterDerivedRepair()
        )
          return failure('consensus-context', 'Certified context changed; awaiting durable replay');
        if (!outcome.ok && FATAL_CONTROLLER_ERRORS.has(outcome.error.code)) {
          this.status({ kind: 'halted', code: outcome.error.code });
          this.dispose();
        }
        return outcome;
      } catch {
        this.status({ kind: 'halted', code: 'replica-transition' });
        this.dispose();
        return failure('replica-transition', 'Replicated log transition failed');
      }
    });
    this.queue = result;
    return result;
  }

  private attachTransport(): void {
    this.unsubscribers.push(
      this.options.transport.onMessage((from, bytes) => {
        if (this.blockedPeers.has(from)) return;
        if (!this.knownSyncPeer(from)) {
          this.rejectPeer(from);
          return;
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_MESSAGE_BYTES) {
          this.strikePeer(from);
          return;
        }
        const peerQueued = this.queuedByPeer.get(from) ?? 0;
        if (
          peerQueued >= MAX_QUEUED_MESSAGES_PER_PEER ||
          this.queuedMessages >= MAX_QUEUED_MESSAGES_TOTAL
        ) {
          // Congestion does not prove peer misconduct. Honest retransmission bursts
          // may exceed the bounded queue while a certified batch is replaying.
          return;
        }
        const copy = bytes.slice();
        this.queuedByPeer.set(from, peerQueued + 1);
        this.queuedMessages += 1;
        void this.enqueue(async () => {
          const result = await this.receive(from, copy);
          if (
            !this.derivedRepair &&
            !this.controller?.hasContextFault() &&
            !result.ok &&
            !FATAL_CONTROLLER_ERRORS.has(result.error.code)
          )
            await this.captureRejectedProofs(from, copy);
          return result;
        }, true).then((result) => {
          this.queuedMessages -= 1;
          const remaining = (this.queuedByPeer.get(from) ?? 1) - 1;
          if (remaining === 0) this.queuedByPeer.delete(from);
          else this.queuedByPeer.set(from, remaining);
          if (
            !result.ok &&
            (result.error.code === 'invalid-envelope' ||
              result.error.code === 'invalid-encoding' ||
              result.error.code === 'message-too-large' ||
              result.error.code === 'command-proof-invalid' ||
              result.error.code.endsWith('-signature'))
          )
            this.strikePeer(from);
          return undefined;
        });
      }),
    );
    this.unsubscribers.push(
      this.options.transport.onPeerChange((peer, online) => {
        void this.enqueue(async () => {
          if (this.derivedRepair) return this.pulse();
          const checked = this.activeController().snapshot();
          if (!checked.ok) return checked;
          this.observeAllRecoveryPresence();
          if (online) this.cancelRecoveryForReturningPeer(peer);
          return this.pulse();
        }, true);
      }),
    );
  }

  private formerHumanPeer(peer: PeerId): boolean {
    return this.historicalHumanPeers.has(peer);
  }

  private rememberHumanActivation(entry: LogEntry): void {
    if (entry.payload.kind !== 'membership') return;
    const parsed = v.safeParse(transferChangeSchema, entry.payload.change);
    if (parsed.success && parsed.output.kind === 'transfer-activate')
      this.historicalHumanPeers.add(parsed.output.statement.destinationGame);
  }

  private refreshHistoricalHumanPeers(): void {
    this.historicalHumanPeers.clear();
    for (const seat of this.context.log.genesis.seats)
      if (seat.kind === 'human') this.historicalHumanPeers.add(seat.publicKey);
    // `entries` came from certified replay or local validated commits. Pending
    // authorizations never enter this set; only activated human controllers do.
    for (const { entry } of this.entries) this.rememberHumanActivation(entry);
  }

  private knownSyncPeer(peer: PeerId): boolean {
    return (
      (this.derivedRepair?.anchor.voters.includes(peer) ??
        this.context.membership.voters.some((voter) => voter.publicKey === peer)) ||
      this.formerHumanPeer(peer)
    );
  }

  private strikePeer(peer: PeerId): void {
    if (this.derivedRepair) return;
    const checked = this.controller?.snapshot();
    if (checked && !checked.ok) {
      if (checked.error.code === 'consensus-context') this.enterDerivedRepair();
      else this.failClosed(checked.error.code, checked.error.message);
      return;
    }
    const count = (this.invalidByPeer.get(peer) ?? 0) + 1;
    this.invalidByPeer.set(peer, count);
    if (count >= INVALID_MESSAGE_LIMIT) this.rejectPeer(peer);
  }

  private rejectPeer(peer: PeerId): void {
    if (this.blockedPeers.has(peer)) return;
    this.blockedPeers.add(peer);
    try {
      this.options.transport.disconnect(peer);
    } catch {
      // The local receive path still blocks this peer if transport teardown fails.
    }
  }


```

## Current packages/protocol/src/replicated-log.ts:1925

```text
  private async receive(from: PeerId, bytes: Uint8Array): Promise<Result<void>> {
    if (this.blockedPeers.has(from)) return success(undefined);
    const decoded = decodeProtocolMessage(bytes);
    if (!decoded.ok) return decoded;
    const message = decoded.value;
    if (this.derivedRepair) return this.receiveDuringRepair(from, message);
    const voter = this.context.membership.voters.some((item) => item.publicKey === from);
    if (!voter && !this.formerHumanPeer(from))
      return failure('replica-peer', 'Sender is not a certified voter or historical human');
    if (!voter && message.t !== 'SYNC_REQ')
      return failure('replica-peer', 'Former voters may only request certified history');

```

## Current packages/protocol/src/replicated-log.ts:2120

```text
      case 'PROPOSAL': {
        const entry = message.proposal.body.entry;
        if (
          entry.payload.kind === 'control' &&
          objectiveEvidenceSeq(entry.payload) < this.context.log.head.seq + 1
        ) {
          const authenticated = authenticateSignedProposal(message.proposal, this.context);
          if (!authenticated.ok) return authenticated;
          if (
            !this.admitExpensiveRequest(
              from,
              `historical-proposal/${toHex(hashValue(message.proposal))}`,
            )
          )
            return success(undefined);
        }
        if (
          entry.payload.kind === 'cheat-proof' &&
          entry.payload.claim.evidence.at.seq < this.context.log.head.seq
        ) {
          const authenticated = authenticateSignedProposal(message.proposal, this.context);
          if (!authenticated.ok) return authenticated;
          if (
            !this.admitExpensiveRequest(
              from,
              `historical-cheat/${toHex(hashValue(message.proposal))}`,
              'historical-cheat',
            )
          )
            return success(undefined);
        }
        let received = await this.activeController().dispatch({
          kind: 'proposal',
          proposal: message.proposal,
        });
        if (!received.ok) {
          if (FATAL_CONTROLLER_ERRORS.has(received.error.code)) return received;
          await this.captureRejectedProofs(from, bytes);
          if (
            received.error.code === 'recovery-approval-required' &&
            entry.payload.kind === 'membership'
          ) {
            const preview = this.previewRecoveryAuthorization(entry.payload.change);
            if (!preview.ok) return preview;
            if (
              this.recoveryCandidateForApproval &&
              this.recoveryCandidateForApproval.preview.statementHash !==
                preview.value.preview.statementHash
            )
              return success(undefined);
            this.rememberRecoveryCandidate(preview.value);
            this.pendingRecoveryProposal = copyCanonical(message.proposal);
            return success(undefined);
          }
          if (
            received.error.code === 'turn-timeout-early' &&
            entry.payload.kind === 'system' &&
            entry.payload.input.type === 'TIMEOUT'
          ) {
            const pending = this.timedVoteRetry;
            if (pending?.parentHash === entryHash(this.context.log.head))
              pending.proposal = copyCanonical(message.proposal);
            return success(undefined);
          }
          if (
            received.error.details?.proposalEntryRejected === true &&
            !FATAL_CONTROLLER_ERRORS.has(received.error.code) &&
            entry.seq === this.context.log.head.seq + 1 &&
            entry.prevHash === entryHash(this.context.log.head)
          ) {
            // A local fault can reject an honest value. Count each distinct
            // failure once so retransmissions cannot isolate us before repair.
            if (rememberRejection(this.rejectedProposals, toHex(hashValue(message.proposal))))
              this.strikePeer(from);
            received = failure('proposal-proof-invalid', 'Proposal entry verification failed', {
              cause: received.error.code,
            });
          }
          if (
            entry.payload.kind !== 'command' &&
            (this.context.log.genesis.security !== 'verified' ||
              (entry.payload.kind !== 'system' && entry.payload.kind !== 'crypto'))
          )
            return received;
          try {
            const offender = proposerFor(
              entry.seq,
              entry.term,
              this.context.membership,
              this.context.excludedProposers,
            ).seat;
            if (!this.admitExpensiveRequest(from, `proposal/${toHex(hashValue(message.proposal))}`))
              return received;
            const accused = await this.rememberAccusation({
              kind: 'control',
              action: 'exclude-proposer',
              offender,
              evidence: {
                kind: entry.payload.kind === 'command' ? 'invalid-command' : 'invalid-proof',
                proposal: message.proposal,
              },
            });
            if (accused.ok) return success(undefined);
          } catch {
            // An invalid proposer index is not accusation evidence.
          }
        }
        if (received.ok && entry.payload.kind === 'membership') {
          const preview = this.previewRecoveryAuthorization(entry.payload.change);
          if (preview.ok) this.rememberRecoveryCandidate(preview.value);
        }
        return received;
      }

```

## Current packages/protocol/src/replicated-log.ts:2379

```text
    const accepted = await this.activeController().dispatch({ kind: 'commit', certified });
    if (!accepted.ok && accepted.error.code === 'consensus-context' && this.enterDerivedRepair())
      this.retainHeldCommit(certified);
    return accepted;
  }


```

## Current packages/protocol/src/replicated-log.ts:3604

```text
  private async captureRejectedProofs(from: PeerId, bytes: Uint8Array): Promise<void> {
    if (
      this.disposed ||
      this.derivedRepair ||
      this.controller?.hasContextFault() ||
      this.context.log.genesis.security !== 'verified'
    )
      return;
    const checked = this.controller?.snapshot();
    if (checked && !checked.ok) {
      if (checked.error.code === 'consensus-context') this.enterDerivedRepair();
      else this.failClosed(checked.error.code, checked.error.message);
      return;
    }
    if (
      !this.context.membership.voters.some((voter) => voter.publicKey === from) ||
      !this.admitExpensiveRequest(from, `capture/${toHex(hashValue(bytes))}`, 'cheat')
    )
      return;
    for (const claim of rejectedWireProofCandidates(bytes, this.context.log)) {
      // Retain before gossip; a candidate is still untrusted until the objective
      // verifier checks its signature and proof against this certified parent.
      // oxlint-disable-next-line no-await-in-loop -- Bounded candidates share one durable outbox.
      const retained = await this.rememberCheatClaim(claim, true);
      if (!retained.ok && retained.error.code.startsWith('cheat-store-'))
        this.status({ kind: 'rejected', code: retained.error.code });
    }
  }


```

## Current packages/protocol/src/replicated-log.ts:3844

```text
  private async handleEffects(effects: readonly ConsensusEffect[], index = 0): Promise<void> {
    const effect = effects[index];
    if (!effect || this.derivedRepair) return;
    switch (effect.kind) {
      case 'broadcast-proposal':
        this.requireSend(this.broadcast({ t: 'PROPOSAL', proposal: effect.proposal }));
        break;
      case 'broadcast-vote':
        this.requireSend(this.broadcast({ t: 'VOTE', vote: effect.vote }));
        break;
      case 'schedule-timeout':
        this.scheduleConsensusTimeout(effect.phase, effect.round);
        break;
      case 'request-value':
        void this.enqueue(() => this.maybePropose());
        break;
      case 'request-proposal':
        this.requireSend(
          this.broadcast({
            t: 'PROPOSAL_REQ',
            genesisDigest: this.context.membership.genesisDigest,
            epoch: this.context.membership.epoch,
            seq: this.context.log.head.seq + 1,
            term: effect.round,
            valueHash: effect.hash,
          }),
        );
        break;
      case 'commit':
        await this.persistCommit(effect.certified);
        break;
      case 'equivocation': {
        void this.enqueue(() => this.rememberAccusation(controlForEquivocation(effect.evidence)));
        break;
      }
      case 'halt': {
        this.status({ kind: 'halted', code: effect.reason });
        const state = this.activeController().snapshot();
        if (state.ok && state.value.haltKind === 'certified-validation')
          this.requireSend(
            this.broadcast({
              t: 'SNAPSHOT_REQ',
              genesisDigest: this.context.membership.genesisDigest,
              atSeq: this.context.log.head.seq,
            }),
          );
        break;
      }
    }
    await this.handleEffects(effects, index + 1);
  }


```

## Current packages/protocol/src/replicated-log.ts:4107

```text
  private async pulse(): Promise<Result<void>> {
    try {
      if (this.derivedRepair) return this.requestDerivedSnapshot();
      const snapshot = this.activeController().snapshot();
      if (!snapshot.ok) return snapshot;
      this.observeAllRecoveryPresence();
      this.notifyAutoTakeoverEligibility();
      const body = {
        genesisDigest: this.context.membership.genesisDigest,
        epoch: this.context.membership.epoch,
        seat: this.options.seat,
        head: { seq: this.context.log.head.seq, hash: entryHash(this.context.log.head) },
        term: snapshot.value.round,
      };
      const heartbeat = this.broadcast({
        t: 'HEARTBEAT',
        body,
        sig: signObject('heartbeat', body, this.secretKey),
      });
      if (!heartbeat.ok) return heartbeat;
      this.broadcastNextCheatClaim();
      for (const pending of this.pending)
        this.requireSend(this.broadcast({ t: 'SUBMIT', cmd: pending.signed }));
      if (this.membershipIntent)
        this.requireSend(
          this.broadcast({ t: 'MEMBERSHIP_SUBMIT', change: this.membershipIntent.change }),
        );
      const recovered = await this.activeController().resume();
      if (!recovered.ok) return recovered;
      await this.captureCertifiedDelivery();
      const offered = await this.offerAvailableInput(true);
      return offered.ok ? this.requestSync(this.context.log.head.seq + 1) : offered;
    } finally {
      this.schedulePulse();
    }
  }


```

## Current packages/protocol/src/replicated-log.test.ts:22

```text
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function mutateNonceMap(nonces: ReadonlyMap<Seat, number>): void {
  if (nonces instanceof Map) nonces.set(0, 999);
}

class PausableJournal extends MemoryProtocolJournal {
  pauseUpdates = false;
  safetyWrites = 0;
  loads = 0;
  private notify: () => void = () => undefined;
  private release: () => void = () => undefined;
  readonly entered = new Promise<void>((resolve) => {
    this.notify = resolve;
  });
  private readonly resumed = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  releaseWrite(): void {
    this.pauseUpdates = false;
    this.release();
  }

  override load() {
    this.loads++;
    return super.load();
  }

  override async saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean> {
    this.safetyWrites++;
    if (this.pauseUpdates) {
      this.notify();
      await this.resumed;
    }
    return super.saveSafety(height, revision, bytes);
  }
}

class ManualClock implements ProtocolClock {
  private nextId = 1;
  private time = 0;
  readonly scheduled = new Map<number, () => void>();
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    this.time += ms;
  }
  setTimeout(callback: () => void, _delayMs: number): unknown {
    const id = this.nextId++;
    this.scheduled.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.scheduled.delete(handle);
  }
  fireLatest(): void {
    const latest = [...this.scheduled].at(-1);
    if (!latest) throw new Error('No scheduled timeout');
    this.scheduled.delete(latest[0]);
    latest[1]();
  }
  fireFirst(): void {
    const first = this.scheduled.entries().next().value;
    if (!first) throw new Error('No scheduled timeout');
    this.scheduled.delete(first[0]);
    first[1]();
  }
  fire(handle: unknown): void {
    if (typeof handle !== 'number') throw new Error('Missing timer handle');
    const callback = this.scheduled.get(handle);
    if (!callback) throw new Error('Timer is not scheduled');
    this.scheduled.delete(handle);
    callback();
  }
}

class CapturingTransport implements Transport {
  readonly sent: ProtocolMessage[] = [];
  readonly disconnected: PeerId[] = [];
  private listener: ((from: PeerId, bytes: Uint8Array) => void) | null = null;
  constructor(
    readonly self: PeerId,
    private readonly connected: PeerId[] = [],
  ) {}
  peers(): PeerId[] {
    return [...this.connected];
  }
  send(_to: PeerId, bytes: Uint8Array): void {
    this.sent.push(value(decodeProtocolMessage(bytes)));
  }
  broadcast(bytes: Uint8Array): void {
    this.sent.push(value(decodeProtocolMessage(bytes)));
  }
  disconnect(peer: PeerId): void {
    this.disconnected.push(peer);
  }
  onMessage(listener: (from: PeerId, bytes: Uint8Array) => void): Unsubscribe {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  onPeerChange(_listener: (peer: PeerId, online: boolean) => void): Unsubscribe {
    return () => undefined;
  }
  inject(from: PeerId, message: unknown): void {
    this.listener?.(from, value(encodeProtocolMessage(message)));
  }
  injectBytes(from: PeerId, bytes: Uint8Array): void {
    this.listener?.(from, bytes);
  }
}

class FlakySubmitTransport extends CapturingTransport {
  failedSubmit = false;
  override broadcast(bytes: Uint8Array): void {
    if (!this.failedSubmit && value(decodeProtocolMessage(bytes)).t === 'SUBMIT') {
      this.failedSubmit = true;
      throw new Error('Temporary network send failure');
    }
    super.broadcast(bytes);
  }
}

class FailingRetransmitTransport extends CapturingTransport {
  submitBroadcasts = 0;
  override broadcast(bytes: Uint8Array): void {
    if (value(decodeProtocolMessage(bytes)).t === 'SUBMIT') {
      this.submitBroadcasts++;
      if (this.submitBroadcasts === 2) throw new Error('Temporary retransmit failure');
    }
    super.broadcast(bytes);
  }
}

function fourHumanFixture(): ReturnType<typeof protocolFixture> {
  const source = protocolFixture();
  const body = {
    ...source.body,
    seats: source.body.seats.map((seat) => ({
      seat: seat.seat,
      kind: 'human' as const,
      publicKey: seat.publicKey,
      name: seat.name,
      colour: seat.colour,
    })),
  };
  const genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: source.identities.map((identity, index) =>
      signGenesis(body, fixtureAt(source.body.seats, index).seat, identity.secretKey),
    ),
  };
  return {
    ...source,
    body,
    genesis,
    entry: signEntry(
      { ...source.entry, payload: { kind: 'genesis', genesis } },
      fixtureAt(source.identities, 0).secretKey,
    ),
  };
}


```

## Current packages/protocol/src/replicated-log.test.ts:2539

```text
  test('verified incremental contexts match durable replay at genesis and two certified deck passes', () => {
    const fixture = createVerifiedNetworkFixture({ seed: 42 });
    try {
      const options = fixture.sessionOptions(0);
      let context = value(
        replayCertifiedPrefix(fixture.entry, [], fixture.engine, options.policy),
      ).context;
      const entries: CertifiedEntry[] = [];
      const passes = options.deckSetupPasses?.slice(0, 2);
      if (!passes || passes.length !== 2)
        throw new Error('Missing representative public deck passes');
      for (let prefix = 0; prefix <= passes.length; prefix++) {
        const opened = value(
          openOwnedConsensusState(value(createConsensusState(context, 3)), context, 3),
        );
        const replayed = value(
          replayCertifiedPrefix(fixture.entry, entries, fixture.engine, options.policy),
        );
        expect(opened.matchesOpenedContext(replayed.context)).toBe(true);
        expect([...context.log.lastNonces]).toEqual([...replayed.context.log.lastNonces]);
        const pass = passes[prefix];
        if (!pass) break;
        const proposer = fixtureAt(
          [...fixture.identities.values()],
          proposerFor(context.log.head.seq + 1, 1, context.membership).seat,
        );
        const entry = signEntry(
          {
            seq: context.log.head.seq + 1,
            term: 1,
            prevHash: entryHash(context.log.head),
            payload: { kind: 'crypto', action: 'deck-pass', evidence: pass },
            stateHash: context.log.head.stateHash,
            sequencer: proposer.peerId,
          },
          proposer.secretKey,
        );
        const certified = {
          entry,
          certificate: ([0, 1, 2] as const).map((seat) =>
            signVote(
              {
                genesisDigest: context.membership.genesisDigest,
                epoch: 0,
                seat,
                seq: entry.seq,
                term: 1,
                phase: 'precommit',
                valueHash: entryHash(entry),
              },
              fixtureAt([...fixture.identities.values()], seat).secretKey,
            ),
          ),
        };
        context = value(advanceContext(context, value(validateCertifiedEntry(certified, context))));
        entries.push(certified);
      }
    } finally {
      fixture.dispose();
    }
  }, 30_000);

  test.each([
    'unchanged',
    'locked',
    'proposal',
    'pending',
    'swallowed',
    'bad-submit',
    'safety',
    'locked-safety',
    'engine',
  ] as const)(
    'repairs a corrupted derived context only with unchanged durable authority (%s)',
    async (mutation) => {
      const fixture = fourHumanFixture();
      const engine = { ...fixture.engine };
      const first = fixtureAt(fixture.identities, 0);
      const second = fixtureAt(fixture.identities, 1);
      const local = fixtureAt(fixture.identities, 3);
      const journal = new PausableJournal();
      const transport = new CapturingTransport(local.peerId);
      const clock = new ManualClock();
      const statuses: string[] = [];
      const replica = value(
        await ReplicatedLog.create({
          genesisEntry: fixture.entry,
          engine,
          policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
          seat: 3,
          secretKey: local.secretKey,
          transport,
          clock,
          journal,
          onStatus: (status) => statuses.push(status.kind === 'halted' ? status.code : status.kind),
        }),
      );
      const parent = replica.getContext();
      let safetyBefore = await journal.loadSafety(1);
      if (!safetyBefore) throw new Error('Missing initial durable safety record');

      const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
      const applied = value(fixture.engine.apply(parent.log.state, input));
      const entry = signEntry(
        {
          seq: 1,
          term: 1,
          prevHash: entryHash(parent.log.head),
          payload: { kind: 'system', input, evidence: stubEvidence(parent.log, input) },
          stateHash: toHex(hashValue(applied.state)),
          sequencer: first.peerId,
        },
        first.secretKey,
      );
      const certified = {
        entry,
        certificate: ([0, 1, 2] as const).map((seat) =>
          signVote(
            {
              genesisDigest: genesisDigest(fixture.genesis),
              epoch: 0,
              seat,
              seq: 1,
              term: 1,
              phase: 'precommit',
              valueHash: entryHash(entry),
            },
            fixtureAt(fixture.identities, seat).secretKey,
          ),
        ),
      };

      const proposal = signProposal(
        {
          genesisDigest: parent.membership.genesisDigest,
          epoch: 0,
          entry,
          validRound: null,
          prevotes: [],
        },
        first.secretKey,
      );
      const commandBody = {
        gameId: parent.log.genesis.gameId,
        genesisDigest: parent.membership.genesisDigest,
        seat: 0 as const,
        nonce: 1,
        headSeq: 0,
        headHash: entryHash(parent.log.head),
        command: { type: 'END_TURN' },
      };
      if (mutation === 'locked' || mutation === 'locked-safety') {
        transport.inject(first.peerId, {
          t: 'PROPOSAL',
          proposal,
        });
        await replica.flush();
        for (const seat of [0, 1] as const) {
          transport.inject(fixtureAt(fixture.identities, seat).peerId, {
            t: 'VOTE',
            vote: signVote(
              { ...fixtureAt(certified.certificate, seat).body, phase: 'prevote' },
              fixtureAt(fixture.identities, seat).secretKey,
            ),
          });
          // oxlint-disable-next-line no-await-in-loop -- Persist each authentic prevote before reaching the polka.
          await replica.flush();
        }
        const locked = value(replica['activeController']().snapshot());
        if (
          locked.locked?.hash !== entryHash(entry) ||
          !locked.votes.some((vote) => vote.body.seat === 3 && vote.body.phase === 'precommit')
        )
          throw new Error('Fixture did not persist a real local lock and precommit');
        safetyBefore = await journal.loadSafety(1);
        if (!safetyBefore) throw new Error('Missing locked safety');
      }
      let capturedRejectedProofs = 0;
      const capture = replica['captureRejectedProofs'];
      replica['captureRejectedProofs'] = async (from, bytes) => {
        capturedRejectedProofs++;
        return capture.call(replica, from, bytes);
      };
      const votesBefore = transport.sent.filter((message) => message.t === 'VOTE').length;
      if (mutation === 'pending') {
        journal.pauseUpdates = true;
        transport.inject(first.peerId, {
          t: 'PROPOSAL',
          proposal,
        });
        await journal.entered;
      }
      let derived: unknown = replica;
      for (const property of ['context', 'log', 'state', 'bank']) {
        if (typeof derived !== 'object' || derived === null)
          throw new Error(`Cannot corrupt derived state at ${property}`);
        derived = Reflect.get(derived, property);
      }
      if (typeof derived !== 'object' || derived === null)
        throw new Error('Missing derived bank state');
      const brick = Reflect.get(derived, 'brick');
      if (typeof brick !== 'number' || !Reflect.set(derived, 'brick', brick + 1))
        throw new Error('Could not corrupt derived bank state');

      if (mutation === 'pending') journal.releaseWrite();
      else if (mutation === 'swallowed') {
        const fault = replica['activeController']().snapshot();
        if (fault.ok || fault.error.code !== 'consensus-context')
          throw new Error('Swallowed snapshot did not detect the context fault');
        transport.inject(second.peerId, { t: 'VOTE', vote: fixtureAt(certified.certificate, 1) });
      } else if (mutation === 'bad-submit')
        transport.inject(first.peerId, {
          t: 'SUBMIT',
          cmd: signCommand(commandBody, second.secretKey),
        });
      else if (mutation === 'locked')
        transport.inject(second.peerId, { t: 'VOTE', vote: fixtureAt(certified.certificate, 1) });
      else if (mutation === 'proposal')
        transport.inject(first.peerId, {
          t: 'PROPOSAL',
          proposal,
        });
      else transport.inject(second.peerId, { t: 'COMMIT', certified });
      await replica.flush();
      if (mutation === 'pending') {
        safetyBefore = await journal.loadSafety(1);
        if (!safetyBefore || safetyBefore.revision !== 1)
          throw new Error('Pending write did not durably retain the signed prevote');
      }
      expect(statuses).toContain('consensus-context');
      expect(capturedRejectedProofs).toBe(mutation === 'bad-submit' ? 1 : 0);
      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
      expect(transport.sent).toContainEqual({
        t: 'SNAPSHOT_REQ',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: parent.log.head.seq,
      });
      expect((await journal.load())?.height).toBe(1);
      expect(await journal.loadSafety(1)).toEqual(safetyBefore);
      expect(replica.getContext().log.head.seq).toBe(0);

      const writesBeforeHoldTraffic = journal.safetyWrites;
      const tradeRequest = replica.requestTradeProof(
        signTradeProofRequest(
          {
            gameId: parent.log.genesis.gameId,
            genesisDigest: parent.membership.genesisDigest,
            seat: 3,
            nonce: 1,
            headSeq: 0,
            headHash: entryHash(parent.log.head),
            command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
          },
          local.secretKey,
        ),
      );
      expect(tradeRequest.ok ? null : tradeRequest.error.code).toBe('replica-repairing');
      expect(replica['pendingTradeProofs'].size).toBe(0);
      replica.cancelTradeProofRequest('absent');
      transport.inject(first.peerId, {
        t: 'SUBMIT',
        cmd: signCommand(commandBody, first.secretKey),
      });
      transport.inject(second.peerId, { t: 'VOTE', vote: fixtureAt(certified.certificate, 1) });
      transport.inject(second.peerId, {
        t: 'COMMIT',
        certified: {
          entry,
          certificate: certified.certificate.map((vote) => ({
            ...vote,
            sig: fixtureAt(certified.certificate, 0).sig,
          })),
        },
      });
      transport.inject(first.peerId, {
        t: 'SYS_CONTRIB',
        genesisDigest: parent.membership.genesisDigest,
        contribution: {
          kind: 'beacon-reveal',
          signed: {
            body: {
              operationId: entryHash(entry),
              seat: 0,
              index: 1,
              value: parent.membership.genesisDigest,
            },
            sig: fixtureAt(certified.certificate, 0).sig,
          },
        },
      });
      clock.advance(2_000);
      clock.fireFirst();
      await replica.flush();
      expect(journal.safetyWrites).toBe(writesBeforeHoldTraffic);
      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
      expect(transport.sent.filter((message) => message.t === 'CHEAT_CLAIM')).toHaveLength(0);
      expect(transport.sent.filter((message) => message.t === 'TRADE_PROOF_REQUEST')).toHaveLength(
        0,
      );
      expect(transport.disconnected).toHaveLength(0);

      transport.inject(second.peerId, {
        t: 'SNAPSHOT_RES',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: parent.log.head.seq,
        snapshot: { forged: true },
      });
      await replica.flush();
      expect((await journal.load())?.height).toBe(1);
      expect(await journal.loadSafety(1)).toEqual(safetyBefore);
      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
      const loadedAfterReplay = journal.loads;
      transport.inject(second.peerId, {
        t: 'SNAPSHOT_RES',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: 0,
        snapshot: { forged: 'distinct' },
      });
      await replica.flush();
      expect(journal.loads).toBe(loadedAfterReplay);

      if (mutation === 'safety') {
        if (!(await journal.saveSafety(1, safetyBefore.revision, safetyBefore.bytes)))
          throw new Error('Could not inject a competing durable safety revision');
      } else if (mutation === 'locked-safety') {
        const changed: unknown = canonicalDecode(safetyBefore.bytes);
        if (typeof changed !== 'object' || changed === null || !journal['record'])
          throw new Error('Missing durable safety fixture');
        Reflect.set(changed, 'locked', null);
        // Deliberately corrupt durable bytes without advancing its CAS revision.
        Reflect.set(journal['record'].safety, 'bytes', canonicalEncode(changed));
      } else if (mutation === 'engine') {
        const apply = engine.apply;
        engine.apply = (state, nextInput) => apply(state, nextInput);
      }

      transport.inject(second.peerId, {
        t: 'SNAPSHOT_RES',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: parent.log.head.seq,
        snapshot: snapshotFromContext(parent),
      });
      await replica.flush();
      // oxlint-disable vitest/no-conditional-expect -- Parameterized authority mutations intentionally have different terminal outcomes.
      if (mutation === 'safety' || mutation === 'locked-safety' || mutation === 'engine') {
        expect((await journal.load())?.height).toBe(1);
        expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
        expect(statuses).toContain(
          mutation === 'engine' ? 'replica-authority' : 'consensus-write-conflict',
        );
        replica.dispose();
        return;
      }
      // oxlint-enable vitest/no-conditional-expect
      if (
        mutation === 'locked' ||
        mutation === 'proposal' ||
        mutation === 'pending' ||
        mutation === 'swallowed' ||
        mutation === 'bad-submit'
      ) {
        if (JSON.stringify(await journal.loadSafety(1)) !== JSON.stringify(safetyBefore))
          throw new Error('Repair changed locked durable safety');
        if (mutation === 'pending') {
          const saved: unknown = canonicalDecode(safetyBefore.bytes);
          if (typeof saved !== 'object' || saved === null)
            throw new Error('Missing decoded pending safety');
          const durableVotes: unknown = Reflect.get(saved, 'votes');
          const emitted = transport.sent
            .filter((message) => message.t === 'VOTE')
            .map((message) => message.vote);
          if (
            !Array.isArray(durableVotes) ||
            durableVotes.length !== 1 ||
            toHex(canonicalEncode(emitted)) !== toHex(canonicalEncode(durableVotes))
          )
            throw new Error('Repair did not retransmit exactly the persisted local prevote');
        }
        transport.inject(second.peerId, { t: 'COMMIT', certified });
        await replica.flush();
      }
      expect((await journal.load())?.height).toBe(2);
      expect(replica.getContext().log.head).toEqual(entry);
      expect((await journal.load())?.entries).toEqual([certified]);
      const replayed = value(
        replayCertifiedPrefix(fixture.entry, [certified], engine, replica['options'].policy),
      );
      expect(replica['activeController']().opensOn(replayed.context)).toBe(true);
      replica.dispose();
    },
  );
});

```

## Current packages/protocol/src/consensus-controller.test.ts:26

```text
function errorCode(result: Result<unknown>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

function deferred() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release() {
      if (!release) throw new Error('Deferred promise was not initialized');
      release();
    },
  };
}

class PausableStore implements SafetyStore {
  readonly inner = new MemorySafetyStore();
  readonly entered = deferred();
  readonly resume = deferred();
  pauseUpdates = false;

  load() {
    return this.inner.load();
  }

  async save(expectedRevision: number | null, bytes: Uint8Array): Promise<boolean> {
    if (this.pauseUpdates && expectedRevision !== null) {
      this.entered.release();
      await this.resume.promise;
    }
    return this.inner.save(expectedRevision, bytes);
  }
}

function setup(store: SafetyStore = new MemorySafetyStore(), fourVoters = false) {
  const fixture = protocolFixture();
  const owner = fixtureAt(fixture.identities, 0);
  const roster: readonly (0 | 1 | 2 | 3)[] = fourVoters ? [0, 1, 2, 3] : [0, 1];
  const body = {
    ...fixture.body,
    seats: fixture.body.seats.map((seat) => ({
      seat: seat.seat,
      kind: 'human' as const,
      publicKey: seat.publicKey,
      name: seat.name,
      colour: seat.colour,
    })),
  };
  const genesis = fourVoters
    ? {
        ...body,
        gameId: genesisId(body),
        signatures: roster.map((seat) =>
          signGenesis(body, seat, fixtureAt(fixture.identities, seat).secretKey),
        ),
      }
    : fixture.genesis;
  const head = fourVoters
    ? signEntry(
        { ...entryBody(fixture.entry), payload: { kind: 'genesis', genesis } },
        owner.secretKey,
      )
    : fixture.entry;
  const log: LogContext = {
    genesis,
    engine: fixture.engine,
    head,
    state: fixture.state,
    crypto: null,
    lastNonces: new Map(),
  };
  const digest = genesisDigest(genesis);
  const context: ProposalContext = {
    log,
    membership: {
      genesisDigest: digest,
      epoch: 0,
      voters: roster.map((seat) => ({
        seat,
        publicKey: fixtureAt(fixture.identities, seat).peerId,
      })),
    },
    excludedProposers: [],
    policy: { allowStub: true },
  };
  const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
  const applied = fixture.engine.apply(fixture.state, input);
  if (!applied.ok) throw new Error(`Fixture input rejected: ${applied.error.code}`);
  const candidate = signEntry(
    {
      seq: 1,
      term: 1,
      prevHash: entryHash(log.head),
      payload: { kind: 'system', input, evidence: stubEvidence(log, input) },
      stateHash: toHex(hashValue(applied.value.state)),
      sequencer: owner.peerId,
    },
    owner.secretKey,
  );
  const emissions: ConsensusEffect[][] = [];
  const options: ConsensusControllerOptions = {
    context,
    seat: 0,
    secretKey: owner.secretKey,
    store,
    onEffects: (effects) => {
      emissions.push([...effects]);
    },
  };
  const certificateSeats: readonly (0 | 1 | 2 | 3)[] = fourVoters ? [1, 2, 3] : [0, 1];
  const certificate = certificateSeats.map((seat) =>
    signVote(
      {
        genesisDigest: digest,
        epoch: 0,
        seat,
        seq: 1,
        term: 1,
        phase: 'precommit',
        valueHash: entryHash(candidate),
      },
      fixtureAt(fixture.identities, seat).secretKey,
    ),
  );
  return { options, store, candidate, certificate, emissions };
}

async function create(options: ConsensusControllerOptions): Promise<ConsensusController> {
  const result = await ConsensusController.create(options);
  if (!result.ok) throw new Error(`Controller create failed: ${result.error.code}`);
  return result.value;
}

async function restore(options: ConsensusControllerOptions): Promise<ConsensusController> {
  const result = await ConsensusController.restore(options);
  if (!result.ok) throw new Error(`Controller restore failed: ${result.error.code}`);
  return result.value;
}


```

## Current focused controller tests: test('a locked value

```text
  test('a locked value can be declined in a later round without losing the round transition', async () => {
    const { options, candidate } = setup(new MemorySafetyStore(), true);
    let approved = true;
    const controller = await create({
      ...options,
      admitLocalValue: () => approved,
      beforePersist(previous, next) {
        return !approved &&
          next.votes.slice(previous.votes.length).some((vote) => vote.body.valueHash !== null)
          ? { ok: false, error: { code: 'unexpected-positive-vote', message: 'Approval was lost' } }
          : { ok: true, value: undefined };
      },
    });
    try {
      expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
      const first = controller.snapshot();
      if (!first.ok) throw new Error(first.error.code);
      const originalPrevote = first.value.votes.find((vote) => vote.body.phase === 'prevote');
      if (!originalPrevote) throw new Error('Missing first-round prevote');
      const digest = options.context.membership.genesisDigest;
      const vote = (seat: 1 | 2, phase: 'prevote' | 'precommit', hash: string | null) =>
        signVote(
          {
            genesisDigest: digest,
            epoch: 0,
            seat,
            seq: 1,
            term: 1,
            phase,
            valueHash: hash,
          },
          fixtureAt(protocolFixture().identities, seat).secretKey,
        );
      expect(
        (
          await controller.dispatch({
            kind: 'vote',
            vote: vote(1, 'prevote', entryHash(candidate)),
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await controller.dispatch({
            kind: 'vote',
            vote: vote(2, 'prevote', entryHash(candidate)),
          })
        ).ok,
      ).toBe(true);
      const locked = controller.snapshot();
      expect(locked.ok && locked.value.locked?.hash).toBe(entryHash(candidate));
      const durableLock = await options.store.load();
      const exact = await restore({ ...options, requireExactRestore: true });
      expect(exact.snapshot()).toEqual(locked);
      expect(await options.store.load()).toEqual(durableLock);
      expect((await exact.resume()).ok).toBe(true);
      expect(await options.store.load()).toEqual(durableLock);
      exact.dispose();
      expect(
        (await controller.dispatch({ kind: 'vote', vote: vote(1, 'precommit', null) })).ok,
      ).toBe(true);
      expect(
        (await controller.dispatch({ kind: 'vote', vote: vote(2, 'precommit', null) })).ok,
      ).toBe(true);
      approved = false;
      expect(
        (await controller.dispatch({ kind: 'timeout', phase: 'precommit', round: 1 })).ok,
      ).toBe(true);
      const nextProposer = proposerFor(1, 2, options.context.membership);
      const proposerKey = fixtureAt(protocolFixture().identities, nextProposer.seat).secretKey;
      const nextEntry = signEntry(
        { ...entryBody(candidate), term: 2, sequencer: nextProposer.publicKey },
        proposerKey,
      );
      const proof = [
        originalPrevote,
        vote(1, 'prevote', entryHash(candidate)),
        vote(2, 'prevote', entryHash(candidate)),
      ];
      const nextProposal = signProposal(
        { genesisDigest: digest, epoch: 0, entry: nextEntry, validRound: 1, prevotes: proof },
        proposerKey,
      );
      expect((await controller.dispatch({ kind: 'proposal', proposal: nextProposal })).ok).toBe(
        true,
      );
      const resumed = controller.snapshot();
      expect(resumed.ok && resumed.value.round).toBe(2);
      expect(
        resumed.ok &&
          resumed.value.votes.find((item) => item.body.term === 2 && item.body.phase === 'prevote')
            ?.body.valueHash,
      ).toBeNull();
    } finally {
      controller.dispose();
    }
  });

  test('a locally refused value persists a nil vote and can advance its round', async () => {
    const { options, candidate, store } = setup();
    const controller = await create({
      ...options,
      admitLocalValue: () => false,
      beforePersist(_previous, next) {
        return next.votes.some((vote) => vote.body.seat === 0 && vote.body.valueHash !== null)
          ? {
              ok: false,
              error: { code: 'unexpected-positive-vote', message: 'Value was not admitted' },
            }
          : { ok: true, value: undefined };
      },
    });
    expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
    const first = controller.snapshot();
    expect(
      first.ok && first.value.votes.find((vote) => vote.body.phase === 'prevote')?.body.valueHash,
    ).toBeNull();
    expect((await store.load())?.revision).toBe(1);
    controller.dispose();
    const resumed = await restore({ ...options, admitLocalValue: () => false });
    const snapshot = resumed.snapshot();
    expect(
      snapshot.ok &&
        snapshot.value.votes.find((vote) => vote.body.phase === 'prevote')?.body.valueHash,
    ).toBeNull();
    resumed.dispose();
  });


```

## Current focused controller tests: test('does not emit when the certified context changes

```text
  test('does not emit when the certified context changes during persistence', async () => {
    const store = new PausableStore();
    const { options, candidate, emissions } = setup(store);
    const controller = await create(options);
    const opened = {
      ...options.context,
      excludedProposers: [...options.context.excludedProposers],
    };
    store.pauseUpdates = true;
    const pending = controller.dispatch({ kind: 'propose', candidate });
    await store.entered.promise;
    let settled = false;
    const settlement = controller.settled().then(() => {
      settled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    options.context.excludedProposers = [1];
    store.resume.release();
    expect(errorCode(await pending)).toBe('consensus-context');
    await settlement;
    expect(settled).toBe(true);
    const saved = await store.load();
    if (!saved) throw new Error('Missing persisted vote after interrupted write');
    expect(saved.revision).toBe(1);
    expect(controller.matchesPersistedRecord(saved)).toBe(true);
    expect(controller.opensOn(opened)).toBe(true);
    expect(controller.opensOn(options.context)).toBe(false);
    expect(emissions).toHaveLength(0);
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );
    const recoveredEffects: ConsensusEffect[][] = [];
    const repaired = await restore({
      ...options,
      context: opened,
      requireExactRestore: true,
      onEffects: (effects) => {
        recoveredEffects.push([...effects]);
      },
    });
    expect(await store.load()).toEqual(saved);
    expect((await repaired.resume()).ok).toBe(true);
    expect(recoveredEffects.flat().map((effect) => effect.kind)).toContain('broadcast-vote');
    expect(await store.load()).toEqual(saved);
    repaired.dispose();
  });


```

## Current focused controller tests: test('corrupt local derivation

```text
  test('corrupt local derivation stops an active controller until certified-prefix replay', async () => {
    const { options, candidate, store, emissions } = setup();
    const controller = await create(options);
    expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
    const saved = await store.load();
    const freshContext: ProposalContext = {
      ...options.context,
      log: { ...options.context.log },
    };
    const corruptContext: ProposalContext = {
      ...freshContext,
      log: {
        ...freshContext.log,
        state: {
          ...freshContext.log.state,
          counters: {
            ...freshContext.log.state.counters,
            nextOfferId: freshContext.log.state.counters.nextOfferId + 1,
          },
        },
      },
    };
    // The same persisted proposal can no longer be derived from corrupted local state.
    options.context.log.state = corruptContext.log.state;
    expect(errorCode(controller.snapshot())).toBe('consensus-context');
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );
    expect((await store.load())?.bytes).toEqual(saved?.bytes);
    expect((await store.load())?.revision).toBe(saved?.revision);
    expect(emissions.flat().filter((effect) => effect.kind === 'broadcast-vote')).toHaveLength(1);

    const dispatchContext: ProposalContext = {
      ...freshContext,
      log: { ...freshContext.log },
    };
    const dispatchController = await restore({ ...options, context: dispatchContext });
    dispatchContext.log.state = corruptContext.log.state;
    expect(errorCode(await dispatchController.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-context',
    );
    expect(errorCode(await dispatchController.resume())).toBe('consensus-stopped');

    const resumeContext: ProposalContext = {
      ...freshContext,
      log: { ...freshContext.log },
    };
    const resumeController = await restore({ ...options, context: resumeContext });
    resumeContext.log.state = corruptContext.log.state;
    expect(errorCode(await resumeController.resume())).toBe('consensus-context');
    expect(errorCode(await resumeController.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );

    // A fresh controller can only continue after the certified parent is reconstructed.
    const retransmitted: ConsensusEffect[] = [];
    const replayed = await restore({
      ...options,
      context: freshContext,
      onEffects: (effects) => {
        retransmitted.push(...effects);
      },
    });
    expect((await replayed.resume()).ok).toBe(true);
    expect(retransmitted.some((effect) => effect.kind === 'broadcast-proposal')).toBe(true);
    expect(retransmitted.some((effect) => effect.kind === 'broadcast-vote')).toBe(true);
  });

  test('a persisted commit replays after a delivery crash at the commit boundary', async () => {
    const { options, candidate, certificate, store } = setup(new MemorySafetyStore(), true);
    const controller = await create({
      ...options,
      onEffects: (effects) => {
        if (effects.some((effect) => effect.kind === 'commit'))
          throw new Error('crashed after saving the certificate');
      },
    });
    expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
    const certified = { entry: candidate, certificate };
    expect(errorCode(await controller.dispatch({ kind: 'commit', certified }))).toBe(
      'consensus-effects',
    );
    expect((await store.load())?.revision).toBe(2);
    const replayed: ConsensusEffect[] = [];
    const restarted = await restore({
      ...options,
      onEffects: (effects) => {
        replayed.push(...effects);
      },
    });
    expect((await restarted.resume()).ok).toBe(true);
    expect(replayed.filter((effect) => effect.kind === 'commit')).toHaveLength(1);
  });
});

```

## Current tools/sim/src/net.ts:581

```text
          if (options.scenario === 8 && seat === 0 && !faultRecovered) {
            const decoded = unwrap(decodeProtocolMessage(bytes));
            const session = sessions.get(seat);
            const head = session?.getCommittedHead();
            const vote = decoded.t === 'VOTE' ? decoded.vote.body : null;
            if (
              !faultInjected &&
              corruptedHeight === null &&
              session &&
              head &&
              head.seq >= 20 &&
              head.seq % keys.length !== 0 &&
              vote?.seq === head.seq + 1 &&
              vote.phase === 'precommit' &&
              vote.valueHash !== null
            ) {
              corruptedHeight = vote.seq;
              faultRevision = head.seq;
              corruptDerivedBank(session);
              faultInjected = true;
            }
            if (
              decoded.t === 'SNAPSHOT_RES' &&
              from !== game.identities.get(0)?.peerId &&
              desyncObserved &&
              corruptedHeight !== null &&
              decoded.atSeq === corruptedHeight - 1 &&
              snapshotRequestAtSeqs.has(corruptedHeight - 1)
            ) {
              snapshotResponsePairs.add(`${from}:${decoded.atSeq}`);
              repairSnapshotParentSeq ??= decoded.atSeq;
              repairSnapshotHash ??= toHex(hashValue(decoded.snapshot));
            }
          }

```

## docs/06-protocol-event-log.md:127-139

```text
## 6. Commitment and repair

- A matching quorum of signed non-nil precommits certifies a validated value. Persist the certificate and resulting state before announcing commitment. Keep the committed prefix permanently.
- Publish engine effects, private updates and successful submission results only after commitment. Board selection previews remain local. A round change never rolls back committed state.
- Persist votes, locks, current round, justified values and committed certificates in an injected safety store. The Stage 06 memory store survives protocol-instance crashes; Stage 10 supplies IndexedDB. Tests cover crashes immediately before and after writes.
- A peer that loses its safety store cannot simply rejoin under the same key and vote. It must recover a provably safe state or undergo the agreed identity-replacement procedure.
- The injected raw-key API has a caller precondition: `create` is only the first activation of a fresh game key; subsequent openings use `restore`, which refuses missing records. A caller that copies the raw key into a replacement empty journal can violate that precondition. Stage 10 must own key creation/loading together with durable safety storage and forbid that fallback. The simulation's deterministic keys are test fixtures, not device identities for production.
- **Desync**: retain a diagnostic, replay the certified prefix and verify full protocol metadata. Repair preserves prior vote/lock records. Stop voting if replay cannot establish valid state; do not trust an unverified snapshot from a claimed majority.

## 7. Snapshots & sync

- Every peer keeps the full log in memory (and in IndexedDB later). Logs are small: a base game is ~1–3k entries.
- `SYNC_REQ` returns up to 200 certified entries per batch, staying within the byte limit. Snapshots contain engine state, nonces, membership/exclusions and crypto metadata. Verify the certified chain and replay-derived metadata before using them for voting. The engine state hash alone cannot authenticate nonce or voter metadata.
```

## docs/verification/p2p-acceptance-policy.md:1-30

```text
# Bounded M-C and M-D acceptance

The user authorized reducing redundant game counts. Stages 07 and 10 use the
following deterministic coverage requirements instead of hundreds of repetitions
of each scenario. This changes sample counts, not the required failure cases,
security guarantees, performance targets or browser coverage. No unchecked gate
becomes complete through this policy change.

## Stage 07

Run one reproducible game for each of the nine Stage 06 scenarios with the real
cryptographic participants and verified genesis. The existing stub-randomness
simulation remains useful separate coverage; it cannot satisfy these checks.

| Scenario                        | Required observation                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean four-peer network         | Complete play and independent final audits with matching certified histories.                                                                                               |
| Delayed and duplicated messages | Actually deliver duplicates and 50–400 ms latency; certify the same history and finish.                                                                                     |
| Sequencer crash and restart     | Crash mid-turn, keep durable safety records, return after 20 seconds, and finish without conflicting votes.                                                                 |
| Two-against-two partition       | Neither partition commits during the 30-second split. Heal and finish from the same prefix.                                                                                 |
| Three-against-one partition     | The quorum commits when required inputs are available. A missing private input must wait. Heal, catch up and finish.                                                        |
| Invalid proposer                | Reject the signed invalid command, certify the attributable finding and proposer exclusion, then finish with three honest voters and legal commands from the excluded seat. |
| Censoring proposer              | Observe an actually censored command, replace the proposer and commit that command, then finish.                                                                            |
| Corrupted local state           | Exercise verified repair from certified history and finish without rolling back any committed entry.                                                                        |
| Two simultaneous restarts       | Restore both peers from durable records, fetch missing certified entries, and finish on the same history.                                                                   |

Record protocol version, source revision, seed, actual injected fault, certified
head and relevant safety assertions. The faulty client in the invalid-proposer
case is not required to maintain an honest history. Expected misconduct findings
in that case are distinct from false findings in honest games.
```
