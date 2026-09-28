# Verified CI checkpoint, 2026-09-28

[CI run 36411956997](https://github.com/dukesteen/hexfield/actions/runs/36411956997)
tested protocol v6 at commit `0c56aa114f111ad2d5373d50c211effdd4408023`,
with seed 42, game index 0, default ten-point victory, one worker and the
unchanged 900,000 ms network limit. Every report has source fingerprint
`5f6ca910fab919d455be46ad1215cbd6c5bd96dea37cc9398b06be95bf153bad` and
`sourceUnchanged: true`. The [compressed public artifacts](verified-ci-2026-09-28-checkpoint-artifacts.tar.gz)
retain the reports and source revision for scenarios 2, 5, 6 and the persistence
lifecycle. SHA-256:
`30c82e3a28af8730626eaba2dcf2b95282173c84d5846e4dbe5a3919f93860d3`.

## Persistence lifecycle passed

The persistence profile completed one real-crypto four-human game in 836.11 s:
641 inputs, 104 turns and terminal history seq 641. It passed twelve periodic
restarts at reached approximately 50-entry boundaries through seq 602, rotating
seats 0, 1, 2, 3. It also closed all four sessions at seq 152 for 2,000 ms and
reopened them in order 2, 0, 3, 1 with 250 ms between reopenings. The
everyone-left continuation was certified at seq 154 with all four restored
seats participating in matched post-restore precommits.

The fixture verified each restored controller's actual safety load and first
compare-and-swap write against retained durable state, with zero vote-ordering
violations. The independent audit completed cleanly for all four seats at the
same terminal head. Each seat had 642 captured and checked private sequences;
the audit also compared deterministic per-sequence reconstruction against the
omniscient engine oracle. The artifact reports 2,568 owner snapshots, 4,528
repeated snapshots and digest
`d3d13ee78e6b8a98bc60e1db541512af73a17a10efe95ecbb0b5198b8aaba5f1`.

This passes the named periodic/everyone-left persistence profile and its exact
private-state comparisons. It is an in-memory simulation lifecycle trace; it
does not replace the separate signing/storage interruption cases, native
power-loss durability, or mixed-browser/device coverage.

## Three verified scenarios timed out

| Scenario                       | Terminal artifact observation                                                                                                                                                                | Disposition                                                                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2, latency and duplicates      | Deadline at 900.61 s; all four peers agreed at seq 520, turn 82, with no result and a pending player turn. Last certified progress was 891.29 s.                                             | Timeout while the game remained active. The result does not show peer divergence or establish that the game could not later finish. Session flushes consumed 873.13 s total.                                      |
| 5, three-against-one partition | Terminal public-victory entry at seq 869, turn 152, at 714.09 s. All peers had the same public winner and empty pending queue at timeout 900.10 s; audits remained `verifying`.              | Deadline expired during post-terminal audit progression. The report records no completed audits; it does not establish a missing reveal or an audit correctness failure. Its audit timing counters remained zero. |
| 6, invalid proposer            | At 923.42 s, seat 2 was at terminal seq 1064 with winner 2 and awaited reveals from seats 0, 1, 3. Seats 1 and 3 remained at seq 1063 without a terminal result. Last progress was 892.88 s. | Deadline expired with a one-entry terminal propagation gap and incomplete reveal exchange. This is a failed acceptance run; the report does not establish the cause of the delayed commit/reveal.                 |

A later [paired 60-second context-stamp progress profile](scenario6-context-stamp-profile-2026-09-28.md)
compared the exact parent and candidate commits with the same seed and limits.
Both runs timed out before the fault or terminal state; the candidate showed
more progress, but the short profile is not an acceptance result or a
single-cause performance finding.

All four unit shards, the build/check job, engine simulation and all nine stub
network scenarios passed. The run is therefore partial, not green: the three
verified scenarios above remain open and are not converted into passes by the
successful persistence profile.

The separate [mixed-engine run 36411956751](https://github.com/dukesteen/hexfield/actions/runs/36411956751)
also failed its manual and signaling jobs at their configured test deadlines.
The final signaling snapshot showed connected peers and progress through
head 75; the final manual snapshot showed connected peers at head 88 with audits
`verifying`. The manual diagnostic does not include a result field, so terminal
result state is unobserved. Neither failure is evidence of an RTC connection
failure, and neither establishes a runtime deadlock.
