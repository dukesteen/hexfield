# Deck foundation review response

The [first review](step3-foundation-review.md) checked the exact files in its
[manifest](step3-foundation-review-manifest.json). This response describes the
subsequent corrections. It does not mark Step 3 or Stage 07 accepted.

- H1: `prepareDeckUnlock` takes a verified setup and strict draw request, then
  derives the initial point and participant keys locally. Before returning or
  signing, every local participant reserves `(deckSetupId, position, seat)` for
  the complete operation ID. This includes the drawer and seats waiting for
  their unlock turn. The key matches the definition used to derive position
  secrets; the stored operation ID also binds the final locked setup. A
  conflicting reservation fails without reading secrets. The signed unlock
  uses the same position key and must match the frozen operation on retry.
  Tests cover changed drawers, slots and parents, corrupt reservations,
  concurrent writers, missing winners, and an attempted raw-operation injection.
- H2: `prepareDeckPass` persists one signed pass per deck definition, seat and
  phase. A different preceding setup state under that key fails verification.
  A concurrent losing writer returns only a verified stored winner. Tests use
  competing valid shuffle histories and write failures. Deterministic setup
  secrets must never be used outside this guard in the eventual coordinator.
- M1: Re-signed unlock evidence with a changed operation now reaches and fails
  `deck-unlock-proof`. Setup negatives assert proof, operation, point and key
  errors, including substituted locking outputs. A separate forged shuffle
  constructs all bit-1 openings for a false output and verifies that the actual
  Fiat-Shamir challenge rejects the guessed bits. This proof is constructed
  independently of the honest prover. For one forged commitment, the test
  checks all 24 possible permutations and shows none can answer bit 0 with
  the scalar fixed by its public commitment. Removing the final challenge
  comparison makes the forgery test fail.
- M2: A fresh secret provider and empty store reproduce an identical signed
  setup pass. A real factory-based setup, durable draw and recreated owner
  provider decode the physical identity predicted by independently composed
  permutations. A second fixture checks the exact identity at every position.
- M3: Decoding and reveal verification use only the validated setup copy.
  A proxy regression reproduced the old incorrect card-kind lookup and now
  checks both paths against the canonical card table.
- M4: Repeated validation remains bounded but expensive. Verified receipt
  storage and avoiding redundant work belong to the next certified-log
  integration. The measured Chromium worker target remains unmet.
- Reveal context now requires a parent strictly later than the draw anchor.
  The setup hash has the `cp2p/v1/locked-deck` domain tag. Setup proof contexts
  already bind their domain-separated operation ID.

The coordinator still must compare the deck catalogue and roster to genesis,
tie ceremony setup to that genesis, derive the request from certified pending,
consume positions exactly once in the replicated ledger, and check owned-slot
reveal proofs before votes. The durable guards supplement those checks. They
cannot make an unverified peer-provided setup authoritative.

The unlock outbox still uses one storage-failure error code for reads and writes;
both fail closed before returning a contribution. Separate diagnostics are not
required for the safety correction. Setup outbox errors already distinguish them.

## Follow-up correction

The [follow-up review](step3-foundation-followup-review.md) confirmed H2 and M3,
but found that keying reservations by the final setup hash did not match the
definition-based secret derivation. A malicious last locker can produce two
valid setups differing at another position. The definition-based reservation
above prevents both histories from using the same position secrets. The final
regression reproduces that pair of valid histories before asserting rejection.

The unlock helper also checks a copied signing key before any storage access,
including for the drawer and waiting seats. A wrong local key cannot consume
another seat's reservation. Tests assert no writes on that path and rejection
of a concurrent winning unlock that is validly signed for another operation.

Durability remains a coordinator requirement. Restoring a master while losing its
outbox can reuse secrets against another history; the master and contribution
records must share a durable lifecycle. The drawer must reserve its position
before decoding. Only certified pending authorizes that reservation.

The [final correction review](step3-reservation-review.md) confirms that every
follow-up finding is addressed within these helper contracts. It also confirms
the opposite-challenge shuffle test. No proof algorithm or soundness parameter
changed. Its remaining low notes concern storage-error diagnostics and the
typed, caller-local setup signing key: passing a non-byte key to
`prepareDeckPass` can reject its promise instead of returning a `Result`.
Production callers must supply their retained `Uint8Array` signing key.
