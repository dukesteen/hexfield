# Scenario 6 context-stamp progress profile

This was a single paired 60-second progress profile of the consensus context
stamp change, not a full acceptance run. Both isolated checkouts used Node
22.23.3, the same seed 42, verified security, scenario 6, one worker and the
unchanged `--max-elapsed-ms 60000` limit. The baseline was commit
`0c53e8a4184a868902638101a5fc3447b922daaa`; the candidate was
`f203c5ba9724b9471a7f76c5cd2d059190cad671`. Their source diff is limited to
the two consensus files, their regression tests, and the codec string encoder
and internal export.

```sh
node tools/sim/dist/index.js net --security verified --scenario 6 \
  --seeds 1 --seed 42 --start-index 0 --parallel 1 \
  --max-elapsed-ms 60000
```

| Build     | Progress at deadline                                                                  | Wall / user / system   | Session flushes                         |
| --------- | ------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------- |
| Baseline  | 60.01 s timeout; three reported peers were at seq 144–145, turn 27, with no result.   | 60.44 / 58.16 / 0.92 s | 5,391 calls; 43.79 s total; 887 ms max. |
| Candidate | 60.03 s timeout; all three reported peers agreed at seq 175, turn 34, with no result. | 60.45 / 61.00 / 0.73 s | 6,471 calls; 46.23 s total; 900 ms max. |

The candidate reached about 30 more certified revisions and seven more turns.
Its average time per session flush was about 7.15 ms versus 8.12 ms in the
baseline, while average actor-advance time was similar (22.9 ms versus 22.3
ms). Aggregate flush time was higher in the candidate because it processed
more flushes. These observations are suggestive; they do not establish a
single-cause speedup or a pass.

A short shared typecheck/lint may have overlapped the early baseline interval;
its exact timing was not retained. No crypto or full-game test overlapped, and
the candidate profile had no competing build or test. The compiled manifests
cover 432 files per checkout and are identical before and after each run. The
[raw results and pins](scenario6-context-stamp-profile-2026-09-28-artifacts.tar.gz)
include both JSON diagnostics, `/usr/bin/time -l` outputs, source commit pins,
runtime versions, and compiled before/after SHA-256 lists. Archive SHA-256:
`c48e8db13d187289ccd8ca6db20f080111edc1ffe80660177595320517019cf3`.

Both 60-second runs timed out before the scenario fault or a terminal result
was observed. This bounded comparison does not change the full 900-second
scenario-6 result, establish all-scenario performance, or close any acceptance
gate. The full scenario and audit remain required.
