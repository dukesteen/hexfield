# Real-crypto acceptance after the public-point cache

[Run 36402607911](https://github.com/dukesteen/hexfield/actions/runs/36402607911)
tested `86acf16d11301d1b8b219800c8572a8b45c53177`, protocol v6. Every job
retained seed 42, game index 0, the default ten-point target and the 900-second
limit. The ten reports agree on unchanged source fingerprint
`4d58da91e5eafe41793b1cadb5224d4a118a42221ab6c111fa6a3a819249c286`.
The [manifest](verified-ci-hand-cache-2026-09-28/manifest.json) records the exact
source revision and both raw and compressed hashes of all ten public reports.
The gzip files preserve the original CI JSON bytes.

## Six passing scenarios

| Scenario                     | Entries | Turns |  Elapsed | Required observation                                                                   |
| ---------------------------- | ------: | ----: | -------: | -------------------------------------------------------------------------------------- |
| 1, clean                     |     641 |   104 | 794.11 s | Identical terminal histories                                                           |
| 3, sequencer restart         |     516 |    93 | 454.68 s | Fault at revision 33; replacement term 2; durable return                               |
| 4, two-against-two partition |     641 |   104 | 814.02 s | All four peers paused during the split and continued after healing                     |
| 7, censorship                |     641 |   104 | 794.62 s | Replacement term 2; the censored command committed                                     |
| 8, derived-state corruption  |     641 |   104 | 810.36 s | Fail-closed diagnostic, verified repair at revision 21, then a later command committed |
| 9, simultaneous restarts     |     641 |   104 | 737.17 s | Both restart faults injected and recovered at revision 28                              |

Each result includes four complete, successful independent audits with matching
terminal heads and no cheating findings. All six finish within the original
limit. Scenarios 1 and 3 therefore replace the earlier over-budget timing
evidence; scenarios 7 and 9 now have completed current-v6 traces. Scenario 9's
zero `snapshotRequests` metric concerns the separate corruption-repair path,
not all certified-history synchronization.

## Four failures still open

| Job                            | Terminal observation                                                                                 |  Elapsed |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | -------: |
| 2, latency and duplicates      | Revision 399, turn 66; all four heads match; no winner                                               | 903.46 s |
| 5, three-against-one partition | First victory at 844.45 s, revision 869/turn 152; one peer remains at 868; no audit started          | 918.99 s |
| 6, invalid proposer            | First victory at 834.77 s, revision 1064/turn 182; one honest peer remains at 1063; no audit started | 921.15 s |
| Persistence lifecycle          | Revision 611, turn 99; an entry is still propagating; no winner or audit                             | 900.01 s |

These are failed acceptance jobs. The runner notices an elapsed-time limit after
the current synchronous operation returns, accounting for the observed overruns.
No deadline, score target, fault timing, latency or coverage was relaxed.

The latency case spends 872.66 seconds in session flushes and only 2.25 seconds
in measured network delivery. Scenarios 5 and 6 have individual session flushes
of 25.00 and 29.35 seconds. Their peers that reached victory have only their own
master reveal when the run stops. This motivates inspecting synchronous terminal
replay before reveal publication; the reports alone do not establish its cause.
Scenario 6 also spends 65.15 seconds exporting the actor's 1,044 growing history
prefixes. Its 167.70-second actor-advance total includes that export time and
must not be added to it. Persistence leaves approximately 329 seconds outside
the recorded flush/network/bot timers; restore work needs separate measurement.

All four unit shards, the engine simulation and all nine separate stub-network
jobs passed. Production/test typechecking and lint passed; the ordinary check
then failed on the authored hand-cache comparison JSON's formatting. That
formatting and its artifact hash were corrected in `56cfbc7` and `2962c88`.
Later build/coverage/deployment steps in this run were skipped. The real-crypto
failures remain independent of that formatting correction.

M-C and M-D remain incomplete: three real-crypto fault scenarios, the full
persistence comparison and the separate browser/device/security gates still
need their required evidence.
