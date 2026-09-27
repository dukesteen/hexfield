# Private-state audit at every certified sequence

Updated 2026-09-28 for protocol v6. This closes the implementation gap in exact
private-state comparison; it does not complete M-D lifecycle acceptance.

`auditCertifiedGame` now records an internal hash of each seat's full private
state from the independent `LocalGame` replay at genesis and after every
certified entry. `reconstructPrivateSeats` compares detached owner snapshots at
the same sequences. This includes entries without an engine input. The audit
fails closed on any missing or different snapshot, reports a local processing
error, and does not accuse a player. No private hashes enter reports or logs.
The two paths share engine rules but obtain and apply private inputs through
different drivers; this does not detect an identical bug in shared engine code.

The optional reconstruction verifier runs only after whole-prefix certificate
validation and master validation. Its observations remain provisional until
reconstruction succeeds. A rejected or throwing verifier returns no driver and
disposes the reconstructed owner state. Caller-owned master bytes are unchanged.
The verifier gains no access to an unrequested seat.

## Review and disposition

The source-only Claude review found no high- or medium-severity issue. Its
[brief](private-oracle-review-brief.md), [source manifest](private-oracle-review-manifest.sha256),
[input](private-oracle-review-input.md) and [raw response](private-oracle-review-raw.md)
are retained. It did not run tests. Changes following its low-severity findings:

- The transient-divergence regression now explicitly asserts that the injected
  private field is absent at the end of the omniscient replay.
- Reconstruction tests exercise rejection at genesis and at sequence 1, and a
  throwing verifier. They observe driver disposal and loss of its private seat.
  Snapshot mutation tests cover hands, slots and extension fields. Assertions
  about observed seat sets run outside the callback so errors are not disguised.
- A missing reconstructed private state preserves its failing sequence.
  Missing omniscient state has a separate local-processing error code.
- The full-game fixture records any request for a foreign master and asserts
  none occurred. Its loader only supplies the local human's and hosted bots'
  masters.
- Both audit and private-replay test fixtures now validate their real deck
  ceremony instead of supplying an always-successful commitment callback.

The review's representation concern does not justify discarding private fields:
`PrivateState` defines exactly `seat`, `hand`, `slots` and `ext`, and extensions
must have canonical encodings. Comparing all of that state is intentional. A
module that returns an invalid or noncanonical private state must fail closed.
The stored hashes are deliberately internal because low-entropy private state
could be guessed from an exposed hash.

A local discrepancy can stop reconstruction before a later private-history
violation is diagnosed. The result remains incomplete with no accusation. This
conservative failure ordering is retained.

## Validation

Node 22, focused `audit.test.ts` and `private-replay.test.ts`: **15/15 pass**,
25.76 seconds wall time. Scoped type-aware lint passes. The opt-in [full ten-point hosted-bot game](../stage09/hosted-bot-v6-acceptance.md)
now passes both human audits, covering every private state through sequence 764.
The final source hashes are in [the post-review manifest](private-oracle-final.sha256).

Remaining M-D work includes the representative departure/recovery/return
lifecycle game and its terminal audit. Focused private-state checks cannot
substitute for that trace, storage interruption cases or browser coverage.
