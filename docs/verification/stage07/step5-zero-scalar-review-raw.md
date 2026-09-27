# Review: `scaleZeroSafePoint` and its use in `pedersenCommit`

**Scope:** static reading only. I ran no tests and used no tools. I reviewed only the Noble excerpts that were provided. Some Noble internals I did not see; they are listed under "Unverified dependencies" below. Nothing here is a claim of constant-time behaviour at the JavaScript engine or browser level.

## 1. Arithmetic correctness

Let `s ∈ [0, n−1]`, `q = ⌊s/2⌋ + 1` and `r = 2 − (s mod 2)`.

- **The identity holds.** `2q − r = 2⌊s/2⌋ + 2 − 2 + (s mod 2) = s`. So `2·(q·P) − r·P = s·P` exactly for every canonical `s`, with no reduction needed.
- **`q` stays in range.** `n` is odd, so the largest `q` is `(n−1)/2 + 1 = (n+1)/2`, which is below `n`. The smallest is `q = 1`, at `s ∈ {0, 1}`. So `q ∈ [1, (n+1)/2] ⊂ [1, n−1]`.
- **`r` stays in range.** `r ∈ {1, 2}`, both inside `[1, n−1]`.
- **Boundary cases:**
  - `s = 0`: `q = 1, r = 2`, giving `2P − 2P = O`.
  - `s = 1`: `q = 1, r = 1`, giving `P`.
  - `s = n−1` (even): `q = (n+1)/2, r = 2`, giving `(n+1−2)P`.
  - `s = n−2` (odd): `q = (n−1)/2, r = 1`, giving `(n−2)P`.
- **Identity input point.** `multiply` validates only the scalar (`Fn.isValidNot0`), so `P = O` is accepted. The test covers `scalePoint(G, 0n)` as an input point.

**Verdict:** the decomposition is correct for all canonical scalars, and `multiply` never receives an out-of-range scalar.

## 2. Noble 2.4.0 multiplication path

- **No early return in `multiply`.** `edwards.js:281-290` checks `isValidNot0` and then always calls `wnaf.mulSecret`. The `scalar === 0` and `scalar === 1` early returns exist only in `multiplyUnsafe` (`:300-303`). So `q = 1` and `r = 1` are not short-circuited, and the Ristretto wrapper (`:470-478`) adds no shortcut either.
- **Kernel selection.** `mulSecret` (`curve.js:466`) chooses the kernel as follows:
  - **G:** uses `mulCTBlinded` only if `G.ep` is the same object as the Edwards `BASE` and an RNG is present. Since the cofactor is 8, `shouldBlind` returns true only for that exact `BASE` object. In that case `n = s + blind·ORDER` is full width, which hides the magnitude of small `q` values (at most 32 for counts).
  - **H:** not `BASE`, so it takes the unblinded `mulCT`. With `precompute(8)` this should be `wnafCachedCT`.
  - **Any other point:** `fixedWindowCT`.
- **Operation count.** In `wnafCachedCT` the number of windows is fixed and each window does one addition, into either `p` or the fake accumulator `f`. The table scan touches every entry. `fixedWindowCT` does a fixed number of doublings, a full scan, and one addition per window, including for digit 0.
  - Counting point operations, neither kernel's count depends on the scalar.
  - Both kernels still branch on the scalar at the JavaScript level: `digit === 0` chooses between `p` and `f`, and `i === idx` selects the table entry.
  - For small unblinded scalars (`r` on H, and `q = 1` when the H-blinding is 0), most digits are zero, so most additions go to `f`. The count is unchanged, but the branch pattern depends on the secret.
- **The `r ∈ {1, 2}` multiply.** It reveals only the parity of `s`, and even that appears only as window-0 digit 1 versus 2. For bit commitments `q` is always 1 and only `r` varies. This is a clear improvement over the old path.

## 3. Pedersen commitments, transcript and soundness

- **Unchanged outputs.** `scaleZeroSafePoint` returns the same group element as before, and `encodePoint` is canonical. So hand-count, one-hot and range-bit commitments are byte-identical to the old ones. Nonces are derived deterministically, so proofs should also be byte-identical. The pinned hash in `hidden-transfer.test.ts` is what would confirm this; I did not run it.
- **Soundness unaffected.** The verifier never calls `pedersenCommit`; it uses `scalePublicPoint`.
- **Old fast path removed for all three witness kinds.** The zero-scalar fast path is no longer reached for:
  - hand counts (`proveHiddenTransfer` opening check),
  - one-hot bits (transfer check, and `prepareBit`'s re-check),
  - range bits (`prepareRange` bit commitments and its statement check).
- **Cost.** Each commitment now needs 4 constant-time multiplies instead of 2. Bit commitments are computed twice, once in `prepareRange` and again in `prepareBit`. This affects performance only.

## 4. Concrete flaws

**None in `scaleZeroSafePoint` or in `pedersenCommit`.**

One concrete issue exists elsewhere in the proof. It is outside the frozen patch, but it has the same kind of leak on a frequent legal secret:

- **F1: `prepareBit` does a subtraction only when the bit is 0** (`range.ts`, `falseTarget = bit === 0 ? target.subtract(G) : target`). That is one extra point subtraction, a secret-dependent difference in point-operation count.
  - For the 8 one-hot bits the total is constant (`k−1` subtractions), but the position of the missing subtraction is secret.
  - For the 12 range bits (`lower`, `upper`), the total count equals the number of zero bits. That leaks the Hamming weight of the card's position inside its resource group.
  - The magnitude is small (about one point addition against hundreds of multiplies), but it is deterministic.
  - **Fix:** always compute `const minusG = target.subtract(G)`, then select between the two values.

## 5. Residual risks

**Frequent legal zeros that remain:**

- **R1: the identity point is materialised when `s = 0`.** `2P − 2P` produces a point with `X = T = 0`. The following `.add(...)` in `pedersenCommit` then multiplies BigInts by 0. BigInt multiplication by 0 is effectively constant-cost, so this is a JavaScript-level distinguisher for `value = 0` (counts and bits). The same happens on the H side when `blinding = 0`. That occurs whenever the selected resource is index 0, because then `selectedPrefixBlinding = 0n` and the lower range gets `blinding = modScalar(-0n) = 0`, which makes the selected type distinguishable.
  - **Cheap mitigation:** in `pedersenCommit`, reorder to `(2q·G + blinding part) − r·G`, and do the same symmetrically for H. The intermediate is then non-identity except with negligible probability.
- **R2: BigInt magnitude.** `scalar >> 1n`, `scalar & 1n`, `signedWindowDigits(q)` and similar operations run in time that depends on the operand's length. Counts give `q ≤ 32`, compared with full-width blindings. This is masked for G only if the blinded path is actually taken (see U1).
- **R3: CDS control flow.** The known branch runs `prepare*`; the simulated branches run `simulate*` plus `inspectBranch` using the default `scalePoint`. The total work is constant across choices of `selected`, but the sequence of work over time reveals the selected resource type to a fine-grained observer. This is not a zero shortcut, but it leaks the same secret this proof protects.
- **R4: small branches in `proveHiddenTransfer`.** The prefix loop assigns `selected` under a condition, and announcement and response ordering use ternaries. These are small and not zero-specific.

**Negligible, nonce-zero cases** (probability about 2⁻²⁵², given derived nonces or random blindings):
- `scalePoint(H, nonce)`, `scalePoint(H, falseResponse)` and `scalePoint(falseTarget, falseChallenge)`, including `falseTarget.is0()`, in `prepareBit`.
- The Schnorr nonce and secret checks, where the secret is the transfer blinding.
- The sum proof's `transferBlindSum`.
- The simulated-range `scalePoint(H, nonce)` calls.

These hold only if callers supply random blindings. `readWitness` accepts a zero blinding without complaint.

**Public zeros (no concern):**
- `scalePoint(G, 0n)` accumulators.
- `scalePoint(G, index)` when `index = 0`.
- Branch 0's `lowerIndex − O`.
- All verifier arithmetic, which uses `scalePublicPoint`.

**Remaining `scalePoint` zero fast paths on frequent secrets:** I found none in the eight-type prover. Every frequently-zero secret (counts, one-hot bits, range bits, `lower`/`upper`, and the index-0 prefix blinding) reaches point arithmetic only through `pedersenCommit`.

## 6. Unverified dependencies (not in the provided excerpts)

- **U1:** Whether `ristretto255.Point.BASE.ep` is the same object as the Edwards `BASE`. This decides whether G takes the blinded path. Also whether `randomBytes` is available at runtime.
- **U2:** The bodies of `mulCT`, `runCT`, `mulCTBlinded` kernel selection, and `signedWindowDigits`.
- **U3:** `normalize` in `multiply`. The affine conversion inverts a Z coordinate that depends on the secret; if `Fp.inv` there uses a Euclidean algorithm, it is variable-time. This applies to every secret multiply, not only to zero.
- **U4:** That H's `precompute(8, false)` table is the one `wnafCachedCT` actually uses.
