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

## Remaining failures

| Scenario                       | Observation                                                                               | Next check or correction                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2, latency and duplicates      | Timed out at revision 324, turn 54; all peers at the same revision                        | Measure proof/audit work before drawing a liveness conclusion. Preserve required 50–400 ms link latency and actual duplicate delivery.                                             |
| 5, three-against-one partition | Timed out at revision 791, turn 139 with `DICE_RESULT` pending                            | Inspect system/beacon progress. A public claim-only pending item is not proof that its player can win.                                                                             |
| 6, invalid proposer            | `invalid-encoding` in terminal master-reveal journal replay                               | Actor retained derived validation fields including a `Map`; retain only the certified wire envelope. Focused regression passes after that correction; full scenario rerun pending. |
| 7, censorship                  | Reached terminal revision 641; one audit complete and three awaiting reveals at timeout   | Capture missing owners and synchronous audit timings before changing disclosure behavior.                                                                                          |
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
