I found one high-severity defect and two medium-severity safety-detection gaps. I found no violation of agreement itself under the one-Byzantine-human model. This was a static read of the listed files only; I ran nothing. I read `consensus-adversarial.test.ts` only through line 400 and did not open `consensus-controller.test.ts` or `types.ts`, so where I say a case is untested, that applies only to the tests I read.

## Findings, ranked

### 1. High: `P2PSession.restore` can't replay a historical exclusion, so the game can never be resumed

- **Where:** `p2p-session.ts:124-151` replays the journal with its own context from `initialProposalContext`. That context has no `verifyHistoricalAccusation`. `proposal.ts:41-45` then returns `control-history` for any control entry whose evidence height is below its own.
- **Trace:** Four humans. At height 5 the local peer stages an accusation against seat 0. A gameplay entry commits at 5 first. The exclusion then commits at 6 with evidence from height 5. The live peers handle this correctly. Any later `P2PSession.restore` (a crash, scenario 3/9, or an app reload) fails at entry 6. That happens on every attempt, even though the journal is intact.
- **Why tests miss it:** `replicated-log.test.ts:779-945` tests this path only through `ReplicatedLog.restore`. The network simulation (`net.ts`) never restores a peer after a control entry.
- **Fix:** Build the session context with `replayCertifiedPrefix` (`replay.ts`) instead of a separate loop.

### 2. Medium: the local key's signatures inside accusation evidence and control entries don't stop signing

- **Where:**
  - `hasUnrecordedOwnVote` (`consensus.ts:220-235`) only checks votes at the current height.
  - `stageAccusation` (`consensus.ts:955-976`) uses that check.
  - `receiveProposal` (`consensus.ts:1092`) checks only the proposal's prevote justification.
  - `receiveCommit` (`consensus.ts:1201-1212`) and `maybeCommit` don't look inside the control payload at all.
  - `restoreConsensusState` (`consensus.ts:887-903`) doesn't check `pendingAccusation`, `provenOffender` or embedded evidence.
- **Trace A:** A cloned copy of seat L's key signs a conflicting prevote for an old height 3. Votes don't bind a parent, so this can be done at any time. A peer sends an ACCUSE naming L at height 10. `stageAccusation` finds nothing at seq 10, so it records L as its own proven offender and gossips the ACCUSE. L keeps voting.
- **Trace B:** The same evidence reaches L as a control proposal or COMMIT instead of an ACCUSE. L prevotes and commits its own exclusion without halting.
  - This path is realistic because congestion drops ACCUSE silently (`replicated-log.ts:353-361`) and the pulse never retransmits it.
- **Fix:** Any validated objective evidence naming the local seat is proof of a duplicate key or corrupt local state. It should cause a terminal halt in every one of these paths.

### 3. Medium: a locally proven offender is silently dropped when a different offender's exclusion is certified

- **Where:** `validateControlForProposal` (`proposal.ts:64-77`) ignores the local `provenOffender`. `persistCommit` (`replicated-log.ts:877-892`) keeps `provenOffender = X`, clears the pending accusation and adds Y to the exclusions. Restore (`consensus.ts:861-876`) never compares the two.
- **Trace:** L holds proof against seat 0. A proposal excluding seat 1 arrives. L prevotes it, it commits, and L carries on at the next height with objective proof of two distinct offenders. The design says this must halt.
- **Current coverage:** Only the reverse order (the certified exclusion comes first, the new proof second) halts, at `consensus.ts:977-983`.

### 4. Medium-low: an accepted submission is reported as `replica-disposed` after a transport failure

- **Where:** Any send failure in effects or in the pulse retransmit throws (`replicated-log.ts:1139-1141`, and `:1010-1011` for the SUBMIT retransmit). That disposes the replica (`:326-329`), and `dispose` resolves every pending command with `replica-disposed`, "closed before commitment" (`:294-299`).
- **Trace:** SUBMIT is sent successfully. One flaky SUBMIT retransmit then fails during a pulse, or the local proposal broadcast fails. The UI receives a failure, but peers already hold the signed command and may commit it.
- **Why tests miss it:**
  - `FlakySubmitTransport` (`replicated-log.test.ts:88-97`) only fails the first send, which is handled correctly.
  - `net.ts:598` treats `replica-disposed` as harmless, which hides the problem.
- **Fix:** Nonces prevent the command being applied twice, but the result should be a distinct "outcome unknown" code.

### 5. Medium-low: CPU amplification from revalidating everything on every transition

- **Where:** Every transition and every `snapshot()` call reruns `restoreConsensusState` (`consensus.ts:585`, `consensus-controller.ts:121`). That revalidates every stored proposal, hint and pending accusation. The historical-parent cache holds one entry and is cleared on a miss (`replay.ts:62-75`).
- **Trace:** Byzantine seat B forges self-equivocation for heights a and b. It sends ACCUSE(@a), so the local peer's pending accusation is at a. It also sends a future-round proposal hint whose control evidence is at b. From then on, every vote or timeout causes two full-history replays, several times per operation.
- **Limit:** The attack incriminates B, so it ends once B's exclusion commits. But it can slow the whole height badly.
- **Fix:** Memoize validated proposals by hash and parent, or use a small multi-entry cache.

### 6. Low: ACCUSE replays the full history before any signature check

- **Where:** `replicated-log.ts:739-749`.
- **Impact:** Junk accusations with distinct hashes buy up to three full replays per 10 s per peer, a budget shared with the other expensive requests (`:405-420`).
- **Fix:** Check the evidence signatures cheaply against the current membership first.

### 7. Low: an authenticated conflicting historical certificate that fails validation doesn't halt

- **Where:** `replicated-log.ts:557-559` returns the validation error.
- **Impact:** A quorum for a different value at an already-committed height already shows the fault threshold was exceeded. The design requires a halt in that case.

### 8. Low: sync traffic without certified progress

- **Where:** A signed heartbeat with an inflated head triggers a broadcast SYNC_REQ with no budget (`replicated-log.ts:1032-1033`). Serving SYNC_REQ is also unbudgeted (`:488`, `:1070-1092`).
- **Impact:** The SYNC_RES progress check is correct, but a heartbeat alone can keep requesting sync with nothing to sync.

### 9. Low: restore runs recovery outside the serialized queue

- **Where:** `replicated-log.ts:164-175` attaches the transport before `recoverPersistedAccusation` and `resume()`, which run outside `enqueue`.
- **Impact:** With a store that resolves on macrotasks (as IndexedDB will in Stage 10), a COMMIT can dispose the controller mid-recovery. Restore then fails with `consensus-stopped`.
- **Fix:** Run recovery inside `enqueue` before attaching the transport.

### Unverified risk

After a restart, retransmission sends a peer's signed messages oldest first (`consensus.ts:1298-1304`). Incoming messages beyond 8 queued per peer are dropped without a strike. If a transport delivers a whole burst before the queue drains, the newest-round votes would be the ones dropped at every pulse. I couldn't confirm the delivery timing from the approved files.

## Sound paths

- **Quorum and exclusion:**
  - Quorum sizes are 1,2,3,3,4,4.
  - Excluding a proposer only filters proposer eligibility.
  - A single human cannot be excluded.
  - Two distinct voters are required for a round jump.
  - A 2|2 split and two-/three-human games stall rather than commit.
- **Durable accusations:** The proof is persisted before ACCUSE is gossiped. It is carried across a gameplay commit and revalidated on restore against the replayed parent hash and its membership and proposer context, never against payload state. Live historical checks work because `replay.ts`'s `certified` array is the same object as `this.entries` (`replay.ts:99` → `replicated-log.ts:158, 232, 912`). That works, but it is fragile.
- **Second offender:** The halt is durable when the first offender is proven or excluded and the second then arrives as an accusation, including across a restart.
- **Growth bounds:** Two proposals per round and one future-round hint per seat, both enforced on restore.
- **Strikes:** Congestion no longer strikes a peer. Strikes apply only to envelope and `-signature` failures, and I found no path where an honest peer produces those.
- **Replay budgets:**
  - Old or future certificates get a signature check before any replay.
  - A repeat of an already-committed value short-circuits.
  - A continued SYNC_RES must advance the certified head.
- **Local-signature checks:** These cover proposal justifications, commit certificates and entries, direct votes, current-height accusations, and stored proofs on restore. The exceptions are in finding 2.
- **Submission failures:** A SUBMIT send failure after acceptance now leaves the command pending.
- **Controller:** It persists before emitting, uses compare-and-swap, stops on write failure, refuses to create over an existing store, and refuses to restore from a missing one.
- **Repair:** Repair after a certified-validation halt replays the journal and keeps votes and locks. Terminal halts can't be cleared.

I treated the raw-key API, the stub evidence and the memory journal as the stated scope, and I didn't count later-stage work against the code. All the findings above fall inside that scope.
