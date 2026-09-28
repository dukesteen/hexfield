# Mixed-browser manual relay passes; signaling reaches its runtime limit

[Run 36408263093](https://github.com/dukesteen/hexfield/actions/runs/36408263093)
tested source `95a1f6393428529d32ac21403582d044d189c5a7` on Linux with two
isolated Chromium contexts, Firefox and WebKit. Both modes formed a full mesh:
each peer had three authenticated links. This closes the Stage 08 mesh criterion.
The broader Stage 09 complete-flow gate remains unchecked because this run's
signaling game did not finish within its limit.

The [manual-relay job](https://github.com/dukesteen/hexfield/actions/runs/36408263093/job/108882073883)
passed in **239.277 seconds against its unchanged 300-second limit**. Its attached
public summary records 15 post-setup commands, terminal sequence 47 and four
audits. The tested source requires real signed startup, setup placement, a
certified post-setup move, legal commands, identical terminal heads and results,
four independent complete successful audits, three links per peer and no page
errors before attaching that summary. The last periodic sample records head
`6323f2758dbc879636a072463e5d5fafd3a79908bd50bfbd71f93573ce5ac71c`
on all four peers; Firefox was still verifying at that sample and completed
before the successful final assertions. The fixture uses its existing
three-point victory setting, so this is not default-ten-point acceptance.

The [signaling job](https://github.com/dukesteen/hexfield/actions/runs/36408263093/job/108882073548)
failed with `Test timeout of 240000ms exceeded` at 240.004 seconds. Its last
sample at 230.079 seconds shows all four peers playing at head 62, turn 10, with
three authenticated connected links each and no connection diagnostic. Audits
were not started. This establishes mesh and startup, but not terminal completion
or audits. The logs show a runtime deadline failure, not the earlier unmatched
manual offer failure. They do not establish the exact source of the remaining
runtime cost.

The earlier signaling pass at `2d027c1` took 239.632 seconds against the same
240-second bound. It remains separate evidence with little timing margin.
The current run predates the owned-genesis digest optimization in `6196fcf`;
its impact on browser completion has not been measured. No workflow was rerun
and no limit was increased for this evidence task.

The [summary](mixed-engine-manual-2026-09-28/summary.json) records both outcomes
and safe public peer samples. The
[manifest](mixed-engine-manual-2026-09-28/manifest.json) pins the run source,
original public job logs, tested source/workflow snapshots and downloaded report
identities. The compressed logs and source snapshots are archived beside it;
SDP, ICE addresses, private hands and secret keys are not included in the summary.
