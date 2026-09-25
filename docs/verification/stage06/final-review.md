I've finished the static read-through and am writing up the findings now. I read the design doc and the core adapter, consensus, controller, replay, proposal, control and message files. I did not read the test files closely, and I ran nothing, so none of these traces has been reproduced.

## Blocking: an old accusation replayed after exclusion stalls the game and stops the node from restoring

This is a fully specified trace from reading the code, not a reproduction.

**Preconditions:** Seat A's exclusion has already been certified at an earlier height. So `excludedProposers = [A]`, `provenOffender = A`, and `pendingAccusation` was cleared at `replicated-log.ts:892-893`.

**Trigger** (either of these works):

- A sends an `ACCUSE` carrying its own old proof. A is still a voter, so the signature check at `replicated-log.ts:481` passes.
- A signs two conflicting votes at any later height. `recordVote` then emits an `equivocation` effect (`consensus.ts:369-370`), which calls `rememberAccusation`. Line 741-742 swaps the new evidence for the retained `provenOffender.control`.

A delayed honest `ACCUSE` rebroadcast (line 938-939) that arrives after the exclusion commits has the same effect.

**What happens:**

1. `rememberAccusation` checks the proof at line 755. Because `atSeq < height`, it is checked against the historical parent context (`replay.ts:85-90`), where A was not yet excluded. The proof passes.
2. `stage-accusation` runs at line 757. `haltForControlFault` (`consensus.ts:442-445`) doesn't halt, because the only excluded seat is A itself. Nothing is pending, so `stageAccusation` persists `pendingAccusation = <already-committed control>` (`consensus.ts:1045-1051`).
3. Only then does line 773 reject with `control-fault-limit`. The persisted record is not rolled back.
4. At the next commit, `persistCommit` carries the pending accusation forward (lines 892-893) and sets `this.accusation` (line 922). From then on `candidate()` prefers that accusation (lines 671-682).
5. `propose()` fails in `validateControlForProposal` (`proposal.ts:70-75`, because `excludedProposers.length >= 1`). The error isn't fatal, so this node never proposes a command again.

**Consequences:**

- Every honest node that processed the message ends up in this state. A cannot propose, so the game makes no progress at all. That breaks liveness within the fault model.
- On restart, `recoverPersistedAccusation` (lines 808-809) calls `rememberAccusation`, which returns `control-fault-limit`. `ReplicatedLog.restore` then disposes (lines 174-176), so `P2PSession.restore` fails every time.

**Fix direction:** Reject an offender who is already certified excluded before `stage-accusation`, either in the adapter or in `stageAccusation`. Also make restore tolerate a stale pending accusation that is already committed.

## Other defects (non-blocking or outside the fault model)

- **Item 3 after a restart, crash-timing gap.** An equivocation is recorded durably, but `rememberAccusation` only runs later as a separately queued task (line 848). If the process crashes before that task runs, `recoverPersistedAccusation` looks only at `pendingAccusation` (lines 808-809), or returns early if a decision exists (line 807).
  - `restoreConsensusState` never compares `equivocations` against `provenOffender` (`consensus.ts:956-968`).
  - `haltIfFaultThresholdExceeded` counts only equivocators, not a first proof from an invalid command or an earlier height.
  - Trace: pending accusation against A from an invalid command, then B equivocates, then a crash. On restore, B is never staged and there's no halt. If a decision was pending, B's evidence is dropped when `createConsensusState` starts the next height.
- **Items 2 and 3 through a proposal.** A proposal whose control payload carries valid objective evidence against the local seat, or against a second offender B, while A is already excluded, fails at `validateControlForProposal` before `haltForEntryControlFault` runs (`proposal.ts:68-75`, `consensus.ts:1155`). The adapter just returns the error (`replicated-log.ts:453`), so there's no terminal halt. Only a faulty proposer can send this, so it's beyond one Byzantine human, but it doesn't meet the rule as you stated it. Through `COMMIT`, the same case halts as a repairable `certified-validation` halt whose repair always fails. That is halted, but under the wrong kind.
- **Item 6 ordering.**
  - A `PROPOSAL` carrying a historical control spends the replay budget before any signature check (lines 439-447).
  - An old `COMMIT` spends it before `precheckCertifiedEnvelope` (lines 547-555).
  - The budget is per sender, so one peer can't drain another's.
  - Unverified risk: the budget is shared across sync, snapshot, accusation and proposal requests. A proposer that is catching up (three `SYNC_REQ`s in the window) can have its legitimate historical-control proposal silently dropped for that round.

## Paths that hold up on static review

1. **Restore replay:** `P2PSession.restore` replays through `replayCertifiedPrefix` with an ordered `applyCommit` callback (`p2p-session.ts:129-135`). Control entries skip the driver, and a driver failure fails the open.
2. **Local-seat evidence:** `ACCUSE`, `COMMIT`, repair and restore all terminal-halt, apart from the proposal gap above. Unrecorded-own-signature halts use only authenticated votes and proposals.
3. **Two offenders:** covered by the `excludedProposers` and `provenOffender` checks in `haltForControlFault`, and at height transitions (`createConsensusState`). The gaps are the crash window and the proposal path above.
4. **Submission outcomes:** `acceptedHash` separates a pre-admission rejection from an accepted command. A failed send leaves the command pending, and disposal returns `replica-outcome-unknown`.
   - Unverified risk: a failed `requireSend` during a pulse throws, which disposes the whole replica. That is a harsh response to a transient transport error.
5. **Historical cache:** holds 16 entries, evicting the oldest. It shares the `entries` array with the replica, so live commits are visible to it. The old-`COMMIT` and accusation paths still do full replays, but they are rate-limited.
6. **Authentication order:** `ACCUSE` is authenticated before the budget is spent. `PROPOSAL` and old `COMMIT` are not (see above).
7. **Conflicting old certificate:** a conflicting, authenticated old-height certificate terminal-halts whether its value validates or not (lines 564-573).
8. **Sync:** hints and responses are bounded (200 entries, one hint per voter), and a continued response must make certified progress. The limit is about three batches per 10 s per responder, which slows catch-up but doesn't starve it permanently.
9. **Restore ordering:** proof recovery runs inside the queued operation before `attachTransport` (lines 166-173).
10. **Retransmission order:** `recoverConsensusEffects` sends the newest round first (`consensus.ts:1383`).

This review doesn't establish acceptance. Before retesting, I'd add a regression test for the stale-accusation trace: an excluded seat re-gossips its own proof or equivocates a vote, followed by one commit and then a restore.
