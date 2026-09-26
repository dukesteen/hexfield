# Committed hands design review response

The [read-only review](step4-design-review.md) used the exact 21-file packet in
the [manifest](step4-design-review-manifest.json). It reviewed a proposal rather
than completed code. The [revised plan](step4-integration-plan.md) incorporates
the following requirements before implementation.

- Require effects on all transitions and propagate them through engine helpers.
  Validate their conservation against public totals, bank counts, exact bounds
  and slot changes. This catches forgotten handler or hook effects without
  guessing missing movements from bounds.
- Fold resources for every applied input, including handled beacon/deck system
  entries. Share the command verdict between admission, voting and accusations.
- Permit a verified exact count reveal to establish the following monopoly debit.
  A requested zero count still needs proof. Credits cannot finance promised
  outgoing cards in the same base action.
- Reject all verified steals, including a named resource, until the hidden-transfer
  protocol is implemented. Add mandatory count evidence and exact proof-section
  requirements. Derive slot-reveal obligations from engine effects.
- Validate empty genesis hands and preserve the required hand ledger whenever
  rebuilding `CryptoContext`.
- Freeze a monopoly reveal operation, so earlier victims and proposer controls
  do not stale later victims' contributions. Check unchanged victim commitments
  at inclusion and consume each requested victim once.
- Recognize counter-offer consent as well as accepted active-player offers.
  Scope trade proof requests to the actual legal finalizer and complete command,
  with bounded distinct requests at one parent.

Asynchronous command preparation needs a seat reservation and lifecycle, parent,
nonce and key checks after waiting. The current synchronous path will stay until
trade-proof delivery is implemented alongside Step 5. Pure resource verifiers and
fail-closed missing-proof behavior can be tested first. This avoids adding an
asynchronous network path before hidden transfers make it reachable in a legal
game. The delivery work remains required for Stage 07 acceptance.

The review's robber concern does not require replacing randomness. Existing deck
integration tests use real beacon outcomes and choose a legal robber destination
without a victim. The same approach can support bounded resource-accounting
segments; a forced steal ends the segment until Step 5 is ready.

Outgoing data will retain the project's durable outbox policy. Deterministic
reconstruction is useful for recovery but does not replace immutable outgoing
records or the existing fail-closed storage lifecycle.
