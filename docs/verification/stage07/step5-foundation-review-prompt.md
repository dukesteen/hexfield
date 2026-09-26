# Hidden-steal proof and delivery review

Read-only security review of the attached exact source snapshot. Do not use tools,
read external files, edit code, or assume omitted integration already exists.
The attached fixture keys are deterministic test data, never real game secrets.

## Scope

This implements the pure proof and private-delivery part of Stage 07 Step 5.
The existing log still rejects verified `STEAL_RESULT`. Freezing operations from
the beacon, certifying `STEAL_FIXED`, durable peer delivery, certified disputes,
public/private hand updates, and recovery are the next integration work. Please
distinguish defects in this patch from those explicit missing callers.

- `hidden-transfer.ts` proves a one-hot transfer and that its resource contains
  the certified canonical index. Each branch uses the existing CDS composition
  of one Schnorr opening and two six-bit ranges under one branch challenge.
  Public dimensions are bounded to eight types. The base-game wrapper fixes five.
- `steal-delivery.ts` binds the frozen beacon entry, genesis, epoch, participant
  signing keys, recipient encryption key, hand commitments, total and index.
  Its pure operation validator checks shape, not certified origin. The upcoming
  replay layer must derive these fields from certified state.
- The victim signs the transfer, proofs and sealed opening. Public proofs bind
  the ciphertext hash. The opening uses a numeric type index and five fixed-size
  scalars, so every resource has the same ciphertext length.
- Receipt production verifies the contribution and provisionally decrypts before
  signing. It binds the later fixed entry, operation, contribution body, transfer
  and ciphertext hashes. It does not bind the moving result parent. The fixed
  entry reference must come from certified history, not a peer claim.
- A recipient can reveal the authenticated ECDH point with a DLEQ. A dispute is
  valid only if the victim's signed public proofs are valid but the decrypted
  opening fails. A good opening is not evidence against the victim. A dishonest
  recipient can deliberately sign a bad receipt and damage its own later hand;
  this remains an explicit design limitation.
- `steal-source.ts` derives the encryption scalar before the complete ceremony
  manifest exists. It binds the original signing key, seat and fresh ceremony
  nonce. The complete manifest includes the resulting public key, avoiding a
  derivation cycle. Recovery must use the original domain to retain that key.
- `genesis.ts` now requires distinct canonical nonidentity encryption keys in
  verified genesis and before consent. They sit on the roster, so deck setup
  proofs and final genesis signatures bind them. Stub games cannot claim them.
  This changes the unpublished verified format. A protocol-version/migration
  decision is still required before exposing it publicly.

## Review requests

1. Check the transfer mathematics, shared challenges, modular signs, zero counts,
   resource boundaries, totals/prefixes greater than 63, and canonical encodings.
2. Can any valid victim signature, proof, receipt or dispute be moved to another
   operation, key, sealed payload, fixed entry, or recipient? Look for cheap outer
   rejection hiding an untested inner verification bug.
3. Check privacy and source derivation: ciphertext length, scalar handling,
   deterministic retries, nonce domains, key lifetime and caller mutation.
4. Check whether honest recipients can distinguish invalid delivery from a false
   complaint without making an unauthenticated accusation.
5. Assess the focused tests. Request concrete missing attack cases, not large
   random batches. There is no current browser performance claim.

Report severity, exact file/function, a concrete exploit or failing honest trace,
and the smallest correction. State assumptions and avoid calling this a review of
the complete multiplayer protocol.
