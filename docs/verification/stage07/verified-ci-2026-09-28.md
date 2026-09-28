# Verified network CI results, 2026-09-28

[CI run 36389605903](https://github.com/dukesteen/hexfield/actions/runs/36389605903)
ran one seed for each real-crypto scenario at commit
`5c8c762c59e76b583ee76b7e12991f38cb0d9ae4`, protocol v6. Every report identifies
seed 42, game index 0 and unchanged source fingerprint
`cb8dabe2dd5f6f0aded48b96ae8226dff41aa3ab0a2f486096a566319dff7637`.
The fixture retains the default ten-point victory target.

## Completed games

| Scenario                                                                       | Certified entries | Turns | Wall time | Required fault observation                                                                           |
| ------------------------------------------------------------------------------ | ----------------: | ----: | --------: | ---------------------------------------------------------------------------------------------------- |
| [1, clean](verified-ci-2026-09-28/verified-network-1.json)                     |               641 |   104 |  962.91 s | No injected fault                                                                                    |
| [3, sequencer restart](verified-ci-2026-09-28/verified-network-3.json)         |               516 |    93 |  977.85 s | Crash at revision 33, durable restart after the scheduled 20 seconds, replacement proposer in term 2 |
| [4, two-against-two partition](verified-ci-2026-09-28/verified-network-4.json) |               641 |   104 |  766.85 s | Split at revision 28; all four peers observed paused during the 30-second partition, then healed     |

Each completed game has four complete, successful independent audits, no private
misconduct findings, and identical certified histories and final public state
among its peers. The retained JSON contains final hashes, audit heads and fault
assertions. Scenarios 1 and 3 exceeded the runner's nominal 900-second budget
inside a long iteration before its next elapsed-time check. Their completed
histories and audits are valid evidence, but they do not establish a hard
900-second runtime bound. No deadline was raised to obtain these results.

## Initial-run failures

| Scenario                       | Observation                                                                               | Next check or correction                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2, latency and duplicates      | Timed out at revision 324, turn 54; all peers at the same revision                        | Measure proof/audit work before drawing a liveness conclusion. Preserve required 50–400 ms link latency and actual duplicate delivery.                                             |
| 5, three-against-one partition | Timed out at revision 791, turn 139 with `DICE_RESULT` pending                            | Inspect system/beacon progress. A public claim-only pending item is not proof that its player can win.                                                                             |
| 6, invalid proposer            | `invalid-encoding` in terminal master-reveal journal replay                               | Actor retained derived validation fields including a `Map`; retain only the certified wire envelope. Focused regression passes after that correction; full scenario rerun pending. |
| 7, censorship                  | Reached terminal revision 641; all four audits awaiting reveals at timeout                | Capture missing owners and synchronous audit timings before changing disclosure behavior.                                                                                          |
| 8, derived-state corruption    | `consensus-context` correctly stops voting, but replica disposal prevents snapshot repair | Add a fail-closed snapshot repair path that restores the existing durable safety record. Never weaken the context guard or reset votes.                                            |
| 9, simultaneous restarts       | Reached terminal revision 641; one audit complete and three awaiting reveals at timeout   | Same missing-owner and audit-timing diagnosis as scenario 7.                                                                                                                       |

All four unit-test shards passed. Eight of nine separate stub network scenarios
passed; stub scenario 8 hit the same repair gap. The ordinary check job failed
only on Markdown formatting in the archived review input, which has been fixed
locally. The separate mixed-engine run stopped at an exact label selector in
the lobby, before connection setup; its selector correction awaits a new run.

This is partial acceptance. It does not mark M-C or M-D complete, establish the
remaining six real-crypto cases, or claim that later source changes have already
been tested by this run.

## Follow-up at `f520e83`

[Run 36393891485](https://github.com/dukesteen/hexfield/actions/runs/36393891485)
completed with failures. All four unit shards, static checks, build and engine
simulation passed. Stub scenario 8 still failed on the repair gap; the proposed
repair implementation was not in this commit. The two selected real-crypto jobs
retained seed 42, index 0, the default ten-point target and the 900-second limit.
Both report unchanged source fingerprint
`8aeeb2282ba76ee42fc67fd63ce441a07e9617416077e428d196988a8ad0b96d`.

- [Invalid proposer](verified-ci-2026-09-28/followup-invalid-proposer.json)
  timed out at 900.13 seconds, revision 763, turn 133. Its latest certified
  progress was at 899.64 seconds. Three honest peers remained active, with no
  protocol error and no terminal result. The first beacon extension had already
  completed. This run shows continued progress, not a deadlock; it does not
  establish completion within the budget. Operation timing is the next check.
- [Persistence lifecycle](verified-ci-2026-09-28/followup-persistence.json)
  reached victory at 601.04 seconds, revision 641, turn 104. All four peers had
  the same certified head at exit. Three audits completed; the fourth awaited
  seat 1's reveal when the deadline check fired at 911.09 seconds. The three
  synchronous audit invocations consumed 70.33, 121.73 and 70.93 seconds; the
  middle invocation included 51.07 seconds of private-state comparison.

The persistence timeout does not prove that a reveal was lost. The fixture runs
each audit synchronously before returning its promise. That blocks the simulated
network pump, and the next deadline check can stop the run before an already
queued reveal is delivered. Browser sessions instead run audits in workers. The
fixture will use the same scheduling separation, while retaining an independent
audit for each peer, exact private-state comparisons at every sequence and the
existing deadline. This failed run is not full lifecycle acceptance.

## Verified repair and worker audits at `488cbae`

The real-crypto corruption job in
[run 36398472499](https://github.com/dukesteen/hexfield/actions/runs/36398472499)
passed at `488cbae80eeb2bd8638836bd64dc6343a4795331`. The
[public report](verified-ci-2026-09-28/repaired-corruption.json) records unchanged
source fingerprint
`68474550f7f22dc436f2ed3035e690b56e8143562519c764f7bb75d1fc947ce0`,
seed 42, index 0, protocol v6 and the original default-ten-point/900-second bounds.

Corruption at revision 21 triggered `consensus-context`, one snapshot request and
three responses. The repaired peer adopted the verified parent at sequence 21,
resumed and certified a later command. All four peers finished at sequence 641,
turn 104, hash `d8034528af0b004772dabb88481ba6c79641f3b722cc2e844af943cf05e512ab`.
Every peer independently completed a successful audit with no cheating findings.
The full run took 568.48 seconds, including the four worker audits (about
131.5–132.5 seconds each, overlapping). This closes scenario 8's full-game repair
check for this source; it does not replace the other fault scenarios.

All nine separate stub-network jobs also passed. The ordinary check passed
production/test typechecking and lint, then stopped on six formatting issues;
those are fixed in `52722f2`, with a passing tracked-file format check. Its later
build and dependency checks were skipped, not passed. All four unit-test shards subsequently passed. The overall run failed because
of formatting and the persistence timeout below; deployment was skipped.

The [persistence repeat](verified-ci-2026-09-28/worker-persistence-timeout.json)
failed its unchanged 900-second limit before victory, at head 598/turn 98. All
four peers agreed on that head, had no protocol error and had progressed within
the previous second. No audit had started, so this timeout does not test the
worker-audit correction. Session flushes consumed 559.30 seconds; other lifecycle
work is not yet separated in the timing report. The previous persistence run
reached victory sooner on another runner, so these measurements do not establish
a performance regression from worker audits. Exact per-sequence private-state
comparison and terminal lifecycle acceptance remain open. A bounded CPU profile
is the next step; no deadline or winning score has been changed.
