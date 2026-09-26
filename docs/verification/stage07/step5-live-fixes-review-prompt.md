# Hidden-steal review fixes

Read-only review of the attached exact files. Do not use tools or external files.
All keys in the tests are deterministic fixture data.

The prior review found a static-DH privacy attack: a malicious victim could copy
an earlier ciphertext's ephemeral point, certify a new garbage ciphertext with a
valid transfer proof, then induce an honest recipient to reveal the shared point
in a dispute. That shared point decrypts the earlier ciphertext. The attack was
reproduced before this fix.

Contributions now require an ephemeral Schnorr proof of knowledge, checked after
the victim signature and before the heavy transfer proof. The new helper seals
and proves knowledge of the same scalar. Its transcript binds the recipient,
exact sealed payload, seal context and full steal proof context. A test copies an
earlier point and proof into a newly signed, otherwise valid transfer. Existing
seal output and derivations must remain unchanged.

Review whether this closes the chosen-point dispute oracle, including copied
proofs, altered ciphertexts, seed/nonce reuse, malformed points and other protocol
uses of the same recipient key. A replay registry is deliberately omitted: an
attacker that knows r can already compute rE for a reused point. Challenge that
reasoning if there is a concrete counterexample.

The protocol now memoizes only successful pure transfer verifications using a
bounded set of complete statement/proof/context hashes. Signature, ephemeral
proof, operation binding, state ordering and private-opening checks still run.
The standalone crypto verifier remains uncached. Check that this optimization
cannot accept a changed statement or bypass authority. The dispute verifier now
rejects an authenticated good opening before repeated transfer verification.

The stored dispute must also match its fixed contribution's full receipt binding.
The log uses the validated cryptographic state for both receipt verification and
the subsequent hand fold.

Please focus on these fixes and report concrete remaining defects with severity
and failing traces. This is not a complete multiplayer acceptance review. Network
retry caching is checked separately with live tests; WebRTC, escrow, audit and
browser performance acceptance remain unfinished.
