# Cross-peer trade proof implementation review

Review this exact source snapshot read-only. Use no tools or external file access.
The user has authorized all Claude reviews for this project. Deterministic test
keys are fixtures, not live credentials.

This implements the attached reviewed trade-delivery design. The final command
retains command-proofs-v1 and mandatory shared hand-proof validation. The owner
produces only its locally derived obligations after checking the signed exact
confirmation body, certified consent, next nonce and current applied parent.
Requests and responses are sent directly between the finalizer and owner hosts.
They never enter the certified log or broadcast path. Human identities and bot
hosts come from genesis; host takeover is a later stage.

The session reserves the local seat during cancellable pre-admission preparation.
It permits three fresh-parent retries after the initial request, only for the
same offer, counterparty and terms, within ten seconds. Automatic inputs, expired
timers, explicit cancellation, withdrawal and disposal stop preparation. Once
replica.submit receives a signed command, the existing pending/outcome rules
apply and cancellation cannot claim to undo that submission.

Successful proof responses are cached per parent. Deterministic private replay
and full-context proof seeds let the owner regenerate them after restart.
Pre-admission intents are deliberately not durable. Failed requests produce no
cannot-pay message. Current affordability of the exact standing-consent terms
is disclosed to the finalizer by a positive proof, as discussed in the design.

Focus on concrete defects:

1. Can an unauthorized or changed request reach a private proof source, reveal
   more than the consented affordability fact, or cross a game/parent/nonce?
2. Can route spoofing, caching, stale responses, malicious proof indices, or
   callback mutation bypass the normal command proof verifier?
3. Can cancellation, automatic input, parent changes, disposal or late responses
   submit a stale command, strand a seat reservation, or accidentally retry an
   accepted command? Examine the async boundary and exact retry limits.
4. Can failed or future requests prevent later legitimate completion? Are caches,
   wire schemas and expensive-work limits bounded without treating honest stale
   traffic as cheating?
5. Do the focused tests and one legal live trace substantiate the stated behavior?
   The live trace completes a hidden steal, certifies an accepted trade requiring
   a remote range proof, drops its first response, checks identical retry and one
   source invocation, then restores both peers and checks public/private changes.

Separate findings in this change from later escrow, typed cheat consequences,
audit, real WebRTC, lobby, browser persistence and takeover. No browser timing or
completed Stage 07 claim is made. Do not request large random test batches.

For each finding, give severity, exact function, a reproducible failing trace and
the smallest fix. State when a claim depends on behavior absent from the packet.
