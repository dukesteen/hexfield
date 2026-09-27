# Audit review corrections

The approved [Claude review](audit-review-response.md) examined checkpoint
`24b7296`. Its [manifest](audit-review-manifest.json) records the supplied source.
The review was read-only and did not run the code.

The implementation now preserves a worker's rejected-history report even when
replay never reaches the terminal entry. Job identity and the captured certified
head still reject stale results. Audit processing failures have a separate
`auditError` field. A local engine exception no longer accuses the player drawing
a card. Only the specific hidden-transfer resource mismatch attributes that
transfer to its victim; a failed draw alone does not identify a dishonest
recipient.

Any current voter can relay an already signed reveal. The original publisher's
signature and certified authority remain mandatory. Accepted packets are
retransmitted, and reveal verification has its own six-packet budget instead of
consuming snapshot/repair capacity. Invalid stored reveal records are quarantined
per seat. Reveal preparation failures are reported without blocking post-result
consensus. The session supplies its recovery store to the reveal coordinator by
default.

The browser worker has a 60-second default deadline. Timeout terminates the
worker, clears retained inputs and permits an explicit retry. Eight focused
worker-adapter tests pass.

## Additional checks

- The scalar decoder already rejects values at or above the group order and
  rejects zero when requested. An added audit regression supplies `master + L`
  and requires an input error with no owner violation.
- Built-in hand and deck proof validation runs before an optional policy callback.
- Base64 decoding checks canonical encoding by re-encoding the decoded bytes.
- `VerifiedSessionDriver.privateState()` returns a detached copy.
- Pending recovery now prevents ordinary gameplay proposals and admission until
  controller activation completes. This also prevents a player from finishing
  while a departed seat's original master cannot yet be revealed. Control,
  misconduct evidence and recovery transitions remain available. The focused
  recovery file passes four tests, including rejection of an otherwise legal
  placement during this interval.

## Verification

The [final focused run](../stage09/lobby-audit-checks.json) passes 64 tests in ten files in 180 seconds, with no
unhandled errors. It covers audit reporting, reveal relay and corruption, pending
recovery admission, lobby requests, native-transport discovery logic, persistent
credentials, invitation parsing and worker deadlines. Production build, test
typechecking, scoped lint and formatting, dependency boundaries, engine purity
and translation checks pass. The full unit suite was not repeated at this
checkpoint.

An earlier run passed its assertions but failed with Vitest's `onTaskUpdate`
timeout. The terminal fixture repeatedly awaited already-resolved promises and
could starve runner I/O. Tests now supply an event-loop yield between message
batches, without advancing the protocol clock or raising the timeout. The final
run above completes without that infrastructure error.

The [native lobby check](../stage09/lobby-browser-check.md) also passes in the
existing Chrome session. The browser audit page is implemented, but its real
worker execution remains pending a successful recovered-game fixture.

## Remaining verification

The full recovered-game test reached certified sequence 345 and turn 95 with all
peers agreeing, but its scripted players stayed at two points. That is not a
passing completed-game audit. The long-running draft was moved out of normal test
discovery. Cheap engine-only planning identified a shorter seed-4 candidate that
wins after two development-card purchases; the exact certified run is still
required. No larger simulation count or timeout was substituted for that check.

The dedicated terminal fixture whose master matches F0 but contradicts other
genesis keys also remains open. Production online integration and Milestones C/D
remain unfinished.
