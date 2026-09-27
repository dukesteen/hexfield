# Follow-up review: zero-scalar timing mitigation (`group.ts`, `range.ts`)

I reviewed only the pasted source; tools were disabled for this pass. I ran no tests or benchmarks, and I could not see Noble's installed source, `cds.js`, `sigma.js` or `proof-transcript.js`. Any claim below about Noble internals comes from my knowledge of Noble 2.x and should be checked against the pinned version.

## Verdict

Both first-round findings are fixed at the level of this code's own group operations:

- **`pedersenCommit`**: the algebra is exact at every canonical scalar. The operation count is fixed for every valid input. No identity intermediate appears before the final output unless someone knows log_G(H).
- **`prepareBit`**: the point operations no longer depend on the bit.

What remains:

- JS-level residuals: a reference select on the bit, table-index memory access, and BigInt/string timing.
- A larger possible leak in the CDS composition, outside this change, which needs `cds.js` to confirm.

None of this is a browser constant-time guarantee.

## 1. Algebra of `zeroSafeProductTerms`

Let `h = ⌊s/2⌋ + 1` and `c = 2 − (s & 1)`. The positive term is `2h·P`.

| s parity | 2h    | c   | 2h − c |
| -------- | ----- | --- | ------ |
| even     | s + 2 | 2   | s      |
| odd      | s + 1 | 1   | s      |

The difference is exact over the integers, so it is exact mod ℓ.

**Scalar boundaries.** ℓ is odd.

- `s = ℓ−1` is even. Then `h = (ℓ+1)/2`, which is below ℓ and nonzero. The positive term is (ℓ+1)P = P, and P − 2P = −P. Correct.
- `s = ℓ−2` is odd. Then `h = (ℓ−1)/2`, so the positive term is (ℓ−1)P = −P, and −P − P = −2P. Correct.
- `s = 0`: h = 1, c = 2, giving 2P − 2P. `s = 1`: h = 1, c = 1, giving 2P − P.

So every multiplier lies in [1, (ℓ+1)/2] ∪ {1, 2}. That satisfies Noble's `1 ≤ k < ℓ` requirement for `multiply`, and no call can throw or take a zero path.

The effective positive coefficient, 2h mod ℓ, is never 0:

- s + 2 ≡ 0 would need s = ℓ−2, but that value is odd and takes the s + 1 row.
- s + 1 ≡ 0 would need s = ℓ−1, but that value is even and takes the s + 2 row.

For non-identity P, neither returned term is ever the identity. Input validation rejects non-bigints, negatives and values ≥ ℓ. `pedersenCommit` also runs `scalarToBytes` first, which is redundant; see §6.

## 2. Operation count and identity intermediates in `pedersenCommit`

**Fixed work for every canonical `(v, r)`:**

- 2 × `G.multiply` using the BASE table.
- 2 × `H.multiply` using the W=8 table.
- 2 × `double`, 1 × `add`, 2 × `subtract`, 1 × `toBytes`.
- There are no scalar-dependent branches in this code.

**Intermediates.** Let a = 2h_v mod ℓ and b = 2h_r mod ℓ. Both are nonzero, as shown in §1.

1. `aG + bH`: this is the identity only if aG = −bH, which would expose log_G(H). H comes from hash-to-curve, so this is negligible.
2. `… − c_v·G = vG + bH`:
   - v = 0 gives bH, which is not the identity.
   - v ≠ 0 would again need a discrete-log relation.
3. `… − c_r·H = vG + rH`: this is the output. It is the identity only when v = r = 0, and the output is public anyway.

So zero count, zero bit or zero blinding no longer produces an identity intermediate at this layer.

**Residual inside Noble.** The wNAF accumulator starts at `ZERO` for every scalar. It stays there until the first nonzero window. The first `ZERO.add(Q)` works on coordinates (0, 1, 1, 0), and BigInt multiplication by 0n or 1n is cheaper. That reveals the index of the lowest nonzero window. This is the same for all scalars, a general Noble property and not specific to zero:

- For counts, h is in 1..32, so window 0 is always nonzero and the path is uniform.
- For uniform blindings, window 0 is zero with probability about 1/256.

## 3. Bit dependence in `prepareBit`

**Point operations are bit-independent.** The sequence is always:

- `decodePoint`
- `pedersenCommit(BigInt(bit), r)`. For both bits h_v = 1, so the positive term is always `G.multiply(1).double()`.
- `target − G`
- honest `H·nonce`, then false `H·z′ − falseTarget·e′`

Both candidates for `falseTarget` are freshly decoded, uncached points, so they take the same W=1 Noble path. `scalePoint`'s `is0()` short-circuit is evaluated identically for both. Its `scalar === 0n` exit fires only for derived nonces equal to 0, which has probability about 2⁻²⁵².

**What still depends on the bit:**

1. **Reference selections.** These are:
   - `bit === 0 ? shiftedTarget : target`
   - the announcement order ternary
   - the challenge/response order ternaries in `respond`

   Each one moves a reference with no extra group work. This is a real control-flow or cmov dependence, but it is below practical JS observability. JS has no constant-time select, so I class this as a residual, not a defect.

2. **Correction multiplier.** `c_v` is 2 for bit 0 and 1 for bit 1. The operation count is the same, but it is a different entry in the G precompute table, so the memory access pattern differs. Noble's wNAF digit lookup has the same property for every secret scalar. It is a residual limit, not something this change introduced.
3. **`proveBit` guard.** `bit !== 0 && bit !== 1` does one comparison for 0 and two for 1. This is trivial.
4. **`modScalar(challenge − falseChallenge)` branch.** The `< 0n` branch is not bit-leaking. If e₀ + e₁ = c, neither ordering wraps. If e₀ + e₁ = c + ℓ, both orderings wrap. So the outcome is fixed by public values.
5. **Scalar arithmetic.** `nonce + e·r` and the `%` reduction use magnitude-dependent BigInt timing on secrets. This is a residual.

## 4. Transcript and soundness

- **Output bytes.** `pedersenCommit` returns the canonical Ristretto encoding of the same element vG + rH. `falseTarget` is the same element as before, and all nonce derivations are unchanged. So the commitments, announcements and proofs should be byte-identical to the previous code. The pinned `b1e86a98…` hash and the protocol v6 fixtures should still hold. This is an algebraic expectation, not an observed test result.
- **Soundness.** No verifier path changed: `inspectBitProof`, `inspectRangeProof`, `verifyRange` and `verifyHiddenTransfer` are untouched. The prover still self-checks its opening. The proof distribution is unchanged, so zero-knowledge is unaffected.
- **Transcript binding.** It depends on `proofChallenge` and `proofNonce`, which I did not see.

## 5. Concrete remaining issues

1. **Possible CDS branch-position leak.** This is the most significant remaining issue, and it is outside this change.
   - In the composition the tests reproduce, the real index branch runs `prepareSchnorrProof` + `prepareRangeProof`. For 6 bits that is roughly 70 multiplications: 1 + 6 + 6 `pedersenCommit` calls at 4 each, plus 3 per bit.
   - Each simulated branch runs `simulateRangeProof`, which is roughly 12 multiplications and does no per-bit point work.
   - Total proof time is the same for any `selected`, because there is always one real branch and m−1 simulated ones.
   - The _position_ of the expensive branch is visible to anything with sub-proof timing resolution: long-task timing, cooperative yields, profiling, or a compromised same-origin script. That position is the secret resource type.
   - To fix it, give each branch identical work. One option is to always run prepare-shaped work and discard it. Another is to compute per-branch announcements via a fixed-cost inspection in both cases.
   - This needs a review of `cds.js` to confirm.
2. **`proveHiddenTransfer` branches on secret counts.** Two examples are `index >= prefix && index < prefix + count` and `at === selected ? 1 : 0`. These are small control-flow leaks of `selected`, of the same class as §3.1.
3. **`scalarToBytes(value)` / `scalarToBytes(blinding)` in `pedersenCommit`.**
   - These are validation-only; the results are discarded.
   - They run `toString(16)`, `padStart` and hex parsing on secrets.
   - The length of the hex string depends on magnitude, which separates counts 0–15 from 16–63.
   - `zeroSafeProductTerms` already enforces canonical range, so these calls can be removed.
4. **Unseen callers of `scalePoint`.** It is still zero-branching. Any caller in `sigma.js`, `cds.js`, `apps/web` or `tools/sim` that passes a secret scalar which can legally be zero reintroduces the original leak. I could not audit those callers.

## 6. Residual limits (not defects)

- **What the mitigation provides.** It equalises the operation count at the level of this code's own group operations. It does not make the code constant-time in JS or the browser.
- **Why constant-time is out of reach:**
  - V8 BigInt operations are variable-time by limb count and value, for example 0n or 1n operands and `%`.
  - Precompute table indexing is secret-dependent memory access.
  - Noble's `calcOffsets` carry branch depends on the scalar.
  - JIT tiering, deoptimisation and GC add noise and can create data-dependent shapes.
  - Noble documents that it gives no constant-time guarantee under JS.
- **Performance.** `pedersenCommit` now costs 4 multiplications instead of about 2. `prepareRange` calls it 1 + 2·bits times, so prover cost rises noticeably.
- **Nothing is measured in Chrome yet.** A dudect-style fixed-vs-random harness would check this empirically. Useful classes:
  - count 0 vs random count
  - bit 0 vs bit 1 in `prepareBit`
  - `selected` position in the hidden-transfer proof

## 7. Test gaps

- `pedersenCommit(0n, 0n)` should equal the all-zero identity encoding.
- `pedersenCommit` at (ℓ−1, ℓ−1) and (ℓ−2, 1) should match `scalePoint(G, v).add(scalePoint(H, r))`.
- A pinned byte vector covering a zero count, and ideally a zero last-bit blinding. The pinned hash only covers the 8-type case with nonzero counts.
- A `prepareBit` test asserting identical announcement and response bytes against the pre-change implementation for both bits.
