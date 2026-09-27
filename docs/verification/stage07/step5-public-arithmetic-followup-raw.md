# Follow-up review: eight-type hidden-transfer arithmetic

## Verdict on the original finding

**Fixed.** Every call site that `knownBranch` selects now runs on `scalePoint`. `scalePublicPoint` appears only where both the scalar and the call selection are public.

| Path | Selection | Multiplier | Scalars | Assessment |
|---|---|---|---|---|
| `proveCdsOr` → `inspectBranch(branch, proof)` | secret (n−1 simulated) | default `scalePoint` | e, z (published, so a timing oracle would decide which subset was omitted) | OK. This was the original bug. |
| → `inspectSchnorrProof` / `inspectRangeProof` / `inspectBitProof` | inherited | `scale` passed through, default `scalePoint` | e, z, bit weights | OK |
| `proveCdsOr` → `simulateSchnorrProof` | secret | `scalePoint` | simulated e, z | OK |
| `proveCdsOr` → `simulateRangeProof` (range.ts) | secret | `scalePublicPoint` | `2^i` and `inverseLastWeight(bits)` only | OK, see below |
| `verifyCdsOr` → `inspectBranch(…, scalePublicPoint)` | public (all branches) | public | proof values | OK |
| `verifyRange` | public | public | proof values | OK |

**Fixed-weight multiplications in `simulateRangeProof`.** The public multiplications use the same fixed scalar sequence in every simulated branch. The protocol widths are fixed at `RANGE_BITS = 6`, so the `1n` short-circuit at index 0 and the `inverseLastWeight` scalar are identical across branches.

Total prover time decomposes as Σ_{j≠k} Sim(j) + Known(k). Its public-multiply part is therefore independent of k. The input points are secret-derived, but Noble's `multiplyUnsafe` only branches on `is0()` and the scalar, and the points are non-identity except with negligible probability. The inputs also become public as the published bit commitments.

The `inverseWeights` cache miss always happens during branch 0, whether branch 0 is simulated or known, so it is not k-dependent.

**Exported inspectors.** Defaulting `scale` to `scalePoint` is a sufficient safe default. A caller must opt in explicitly to get variable time.

## Concrete remaining flaw

**`scalePoint` short-circuits on a secret zero scalar** (`group.ts`, `if (scalar === 0n || point.is0()) return ZERO`). The earlier fix did not touch this, and it is reachable with secret witness values:

- **Bit decomposition** (`prepareRange` → `pedersenCommit(bit, blind)` and `prepareBit` → `pedersenCommit(BigInt(bit), blinding)`). Each zero bit of the known branch's `lower` and `upper` skips two `G` multiplications. Proving time therefore leaks the Hamming weights of `lower = index − prefix_k` and `upper = prefix_k + count_k − 1 − index`. With public `index` and `handSize`, that narrows which type is selected and where the card sits within it.
- **Range openings** (`prepareRange` → `pedersenCommit(value, blinding)`). Whether `lower` or `upper` is zero also leaks, i.e. whether the card is first or last of its type.
- **Hand counts** (`proveHiddenTransfer` → `pedersenCommit(BigInt(count), blinding)`). This leaks how many resource types have a zero count.
- **One-hot bits** (`proveHiddenTransfer` → `proveBit`). The total is constant because exactly one bit is 1. Only intra-loop position timing remains, which is weaker.

Each skipped multiply costs on the order of 0.1–1 ms in JS. Peers see proof-generation latency, so this is plausibly observable. The leak is the same class as the original bug: secret-dependent work in the prover.

**Suggested fix.** Keep `scalePoint`'s zero guard for public or random scalars. Add a secret-value path for small committed values that never hits it. For values known to be below `SCALAR_ORDER − 1`, `scalePoint(G, v + 1n).subtract(G)` works. For a general scalar, use a random split: `P·r + P·(s − r)` with nonzero `r` and `s − r`.

Use this path in `pedersenCommit`, or at least in the bit, range and count call sites. `prepareBit`'s `bit === 0 ? target.subtract(G) : target` is a smaller secret branch of the same kind.

## Soundness and transcripts: no issues found

- **Fiat–Shamir.** `verifyCdsOr` hashes the context, the parsed ordered statement, and every branch's opening commitment, range bit commitments and recomputed announcements. It checks Σe_j against that hash. Prover and verifier hash identical `encodePoint` strings.
- **Shared challenge.** Each range's bit challenges e0 + e1 must agree and equal the branch e, and the Schnorr check uses that same e. The weighted bit-commitment sum must equal the range statement.
- **Zero knowledge.** Simulation matches honest distributions:
  - Non-last bit commitments are uniform H-multiples, versus uniform Pedersen commitments in honest proofs.
  - The last bit commitment is determined by the statement in both cases.
  - Bit (e0, e1 = c − e0, z0, z1) matches honest bit proofs.
- **Nonce separation.** Nonces are domain-separated across the honest, simulated and standalone paths. `compositionSeed` binds the statement and context.
- **Canonical scalars.** `decodeScalar` rejects values ≥ ℓ. Witness scalars are checked by `canonicalSecret`, `scalarToBytes` and `readWitness`. `modScalar` handles negatives.

## Bounded questions

1. **base64url trailing bits.** Does `fromBase64Url` reject nonzero unused bits in the 43rd character? If not, each scalar or point string has four encodings.
   - Proof responses and challenges are not hashed, so a third party could re-encode them and the proof would still verify.
   - This does not affect soundness. It matters only if proofs are deduplicated, signed or identified by their serialized bytes.
   - `hidden-transfer.ts` round-trips statement points, but proof fields are not round-tripped.
2. **BigInt arithmetic is not constant time** (`modScalar`, `nonce + e·secret`, and Noble's field ops). Algorithmic constant time is the best available in JS. Confirm this residual is accepted in the threat model.
3. **`invertCt` import.** Confirm that `@noble/curves/abstract/modular.js` exports `invertCt` in the pinned version. It is only reached with public weights here, so this is not a secrecy issue either way.
