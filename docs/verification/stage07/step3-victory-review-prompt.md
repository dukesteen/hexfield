# Automatic victory retry review

Read-only review with tools disabled. The user's standing approval covers this
source packet. Any keys in tests are deterministic fixtures, not actual game
secrets. Do not write implementation code.

Review the correction to F3 from `step3-live-followup-review.md`. A local
automatic command that fails before admission at its current certified parent
now retries after 250 ms, doubling to a maximum interval of four seconds.
Successful commitment clears the timer and resets the delay. Disposal cancels
the timer. An accepted command stays pending in `ReplicatedLog.submit`; an
unexpected asynchronous submission exception is diagnostic and is not retried,
because its admission outcome is unknown.

Check promise ordering, stale completion handlers, failure classification,
single-flight behavior, backoff and lifecycle cancellation. In particular,
look for a trace that signs or transmits duplicate admitted commands, reuses
proof material for a changed statement, or fails to retry a recoverable local
proof failure. Confirm that no private or public state is changed by a rejected
attempt. Evaluate the focused session tests separately from the real encrypted
victory-card test, which drives legal play to a purchase and checks that both
peers certify the automatic claim after one injected proof-source failure.

Return concrete defects with source symbols and failing traces. List meaningful
test gaps separately. Resource commitments, steals, escrow, final audit, WebRTC
and the lobby are explicitly later unfinished work, not claims of this patch.
