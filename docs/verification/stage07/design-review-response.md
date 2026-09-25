# Stage 07 design review response

The [Claude review](design-review.md) used the published stage design and the
[self-contained review brief](design-review-prompt.md). Tool access, local
customizations and session persistence were disabled. The review completed before
Stage 06 acceptance. Stage 07 implementation began only after the
[Stage 06 CI gate](../stage06/ci-acceptance.md) passed.

This is a design review, not acceptance of the cryptographic implementation.
Implementation review, worker timings, adversarial games and integration checks
remain required.

## Accepted corrections

- Setup uses a signed frozen manifest and `ceremonyId`. Setup artifacts bind this
  ID; final genesis commits to the complete transcript. A final digest cannot be
  used to construct artifacts that it includes.
- A certified request freezes participants, key versions, indices and ordering.
  Existing engine commands can anchor these operations. Long-lived contributions
  bind this fixed anchor, while ordinary commands still bind the current parent.
  Recovery continues a fixed outcome rather than selecting another one.
- Hidden delivery is checked before engine effects. A certified `STEAL_FIXED`
  contribution precedes a recipient receipt, then the result commits. The receipt
  binds the fixed contribution and ciphertext, avoiding a circular final-entry
  hash. A dispute must authenticate the shared point and demonstrate an invalid
  opening. A good opening is not a valid complaint. A dishonest recipient can
  still acknowledge unusable bytes and harm its own private state.
- Pure replayable crypto state accompanies the engine state. Typed crypto entries
  can advance it without engine effects. Proof preparation precedes command
  signing, and private effects receive the certified evidence.
- Engine-owned resource effects preserve exact ordered debits and credits. UI
  events, normalized bounds and net balance changes are insufficient. A player
  trade checks both owners' affordability at the current parent; an extra owner
  proof is needed only when public bounds cannot establish that owner's debit.
- Derivation binds the deck creation operation and epoch. Proof nonces bind the
  complete statement and context; a retry uses identical persisted bytes.
- Original independent human devices determine escrow holders. A bot excludes
  its host from holders and adds no independent holder. Multiple absent holders
  can prevent recovery despite an ordering quorum. The old quorum authorizes
  disclosure before a later certificate activates recovery.
- Missing secrets mean an incomplete audit, never `ok: true`. The audit
  coordinator continues after the engine has a result.
- The online protocol, engine and crypto will run together in a worker. Verify
  context and bounded dimensions before expensive proofs; bound the work queue
  and any caches. Worker isolation alone does not prevent denial of service.

## Findings requiring qualification

The review's B1 claim that six bits cannot cover a large resource prefix is
incorrect. In the true branch, both distances are between zero and `n_r − 1`.
The per-type maximum of 24 fits six bits regardless of the total or prefix.
The [exhaustive check](range-bound-check.json) covers 7,680 small-hand/index cases
and every index in a 120-card maximal hand. A module increasing the per-type cap
must supply the appropriate width.

B5 describes pre-genesis board selection, not a reroll after consent. Public
boards may already be fixed by configuration. The design now states the limit
explicitly and requires fresh secrets on aborted ceremony attempts. Moving board
creation after genesis would be a separate product and engine change.

A bit proof for every transfer component and an opening of `sum(T) − G` prove
that `T` is one-hot under the Pedersen binding assumption. The selected type
branch only needs an opening of `T_r − G` plus its two range statements, all
bound to the same `T`. Proving every other component again inside that branch
is unnecessary. However, the ranges must compose at the Sigma-protocol level.
Independent Fiat–Shamir proofs under an outer OR do not provide that composition.

Web Locks only protect writers on one device. Cross-device activation still
requires certified key replacement. Neither a local counter nor an imported
old save proves that a retired voting key can safely resume.

Authenticated encryption would authenticate bytes, not prove the claimed card
identity. The delivery receipt and opening check remain necessary. The planned
ECDH/HKDF delivery depends on the signed envelope and semantic opening check.

No alternative "live humans" quorum bypasses certified membership. A missing
escrow holder may stall play. Likewise, a canonical transcript hash suffices for
bounded setup; a Merkle tree is not required without partial-transcript proofs.

## Compact shuffle representation

An independent Sol review checked both directions of equivalence with the
explicit 64-round proof. Use exactly eight challenge bytes, MSB first, and
exactly 64 scalar/permutation responses. With old-index-to-new-index permutations,
`(σX)_j = X_{σ⁻¹(j)}`. Bit 0 reconstructs `R=rG`,
`Y_j=r·in_{ρ⁻¹(j)}`. Bit 1 reconstructs `R=u⁻¹A`,
`Y_j=u⁻¹·out_{τ(j)}`. Rehash every reconstructed commitment with the complete
statement and context and compare all eight challenge bytes.

The compact form retains the same 64-bit per-proof soundness bound. It reduces
wire size, not the number of group operations. Tests must cover non-involutive
permutations, mutations and explicit/compact equivalence. No browser performance
claim is made until the required worker benchmark passes.

## Reference material

The group encoding follows [RFC 9496](https://www.rfc-editor.org/rfc/rfc9496.html).
Composition was checked against the
[CDS paper](https://people.csail.mit.edu/rivest/voting/papers/CramerDamgardSchoenmakers-ProofsOfPartialKnowledge.pdf).
The [CFRG Sigma draft 03](https://www.ietf.org/ietf-ftp/internet-drafts/draft-irtf-cfrg-sigma-protocols-03.html)
was used as a reference for linear relations; it is a draft, not a final standard.
