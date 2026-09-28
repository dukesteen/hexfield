# Independent simulation audit workers

The [persistence CI failure](../stage07/verified-ci-2026-09-28.md) reached victory,
but synchronous terminal audits blocked simulated message delivery for several
minutes. A peer still awaited one reveal when the next wall-deadline check ran.
That result did not prove packet loss.

Verified simulations now explicitly give the fixture a Node worker executor.
Each peer gets a separate worker that recreates the base engine and the strict
public deck-transcript policy, then calls the existing independent game audit.
The persistence profile also reserves one full reconstruction comparison against
the captured private-state hash of every seat at every certified sequence.
The fixture checks the returned sequence count and capture digest, and retains
worker failures even after completed jobs leave its active set.

Workers own their master buffers; the parent copies and erases its inputs, and
the worker erases its buffers on completion. Cancellation terminates the worker
and rejects its promise. Worker errors never trigger a synchronous fallback.
Node imports remain in the simulation tool, outside the browser-safe protocol.

The virtual network keeps delivering while any peer awaits reveals. Only after
all terminal peers have started or completed their audits does the runner wait
for worker completion. That wait uses the remainder of the original wall-time
budget and clears its timer afterwards. Periodic host-event-loop yields do not
change virtual packet order or link latency. Overall deadlines, fault schedules,
ten-point games and acceptance requirements are unchanged.

Bounded checks pass:

- A real certified deck prefix produces identical synchronous and worker audit
  reports and compares all four private states at every sequence. Altered
  evidence fails; cancellation rejects; parent master buffers are erased.
- Fixture tests reserve one comparison across asynchronous jobs, propagate
  failure and retain it after completion.
- Production builds, test-source typechecks and scoped lint pass. The integrated
  runner also records aggregate flush, delivery, bot and non-voter work timings
  to distinguish slow progress from a stalled protocol.

The bounded worker test uses an unfinished certified prefix, so that test alone
is not evidence of a completed game. The later [current-v6 persistence CI
trace](../stage07/verified-ci-checkpoint-2026-09-28.md) completed the full
four-human persistence profile and its worker-backed terminal audits within the
original deadline. Separate verified network scenarios and the mixed-browser
matrix remain open as recorded in that report.
