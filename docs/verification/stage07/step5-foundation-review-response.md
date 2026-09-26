# Hidden-steal foundation review response

The [Claude review](step5-foundation-review.md) covers the 25 files in the
[review manifest](step5-foundation-review-manifest.json). The packet SHA-256 is
`6a47fcaba35e47d51459ea5af32410d3553a8bf47f30025fe86839b2af59fcab`.
Claude had no tools, local customizations or session persistence. It received
source and deterministic fixture keys, with no actual game secrets. The user
authorized all Claude reviews earlier in this session.

The reviewer found no transfer-proof soundness or privacy break. This review
does not accept Stage 07 or cover the unfinished certified steal lifecycle.

## Corrections

- M1: Receipt validation now checks the schema, exact fixed binding and recipient
  signature before the full transfer proof. Dispute validation also authenticates
  its DLEQ before that proof. The pure API still verifies the contribution for
  valid requests, since a caller-supplied `FixedSteal` is not itself a certificate.
  Spy regressions show six malformed, wrong-binding or wrong-signature requests
  make no transfer-verifier calls; a valid receipt and valid dispute each make one.
  Integration must retain bounded deduplication and certified-state authority.
- L2: The contribution producer now copies counts and blindings once through
  strict schemas and uses those copies for the opening check and witness.
- The hidden-transfer verifier documents its prerequisite: certified accounting
  has already established small nonnegative committed counts and their public
  total. The proof cannot establish that prerequisite for arbitrary commitments.
- Source documentation names the original genesis signing identity as part of
  the encryption-key derivation domain. Recovery must preserve it after a voting
  key replacement and compare the derived encryption key with genesis.

## Conditional finding checked against source

M2 assumes the base64 decoder might accept aliases with nonzero spare bits.
`packages/codec/src/canonical.ts` rejects them by re-encoding the decoded bytes.
Its `canonicalDecode` also compares the complete encoded bytes with the input.
`decodeScalar` and `decodePoint` use that strict base64 decoder. The reported
alias attack therefore fails before opening acceptance. Focused regressions now
exercise those noncanonical encodings through the operation and sealed payload
paths. No permissive decoder or new encoding format was introduced.

## Test corrections

The delivery tests now re-sign a changed operation ID while retaining an old
proof and assert the inner proof failure. They authenticate a wrong-key receipt,
try a valid DLEQ for a different encryption secret, replay a valid dispute under
a different fixed entry, and retain the genuine signed bad-opening case. The
ciphertext-length test now produces and opens an actual contribution for each
of the five resources. Genesis tests cover missing bot keys and shared human/bot
keys as well as human-key failures.

The added CDS attack constructs a zero-count branch with a genuine opening and
upper range but a simulated impossible lower range. The individual equations pass
at the chosen shared challenge; the complete Fiat-Shamir composition rejects it.
This supplements the existing wrong-resource and mutated-challenge cases.

The exact production and test changes above postdate the review packet. Final
checks cover the resulting source separately; the packet manifest remains an
accurate record of what Claude reviewed.

## Integration boundaries

- L1: A valid receipt and a valid complaint can both be signed by a dishonest
  thief for bad delivery. Certified ordering must decide the outcome. A dispute
  recorded before the transfer blocks it; a result that is already certified is
  not rolled back. These pure helpers do not decide ordering.
- A failed dispute `Result` alone is not accusation evidence. A future
  false-complaint accusation must authenticate the full signed operation and
  distinguish invalid transport data from attributable misconduct. No current
  caller converts these error codes into a cheating verdict.
- The replay layer must derive both operation and fixed-entry references from
  certified history, preserve the original beacon index, and permit the hidden
  engine effect only after a matching receipt. The current verified log still
  rejects every steal.
- Durable contribution/receipt retries, private hand updates, trade proofs for
  uncertain counterparties, escrow and audit are still required. A bare pure
  helper is not a completed peer protocol.
- The new encryption-key roster is mandatory in the unpublished verified
  format. Protocol-version and migration handling remain release requirements.
- The 300 ms eight-type Chromium target is unverified. Contended Node diagnostics
  measured 849–931 ms without precomputation. A private-process static-generator
  experiment measured 542–561 ms with window eight, but no production cache change
  or browser performance acceptance follows from those figures.
