# Final ledger guard review

Read-only security review; tools disabled. The user has pre-approved all project
Claude reviews. Review only the F1/F2 corrections below. Stage 07 remains incomplete.
The previous final correction review accepted the checkpoint with these robustness
findings; this pass checks the corrections, not acceptance of pending features.

F1: validateProposal marks failures returned by validateEntry with the local error
detail proposalEntryRejected. ConsensusController caches only those failures by
SHA-256 of the complete bounded canonical proposal bytes. It stores code/message,
retains at most 16 entries, and discards the cache on disposal or a new controller.
Its certified parent and policy are fixed; it never caches consensus-state
transition failures. The adapter strikes a sending peer when such a rejection is
for its exact next height and current parent hash, including fresh variants. It
wraps the error to avoid a second suffix-based signature strike. The existing
objective accusation path still runs for bad command proposals; a strike also
occurs if that path successfully stages the accusation. Outer signature failures
and stale/future-parent inputs retain their existing handling. Tests cover cache
eviction, unchanged persistence, subsequent valid proposals and five fresh
invalid system-entry variants causing disconnect without a local halt or vote.

F2: validateSignedCommand catches validation exceptions, and deriveCandidate
catches reducer/signing/derivation exceptions. Remote validation exceptions map
to the same bounded invalid-command path. Tests inject validator and reducer
throws into local and remote submission, then certify a valid command on the
same replica. An exception is never objective accusation evidence.

Review marker trust, cache validity across rounds and votes at a fixed parent,
honest retransmission behavior, double-strike avoidance and exception containment.
Report concrete remaining defects in these corrections with a trace and minimal
fix. Do not restate pending live unlock/session/resource/escrow/browser work.
