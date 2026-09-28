# Mixed-engine manual-relay follow-up, 2026-09-28

[CI run 36427632245](https://github.com/dukesteen/hexfield/actions/runs/36427632245)
tested manual-relay mode on commit
`836fb114b5c7f9c0de4c566ccee507c5d5894ab2`. Build, Playwright installation,
local signaling and mesh startup passed. The test reached its four-peer game
but did not finish within the 150-second play predicate.

At timeout, all four views agreed at seq 144 and hash
`fc9e15e23a8ccf326e3236ab87ad5e7ad1fc29b74ad8b402b1d85b8da54770b9`, turn 25,
phase `stealResult`. Each showed a pending random input and seat 3's
`CLAIM_VICTORY` input. The result was absent and audits remained `not-started`.
The driver had accepted 81 commands with no refusals. Every peer reported a
complete mesh, authenticated connected links and no connection error; the log
shows the same certified head across all views. The pending `CLAIM_VICTORY`
slot is a generic interrupt allowance, not evidence that victory was legal or
that a claim should have been submitted. `playElapsedMs` was 149,972 and
`auditElapsedMs` was zero. The test timed out before terminal result and before
audit began; it does not establish an audit failure or network divergence.

This run follows the earlier [manual-relay report](mixed-engine-followup-36422582118.md),
which stopped earlier at seq 97. The latest run progressed further but still
does not meet full-game mixed-engine acceptance. It does not establish a
physical-device or deployed-server result.

The [public CI log, metadata and Playwright report](mixed-engine-manual-followup-36427632245-artifacts.tar.gz)
are retained with SHA-256
`853bcb7c6e3282ed6574344c28e160add4b351fc0fcb414bad9b35debc08a932`.
