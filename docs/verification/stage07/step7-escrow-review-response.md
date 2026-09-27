# Escrow review response

The [initial review](step7-escrow-review.md) covered the immutable roster,
distribution, aggregate genesis validation and revealed-master key consistency.
It did not cover a live ceremony or authorize recovery.

- D1: envelopes now reject identity coefficient commitments. Honest derivation
  already produces nonzero coefficients. A dealer-signed reduced-degree
  regression is rejected before acknowledgement.
- D2: creation, envelope verification, holder acceptance and ACK verification
  now validate the master manifest and require the caller's expected key to
  equal the dealer's manifest entry. Supplying a matching attacker-selected key
  and scalar cannot bypass that check.
- D3: `fromBase64Url` already checks canonical encoding. Master point validation
  also makes decode/re-encode equality explicit. The regression changes only the
  padding bits in a 43-character key, preserving the schema length, and checks
  both the codec and manifest rejection. Identity points are rejected too.
- D4: aggregate verification first checks all dealer/holder layouts and shared
  polynomials. It then reuses a detached private context for signature/proof/ACK
  checks. It does not reparse the whole genesis for each delivery. A mixed
  polynomial is rejected before even an earlier forged signature is checked;
  mutation of the caller's draft cannot change a prepared verifier's context.

The added dispute helper authenticates the exact dealer-signed ciphertext and
sender ephemeral-key proof before computing any disclosed shared point. The
holder's signed complaint carries a DLEQ. Acceptance and complaint verification
share one plaintext/hash/Feldman validator. Focused cases cover a bad
share, signed hash mismatch, wrong holder payload, malformed plaintext,
noncanonical scalar, a valid share with a false complaint, forged signatures or
DLEQ, copied ephemeral points and complete proofs, and plaintext-buffer clearing.

The [follow-up review](step7-escrow-followup-review.md) confirmed D1 through D4
and found a caller-supplied DLEQ nonce seed. The helper now derives that seed
privately from the holder's encryption scalar and complete envelope binding,
then clears temporary bytes. Retrying the same dispute produces identical
proofs; another delivery uses a distinct nonce context. The degree-deficient
regression now uses a valid reduced-degree opening, fresh sealing proof and
signature, and asserts the coefficient-specific rejection.

Verification uses a detached genesis and returns a typed bad-share or
false-complaint verdict only after authenticating the holder and decryption
point. Tests cover forged dealer and holder signatures, wrong dealer/recipient
bindings and inherited caller array methods. Invalid evidence attributes no
misconduct. Both successful outcomes expose a share and require retirement of
all local masters in that ceremony.

C1 and C2 now have a lifecycle wrapper requiring all original human approvals,
private master-derived retry entropy and atomic device-global reservation. Abort
creates a permanent ceremony tombstone and retires all local dealing masters in
one transaction. Tests cover competing ceremonies, abort before reservation,
reserve/abort races, failed writes and replay-identical envelopes. A false
complaint also triggers retirement, while invalid signatures/proofs do not.
The browser storage adapter and network ceremony are still unimplemented.

C3 through C6 remain activation requirements: verify the current beacon chain,
reconstruct every private hand opening, distinguish seat-key violations from
bad context or reconstruction inputs, and authenticate released shares against
the original transcript before interpolation. The current master checker is
only the original key-consistency check and cannot itself authorize or activate
recovery.
