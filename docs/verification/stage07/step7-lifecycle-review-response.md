# Escrow lifecycle review response

The [lifecycle review](step7-lifecycle-review.md) confirmed the private complaint
nonce, detached verification context and reduced-degree polynomial rejection.
Its new L1 through L4 findings are addressed in the lifecycle wrapper.

- Distribution compares the candidate's ceremony ID with the locally frozen
  manifest before checking approvals or producing shares. Valid attacker
  approvals cannot authorize a changed player role or bot host.
- Retirement takes the validated local manifest, derives its ceremony ID and
  tombstones every previously unreserved master. A changed ceremony nonce does
  not make an aborted master reusable. Existing foreign reservations stay intact.
- Retired reservations drop cached envelopes. Admission keeps at least 64 KiB
  free and allocates 2 KiB per active ceremony for retirement. Retirement may
  consume its own allocation, while preserving the allocation for remaining
  active ceremonies. Array limits also reserve the corresponding tombstone slots.
- Authenticated bad-share and false-complaint verdicts require durable retirement
  first. A failed compare-and-swap returns no verdict. Repeated retirement makes
  no additional write. Dispute verification uses the already checked manifest
  copy after comparing it with the local pin.

The focused lifecycle suite passes 12 tests, including role substitution with
valid attacker approvals, concurrent reservation and abort, reuse after abort,
registry size boundaries and storage failure. The complaint suite includes an
attack that recovers a key from a public DLEQ nonce; that attack fails against
the production private nonce derivation.

Aggregate checks admit a real four-human deck and escrow transcript and reject
a freshly re-signed genesis with one forged holder ACK before application policy
runs. A non-empty transcript with fewer than four humans is rejected. Direct
five-seat transcript checks include a bot dealer; the base engine currently
permits at most four seats, so no five-seat engine admission is claimed.

L5 remains an integration requirement. The future holder ACK outbox, genesis
consent and delivery layer must consult the retirement record before signing or
sending. A previously returned envelope is not a continuing authorization.
Completion must discard cached envelopes only after validating certified genesis,
without erasing the permanent master binding. Browser transactions, live ceremony
delivery, authorized recovery, replacement activation and full audit are unfinished.
