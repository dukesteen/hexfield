# Signed Monopoly count delivery checkpoint

This checkpoint connects owner count proofs to verified peer play. It does not
complete Stage 07 or enable production online play.

A certified Monopoly command freezes its actor, resource, anchor, epoch, genesis,
requested victims, owner keys and resource commitments. Victims with a public
maximum of zero are absent. Each requested victim signs its exact count and a
Schnorr opening bound to the complete frozen operation. A zero count still needs
a proof. Earlier reveals and proposer controls preserve the operation for later
victims.

Entry validation checks the signed count before any generic system callback.
The local engine derives the reveal obligation and exact resource movement;
validation checks both before consuming a victim and folding public commitments.
Replayed metadata must match the current pending victims and their unchanged
commitments. A terminal certified game can close unfinished requests. A pending
count does not block engine-legal victory claims when no count is available.

The owner driver checks its certified head, authorized pending request and all
owned hand openings before deriving a proof. The hand source uses separate
master-derived proof randomness. The outbox persists signed bytes under the
operation and victim before sending. Retries use the stored bytes; a corrupt
record fails closed. The bounded inbox retains later victims across earlier
reveals and ignores stale or duplicate contributions.

## Local gate

The final combined `pnpm check` passes 805 tests in 141 files, with the opt-in draw
benchmark intentionally skipped. Typechecking, lint, formatting, dependency
boundaries, purity and translation checks pass. The suite took 201.79 seconds;
the existing deck integration file accounts for 154.89 seconds across six bounded
traces. No test timed out. The production build also passes.

The [check log](step4-count-check.txt) and [build log](step4-count-build.txt) retain
the results. The [214-file source manifest](step4-count-source-manifest.json) has
fingerprint `12c2648b41857a7e96566a9f99b5744793e99cded3cad20622c0b9b4fb49813e`.
Those sources remained unchanged through the gate and build. An earlier gate
passed 804 tests; it was repeated after the review-driven startup and shared-path
validation corrections. The [review response](step4-count-review-response.md)
records those fixes and the tests added afterward.

## Verification scope

Focused tests cover nonzero-blinding zero and positive counts, operation-field
binding, malformed signatures/envelopes, wrong owners and amounts, missing
metadata, changed commitments, callback bypass, ordered consumption and a
state-preserving control entry. The validator tests explicitly use synthetic
trusted parents to isolate those properties. They are not legal peer histories.

A separate fixed seed-14 trace runs two human peers and their two hosted bots
through a real deck ceremony, legal setup, real beacon results, a private card
purchase and an actual Monopoly play. It withholds the final victim's contribution and proposal while the first
victim certifies, then disposes and restores both peers from retained journals
and contribution stores. Heads and every hosted private hand match at that
pending checkpoint. The original signed bytes are retransmitted unchanged,
then both exact victim seats certify and private consequences match. The trace
takes 29.79 seconds alone. Its 60-second guard allows CPU
contention in the normal two-worker suite; it remains one bounded game segment.

The first attempt hit the default five-second test timeout during ceremony work.
The next exposed a test expectation that counted all other seats instead of only
requested victims with a positive public maximum. Correcting that expectation
showed the protocol had completed normally. No random seed search, full-game
batch, Firefox/WebKit launch or browser performance run was used.

The live restoration check covers an unconsumed, durably stored victim reveal.
Disposal during an awaited write and a live winning claim while a victim
withholds its contribution are not claimed by that test. Focused tests separately
cover losing storage races, corrupt/missing winners, persistence failure and
caller-key mutation across an await. Browser durable storage and lifecycle
recovery remain Stage 10 work.

## Remaining work

Hidden steals, uncertain other-owner trade proof delivery, escrow, final audit
and the remaining Stage 07 adversarial integration are unfinished. All verified
steal results still fail closed. A withholding victim can pause progress until
authorized recovery is implemented. The public protocol-version and legacy
command-evidence cutoff must be finalized before online release.
