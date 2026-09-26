# Private trade proof delivery

This checkpoint completes remote spending-proof delivery for an accepted player
trade. Stage 07 and milestones C/D remain open.

## Implemented behavior

The finalizer requests only the other participant's proofs for the exact certified
offer, consent, parent and command. Requests and responses are signed and sent
directly between the two hosts. Both participants' proofs still pass the shared
version-1 hand-transition verifier before the command can enter consensus.

Preparation has a ten-second deadline and permits the initial request plus three
fresh-parent attempts. Exact retries reuse cached bytes. Explicit cancellation,
automatic actions and expired timers can stop preparation. Once the replica
admits the command, cancellation and resubmission are disabled. A temporary
private-source failure emits no response; a later user attempt can retry after
the bounded work window.

## Verification and review

The legal two-peer trace first creates an uncertain hand through a hidden steal.
It then holds trade responses across three certified parent changes, checks one
proof generation per parent and ignores an obsolete response. Both peers restart
before confirmation and regenerate the current response byte for byte. Exactly
one confirmation commits, and independent replay verifies both private hands
and public commitments after another restart. This trace took 30.27 seconds in
the final suite.

The [budget mutation](step4-trade-budget-mutation.txt) restores the old limit of
three requests and makes that trace fail at the missing fourth response. Other
focused tests cover cancellation, deadlines, timer priority, the replica/session
publication gap, withdrawn consent, malformed signed proofs and strict routing.

The initial Claude review and follow-up are complete. The
[review response](step4-trade-implementation-review-response.md) records the
timing fixes, rejected findings and limits of the network fixture. The follow-up
confirms the timing fixes. Its conditional malformed-point concern is already
handled by the shared verifier's exception boundary and now has a regression.

On 2026-09-27, Node 22.23.3 and pnpm 10.7.1 passed the combined
[local check](step4-trade-check.txt): production and test typechecks, lint,
formatting, dependency boundaries, engine purity, translation checks and
**899 tests in 157 files**. One opt-in timing benchmark is skipped. The test phase
took 199.18 seconds with at most two workers. The
[production build](step4-trade-build.txt) also passes. No browser suite or large
game batch was run for this checkpoint.

The [259-file core source manifest](step4-trade-source-manifest.json) has
fingerprint
`491ef1565e3adc9fe727528c337f6832636864ed7505e3c5a78a15f7252d6f6e`,
unchanged through the final check and build. The combined suite also includes
30 tests for separate, unintegrated cheat-proof, escrow-roster and WebRTC
foundations. Those files are outside this manifest and trade checkpoint. Their
passing tests do not establish Stage 07 or Stage 08 acceptance.

## Remaining work

Typed cheat consequences, authorized recovery from withholding owners, escrow,
end-game audit, the remaining browser proof-performance target and adversarial
full-game integration remain. Stages 08–10 still need complete WebRTC transport,
lobby setup and durable browser recovery. The verified private protocol is not
yet exposed in the production online UI.
