# F1/F2 ledger guard review

Scope: the F1 (rejected-proposal cache and strikes) and F2 (exception containment) corrections only. I kept this read-only as the prompt asks. `control.ts` wasn't in the supplied set, so finding 3 is a verification gap rather than a confirmed defect.

## Finding 1: Cached rejections strike again on every exact retransmission, which can disconnect an honest peer after a local fault

**Severity: medium (liveness; can block repair).**

The strike condition treats `proposalEntryRejected` as proof that the peer misbehaved. A cache hit returns that marker again, so every repeat of the same bytes costs the sender another strike.

**Trace:**

1. Honest proposer B sends proposal P for height _h_, round _r_.
2. The local replica has a local fault, such as the engine failure in the `repair` test, a corrupted local `context.log.state`, or a transient exception that `validateNextEntry` turns into `entry-verification-failed`.
3. `validateEntry` fails. `validateProposal` adds the marker, the controller caches the key, and the adapter strikes B once (`replicated-log.ts`, the `PROPOSAL` case).
4. B's `pulse()` runs every 2 s. It calls `resume()`, which goes through `recoverConsensusEffects` and rebroadcasts B's own P with identical bytes.
5. `dispatch` hits the cache and returns the failure with `proposalEntryRejected: true` again. The same parent still matches, so B is struck again.
6. After 5 pulses (about 10 s) `rejectPeer(B)` runs. `blockedPeers` is permanent for this `ReplicatedLog`.
7. With two voters, the only peer is now blocked:
   - The `COMMIT` that would trigger the `certified-validation` halt never arrives.
   - The `SNAPSHOT_RES` that `repair` needs also never arrives.
   - A recoverable local desync becomes self-inflicted isolation.

The same thing happens when an honest relayer sends P in reply to our own `PROPOSAL_REQ` (`sendRequestedProposal`).

`validateNextEntry`'s docstring says a rejection alone must be distinguished from local desync. The accusation path respects that, but the strike path does not.

The same pattern is in the F2 SUBMIT path. A rejected SUBMIT is not remembered, and the submitter rebroadcasts pending commands every pulse. A local validator or reducer exception on a command that was honestly admitted at the same parent therefore strikes the submitter on each pulse. The test comment ("thrown validators used … strikes") encodes this behaviour.

**Minimal fix:** strike only on the first failure of a distinct value, never on exact replays.

- **Controller:** on a cache hit, return `{ proposalEntryRejected: true, cached: true }`.
- **Adapter:** still wrap the error code, so a cached `sequencer-signature` cannot trigger a suffix strike, but call `strikePeer` only when `cached !== true`.
- **SUBMIT:** add a bounded set of rejected command hashes (for example 16 entries) for the current parent, and clear it in `persistCommit`. A hit returns `success` with no strike and no re-validation.

This keeps the fresh-variant bound (5 distinct invalid proposals or commands lead to a disconnect), and exact replays stay cheap because of the caches. A local fault can then only disconnect B after 5 distinct proposals from B at one parent. That takes many backed-off rounds, and in that time a commit normally arrives and triggers the certified-validation halt and repair path.

**Test impact:**

- "bounds fresh invalid proposal variants…" still passes.
- "rejects bad command proofs…" currently needs 8 identical `invalidProof` SUBMITs to reach the disconnect. It must switch to distinct invalid variants, for example different evidence payloads.
- Add a test: an honest proposal is rejected because of an injected local engine fault, then retransmitted more than 5 times, and the peer is not disconnected.

## Finding 2: A cache hit skips the state-dependent control-fault halt in `receiveProposal`

**Severity: low (fault detection depends on arrival order).**

The cache comment says entry validation depends only on the fixed parent. That is true, but the failure branch of `receiveProposal` also runs `authenticateProposalControlEvidence` followed by `haltForControlFault`. Their result depends on `state.provenOffender`, which can change during the height.

**Trace (4 voters, no exclusions):**

1. The elected proposer sends a control proposal P. Its evidence objectively proves that B is a Byzantine voter, but its entry has the wrong `stateHash`, so it fails with `control-state` from `validateEntry`.
2. First receipt:
   - Authentication passes.
   - `provenOffender` is null and there are no exclusions, so there is no halt.
   - The failure is returned and cached.
   - The evidence against B is not retained.
3. Later in the same height, this replica stages proof against A, so `provenOffender.offender` becomes A.
4. P is retransmitted and hits the cache, so there is no halt. Without the cache, `haltForControlFault` would terminal-halt with "second Byzantine voter".

**Minimal fix:** do not cache rejections whose entry payload is `control`. Finding 1's per-sender strikes already bound fresh variants, and exact control replays are rare. Alternatively, on a cache hit for a control payload, fall through to `reduce`.

## Finding 3 (verify): whether an exception can become objective invalid-command evidence

**Status: not confirmed, because `control.ts` was not supplied.**

- Before and after F2, a validator or reducer throw inside `validateCommandForEntry` or `validateSignedCommand` becomes an ordinary `failure('entry-verification-failed', …)`.
- For a command proposal, the adapter then calls `rememberAccusation`, which goes through `validateObjectiveForProposal` and then `validateObjectiveAccusation`.
- If `validateObjectiveAccusation` treats any `!ok` from command validation as proof, a nondeterministic local exception (for example stack or memory limits that differ between browsers) is accepted as objective evidence against an honest proposer. That would contradict F2's claim that an exception is never objective accusation evidence.

**Check:** the invalid-command verifier must reject accusations whose underlying failure code is `entry-verification-failed`. Add a test that injects a validator throw on the proposal path and asserts that no ACCUSE is sent. The current F2 tests only exercise SUBMIT, which never accuses.

## Checked, no defect found

- **Marker trust.** `proposalEntryRejected` is set only by `validateProposal` on `validateEntry` failures, and the spread puts it last, so input details cannot override it. Outer schema, context and signature failures and justification (`verifyCertificate`) failures are not marked. The failures `restoreConsensusState` and `receiveVote` return are not marked either. Fatal `consensus-*` codes are excluded before striking.
- **Cache validity across rounds and votes.** The key covers the complete canonical bytes, including `term`, `validRound` and `prevotes`. `validateEntry` depends only on fixed context: membership, exclusions, head, policy, and the historical resolver. Finding 2 is the one exception.
- **Persistence.** Cached and uncached rejections return before `store.save`. The cache is cleared in `stopVoting` and is per-instance, and each commit or repair opens a new controller.
- **Double-strike avoidance.** In the marker path the code is wrapped as `proposal-proof-invalid`, so the suffix check does not fire. A failed `rememberAccusation` returns the wrapped `received`, not its own code. A successful accusation returns `success`. Non-marked `proposal-signature` still gets exactly one suffix strike.
- **Stale and future parents.** The strike requires `seq === head+1` and a matching `prevHash`. A rejected dispatch emits no effects, so `this.context` cannot advance between dispatch and the check.
- **F2 containment.**
  - Local `submit`: rejection before acceptance resolves with the error, and the replica stays alive.
  - `entryCandidate`: a failing candidate is shifted off the queue and does not block the next one.
  - Remote SUBMIT: `entry-verification-failed` maps to `command-proof-invalid`. Striking on that is the subject of finding 1, not a containment gap.
