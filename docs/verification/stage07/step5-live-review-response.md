# Certified hidden-steal review response

The [initial review](step5-live-review.md) assessed the exact 26-file snapshot in
the [manifest](step5-live-review-manifest.json). Its packet contained 457,287 bytes
and had SHA-256
`11659f29c0e85a667f6012784c5b529d4f0adedc7ec6540437f1b6e1c35c39ee`.
It ran with tools, MCP servers, browser access and persistent sessions disabled.

## H1: Chosen encryption point exposed an earlier shared secret

Reproduced. A malicious victim could copy an earlier ephemeral point, sign a new
garbage ciphertext with a valid transfer proof, and induce an honest recipient to
publish the same shared point in a dispute. That point decrypts the earlier
payload, exposing another stolen resource and its transfer blindings.

Every victim contribution now includes a Schnorr proof of knowledge of its
ephemeral scalar. `sealWithEphemeralProof` keeps that scalar inside the crypto
helper. Verification binds the recipient, exact ephemeral and ciphertext, seal
context, operation and transfer; it runs after the victim signature and before
the expensive transfer check. The regression retains a valid signed transfer
proof while transplanting the earlier point/proof and rejects it at the new
knowledge check. Genuine bad-opening complaints still work.

A global point-reuse registry is unnecessary for this attack: someone who knows
the scalar can already compute the same shared point from the public recipient
key. A proof copied from another operation or ciphertext cannot authenticate
knowledge under the new transcript. The existing `seal` derivation and output
remain unchanged; the unpublished signed steal envelope gains a required field.

## M1: Retry pulses repeated proof work

The replica now retains the encoded outgoing message after immutable persistence
and successful verification. A retry sends those same bytes without loading the
store or regenerating/verifying the proof. Stage changes and disposal clear this
process-local cache. Restore still loads and validates the durable record. Failed
transport sends retain the already-persisted message for retry.

## M2: Repeated public transfer verification

Use a bounded cache of successful pure transfer checks keyed by the complete
statement, proof and context. It retains hashes only. Canonical parsing, sender
signatures, ephemeral knowledge, certified operation binding, ordering and private
opening checks remain mandatory. No unchecked or implicitly trusted fixed-entry
API was introduced. The standalone crypto verifier stays uncached, so its browser
performance requirement remains meaningful and open.

A genuine recipient signature and shared-point DLEQ are checked before the
dispute opening. A good opening rejects the complaint before another transfer
check. Acceptance of bad delivery still requires the victim's entire valid
contribution.

## L1/L2 and startup review

Stored dispute metadata now matches the full receipt binding of its fixed
contribution. A regression transplants its fixed-entry hash and rejects the
context. The shared log receipt check and hand fold both use validated metadata.
The live test's separate memory store instances deliberately share the same
immutable key/bytes interface for deck and steal delivery.

The parallel implementation review also found that callback presence alone did
not prove a configured local secret source. Session startup now checks every
owned encryption source against its original genesis key before journal use.
Missing/mismatched sources and raw callback overrides are covered by startup
tests.

## Follow-up verification

The [follow-up review](step5-live-fixes-review.md) confirms that the ephemeral
knowledge proof closes the reproduced disclosure attack. It found no concrete
high or medium defect in its attached code. Its exact snapshot is recorded in the
[fix manifest](step5-live-fixes-review-manifest.json).

Its conditional concern was another protocol publishing a shared point under the
same genesis encryption key. A source audit found no second implemented path.
Deck partial decryption uses separately derived deck-lock secrets. Private steal
decryption does not publish its shared point. The sole public disclosure is
`createStealDispute`, which verifies the signed contribution and ephemeral proof
before computing the response. Future escrow or delivery protocols must preserve
this condition or use separate keys. The seal API now documents private seeds and
sender, recipient and operation binding.

The suggested accessor-based cache attack does not apply: `hashValue` calls the
codec's descriptor-only canonical encoder, which rejects accessors without
invoking them. A regression warms the cache and then confirms accessor-backed
proofs reject without reading the getter or calling the crypto verifier. No
extra encode/decode pass is needed.

The stored fixed-entry finding was reproduced and corrected. Validation now
schema-parses its entry reference and explicitly reconstructs the fixed value,
dropping unrelated fields. Tests cover missing and invalid references without
throws, and a genuine receipt against the normalized result. The shared log uses
the validated crypto state for both receipt verification and the hand fold.

Additional regressions refuse dispute creation for a forged ephemeral proof,
reject an unchanged ciphertext/proof copied across operations, and reject a
changed ciphertext with a valid new ephemeral proof but the old transfer proof.

The intermediate 847-test run overlapped the tail of source corrections and is
not final frozen-source evidence. The next complete run passed 850 tests in 149
files, with one opt-in benchmark skipped, in 188.35 seconds. Its 254-file source
fingerprint was `2c45ca296a0772240404ce3d9775a80d5661a0939c14c47364f789279486780b`,
unchanged during the run. A final check after the small follow-up corrections is
recorded in the [local checkpoint](step5-live-local-checks.md).
