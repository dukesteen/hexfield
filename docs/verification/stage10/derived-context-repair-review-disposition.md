# Derived-state repair review

The [first source review](derived-context-repair-review-raw.json) found blocking
liveness and quarantine defects. Its [input](derived-context-repair-review-input.md)
and [manifest](derived-context-repair-review-manifest.json) describe the original
implementation.

The high-severity finding was reproduced with a valid proposal, signed prevotes,
a real polka lock and a local precommit. After bank corruption, validation against
the corrupted context returned `consensus-restore` and permanently disposed the
replica. The original scenario-8 runner hid this case by dropping proposals and
votes before injecting corruption. That filter has been removed.

The corrected context-mismatch path enters a repair hold without validating its
saved vote against the already-corrupted context. A fresh replay of the durable
certified history must still match the controller's opening context. The exact
durable safety revision and bytes must survive restoration. A focused locked
replica regression now passes through repair and the later commit.

The review also identified proof-capture side effects before quarantine, strike
and rejection caches based on corrupt state, repeated full replay for forged
snapshots, unauthenticated retained commits and swallowed context-fault status.
Those paths now have focused regressions. Repeated forged snapshots reuse one
trusted local replay, while adoption rechecks the exact durable history and
safety bytes. Held commits require signatures and strict quorum certificates.

The [follow-up review](derived-context-repair-followup-raw.json) identified a
queue-boundary problem. It was reproduced by pausing a commit's safety read,
corrupting the bank, injecting an oversized packet and releasing the read. The
replica entered repair synchronously, removed its active controller and then
disposed on the resulting effect error. A separate pending-write case did not
reproduce the disposal and remains useful regression coverage.

Repair now starts at the serialized queue boundary. Synchronous ingress detects
the fault and queues one bounded check. Cached proposal returns validate their
context, direct trade-proof requests check it before sending, and commit effects
check it before replay. Legitimate preexisting peer blocks survive repair.

The [boundary review](derived-context-repair-boundary-review-raw.json) approved
the correction on the condition that a disposed controller still permits a
valid snapshot. The implementation satisfies that condition: `snapshot()`
validates the owned context and record independently of the stopped signing
state. A regression pauses opening the next controller after disposal, injects
an oversized packet, then resumes and commits normally. The two boundary cases
pass. The controller and replica files pass all 62 tests, including the real
verified genesis and two-deck-pass replay comparison. Test-only refinements
after the frozen review are recorded in the final source commit.

Two speculative findings were checked against their implementations: snapshot
verification uses exactly the cached canonical hash comparison, and both normal
and held commit paths use the same strict certificate validator. Neither needed
a weaker validator. The source review is complete; the full scenario-8 game is
still required and is not claimed by this report.
