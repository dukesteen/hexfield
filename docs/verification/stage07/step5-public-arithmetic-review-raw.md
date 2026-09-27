# Review: `scalePublicPoint` hidden-transfer optimization

I reviewed the source text only. I did not run any tests.

## Findings

### 1. Proven flaw: the prover's timing now depends on the secret known branch

**Where:** `proveCdsOr` → `inspectBranch` → `inspectSchnorrProof`, `inspectRangeProof` and `inspectBitProof` (`cds.ts`, `sigma.ts`, `range.ts`).

**Timing impact:**
- The prover calls `inspectBranch` only for the non-`knownBranch` branches, before it computes the Fiat–Shamir challenge.
- After this patch, those inspections run `multiplyUnsafe`. Its cost depends on each scalar's bits. For uncached points it is a double-and-add ladder whose number of additions depends on the scalar's popcount.
- The scalars themselves are public (z/e values that end up in the proof). But **which** branches get the variable-time treatment is the secret: it is the complement of `knownBranch`, which is the transferred resource type.
- So the prover's total time ≈ constant + Σ_{j≠k} f(scalars_j) + noise, and every term of f can be computed from the published proof.
- Before the patch, every multiplication went through `scalePoint`, so the total time did not depend on k.

**Counterexample:**
- Take the 8-type fixture `[10,…,17]` at index 107 (known branch 7).
- An observer with one timing of the proof generation and the resulting proof computes f(branch j) for each j ≤ 7. For each branch, f covers roughly 25 ladder multiplications with ~253-bit z/e scalars (the opening plus 2 ranges × 6 bits × 2 non-H multiplications).
- The observer then picks k = argmin |T − Σ_all f + f(k)|.
- The per-branch spread is about ±40 point additions. That signal is small against JS bigint and GC noise, so practical exploitability is uncertain. Still, this is exactly the "public multiplier, secret-selected call site" pattern the brief asked me to rule out.

**Minimal fix (the transcript stays identical because the group values are the same):**
- Give the inspectors an internal `scale` parameter that defaults to `scalePublicPoint`.
- Thread it through `inspectBranch`.
- Have the prover pass `scalePoint`:

```ts
// cds.ts
function inspectBranch(statement, value, scale = scalePublicPoint) { … }
// in proveCdsOr, simulated branch:
return { ...inspectBranch(branch, proof, scalePoint), respond: () => proof };
```

Also tighten the `scalePublicPoint` doc comment. The real invariant is "the scalar **and whether this call happens** are independent of secrets", not "the scalar was disclosed in a proof".

### 2. Question: other prover-side callers of the `inspect*` functions

`inspectBitProof`, `inspectRangeProof` and `inspectSchnorrProof` are exported. Any caller outside the reviewed files (for example in `packages/protocol`) that runs them over a secret-selected subset of branches, or before disclosure, has the same issue as finding 1. I could not search for such callers, so a `grep` for these names is needed to close this.

### 3. Question: dependence on the pinned noble version

The patch's safety assumes that `multiplyUnsafe`:
- accepts `0n`,
- uses the plain ladder (window W=1, no normalization or `Fp.inv` of intermediate values) for uncached points,
- uses the cached W=8 wNAF only for `H` and `BASE`.

The new test pins the `0n` behaviour. The other two assumptions are version-dependent internals. If `@noble/curves` is not pinned exactly, a minor upgrade could change them silently. This is not a flaw today, since every point at the reviewed verifier and simulation sites is public; it is a pinning question.

### 4. Test gap (minor)

The new `group.test.ts` case only exercises an uncached point. Two cases are missing:
- `scalePublicPoint(H, s)`, which takes the precomputed wNAF path.
- An identity point with a nonzero scalar.

The `H` path is covered indirectly by the range tests and the digest test, but a direct equality check alongside `scalePoint` would be cheap:

```ts
for (const p of [H, scalePoint(G, 0n)]) for (const s of [0n, 1n, 31n, SCALAR_ORDER - 1n])
  expect(scalePublicPoint(p, s).equals(scalePoint(p, s))).toBe(true);
```

### 5. Consistency note, not a flaw

`verifySchnorr` and `verifyDleq` still use `scalePoint`. This includes the hidden-transfer sum-proof verification. It is correct, just not optimized. That is fine if the bounded scope is intentional.

## Checked and found sound

- **`simulateRangeProof`, secret-nonce points:** each `point` is pushed into the published `commitments`. Only its discrete log relative to H is secret. The multipliers (`2^i` and the inverse of `2^(bits−1)`) are protocol constants, and the number of calls is fixed per simulated range. So variable-time multiplication leaks nothing new here. The nonce multiplication `H·nonce` still uses `scalePoint`.
- **`inverseLastWeight` cache:**
  - Both callers pass `parsed.bits`, which `readStatement` has already validated as an integer in 1–16.
  - The cached value equals the old `invertScalar(weight)`, since at index `bits−1` the weight is `2^(bits−1)`. For `bits=1` it gives 1.
  - The map holds at most 16 immutable bigints, and the value is public, so using it inside the secret `prepareRange` arithmetic is fine.
- **Canonical and identity handling:**
  - `scalePublicPoint` rejects scalars that are negative or ≥ the group order before reaching noble.
  - Noble returns ZERO for `0n` and returns `this` for an identity point or `1n`. Points are immutable, so that is harmless.
  - The `is0()` early exit on a possibly secret-derived point already existed in `scalePoint`.
- **Soundness:** the verification equations are unchanged. `multiplyUnsafe` computes exactly k·P on the underlying Edwards representative, torsion component included. Ristretto `equals` compares cosets, so the accept/reject results are identical to the constant-time path.
- **Transcript and digest:** the proof bytes should be unchanged. The pinned `b1e86a98…` test exercises the new path, because 7 simulated branches' first messages feed the CDS challenge. Any arithmetic divergence would therefore change the digest, although I have not run it.
