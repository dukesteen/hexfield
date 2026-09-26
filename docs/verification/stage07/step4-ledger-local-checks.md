# Committed-hand ledger checkpoint

This checkpoint connects the accounting foundation to certified replay. It does
not complete Stage 07 or enable production online play.

Verified genesis starts with empty hands. Every replayed cryptographic context
now carries the canonical five-resource commitment ledger. Public production,
payments and trades update it, including inputs whose beacon or deck verification
is handled separately. State-preserving protocol entries retain it. Snapshots and
voting context hashes already include the complete cryptographic context.

Admission, entry validation and objective command accusations share the mandatory
command verdict. It previews the local engine, checks accounting and invariants,
derives gross debit obligations against parent balances, verifies exact evidence
sections and folds the commitments. Public minima may establish affordability;
otherwise a six-bit proof opens the commitment after subtracting the whole debit.
Incoming credits cannot fund a promised outgoing transfer.

The driver emits `command-proofs-v1` with deck and hand sections. Historical
`deck-reveal-v1` evidence is accepted only when no hand proof is required. Card
reveal effects must match the command's slots, owner, card kinds and certified
deck. Optional callbacks can further restrict commands but cannot replace the
built-in proof checks.

Only locally owned private hands and blindings are retained. The driver verifies
their openings before proof preparation and before publishing each certified
private update, including replay and entries without engine input. Hand proof
randomness comes from a separate master-backed source, bound to the genesis,
seat and complete public proof context. Public changes preserve blindings.

## Verification status

The final `pnpm check` passes 787 tests across 137 files, with the opt-in draw
benchmark intentionally skipped. The test suite takes 151.72 seconds. Typechecking,
lint, formatting, dependency boundaries, purity and translation checks pass. The
[check log](step4-ledger-check.txt) retains the complete result. The production
[build](step4-ledger-build.txt) passes as well. The
[review response](step4-ledger-review-response.md) records added regressions and
open integration boundaries; no high-severity safety defect was found.

The [206-file source manifest](step4-ledger-source-manifest.json) has fingerprint
`cd71db141df10cd2a034e89ca4724609d305cd1832909fb6cdd04ef8afcc588c`.
The first combined run found eight failures from one simulation-only callback
regression. Restoring its previous evidence-conditional behavior fixed all 19
session tests, followed by the passing combined gate. No large simulation batch
or browser performance run was repeated.

The legal deck-log test reuses its existing setup, real beacon dice, purchase and
deal trace. It compares each replayed commitment to the exact public resource
count. A fixture-only uncertain copy of the certified purchase parent checks
that missing required proofs fail before permissive callbacks in both admission
and entry validation. Other synthetic uncertain-hand tests cover gross debits,
wrong contexts, zero-count openings and private opening failures. They do not
claim to be complete legal hidden-transfer histories.

## Remaining boundaries

Pure count-opening proofs exist, but signed Monopoly count delivery needs its
frozen operation and durable outbox. Until then, verified `REVEAL_COUNT` fails
before generic system policy. Every verified `STEAL_RESULT`, including a named
resource, also fails until Step 5 proves the beacon-selected sealed transfer.
Missing other-owner trade proofs return a distinct failure; their delivery is
required alongside hidden transfers.

The new driver accepts an optional hand source because currently reachable public
spending is covered by exact public minima. A required private proof without that
source fails; it never borrows a voting key or deck lock. Count delivery will need
the source for each owned contributing seat.

Protocol version remains 1 during this unpublished verified-mode integration.
Missing ledger snapshots fail closed and fresh certified replay derives the new
ledger. Compatibility with old verified consensus journals or mixed-version
peers is not promised. Revisit the protocol version before public online release.
Local saved games and their engine state hashes are unchanged. The extra ledger
validation changes draw-path work; the earlier Step 3 timings are not a current
latency guarantee. Remeasure that target after the resource integration is complete.
