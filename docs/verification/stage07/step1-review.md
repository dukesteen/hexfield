# Stage 07 Step 1 review: pure cryptographic helpers

## Verdict

I found **no confirmed verifier soundness break and no confirmed witness leak** in the supplied code. I traced the shuffle, the bit and range proofs, Schnorr, DLEQ, Feldman, `uniformInt` and sealing. No honest-looking input made a verifier accept a false statement, and no path reused a nonce under a different challenge.

The findings below are:

- one public-verifier API gap with a concrete escrow failure (F1);
- a nonce domain-separation hazard (F2);
- several vacuous or missing tests (F3, F4, F6);
- one mismatch between a test name and the code (F5);
- a missing Step 1 deliverable listed in the design (F7).

This review is not formal verification, and it does not accept the stage.

## Ranked findings

### F1 — Medium. `feldman.ts` `verifyFeldmanShare` cannot enforce the polynomial degree or `F_0`

The verifier accepts any commitment vector with 1–6 entries. It takes no expected threshold, no `masterPub` and no expected recipient index. Because of that, the genesis check cannot establish the property recovery depends on.

**Trace.** Suppose there are four holders `{1,2,3,4}` and `t = 4`.

1. A dealer picks a degree-4 polynomial `f` with `f(0) = m` and `c_4 ≠ 0`.
2. The dealer publishes five commitments, `F_0` to `F_4`.
3. For every holder `j`, `verifyFeldmanShare({index: j, value: f(j)}, F)` returns `true`.
4. At takeover, `recoverSecret(shares, 4)` interpolates a degree-3 polynomial. It returns `p(0) = f(0) − c_4·Π(0 − x_j) = m − 24·c_4 ≠ m`.

The dealer thereby escapes escrow. This is detected only at recovery, which voids the game.

A single commitment (degree 0) has a different effect: every share equals `m`, so each holder alone learns the dealer's secret.

**Fix.** Either add `expectedThreshold` and `expectedMasterPub` parameters, or make genesis enforce all of the following:

- `commitments.length === t`;
- `commitments[0] === masterPub`;
- each share index matches its sealed recipient.

`recoverSecret` also silently ignores shares beyond `threshold`. Callers must Feldman-verify every share they pass, not only the first `t`.

### F2 — Low (hardening). Standalone and composed range proofs share nonce material

`proveRange(s, v, b, seed, ctx)` calls `prepareRangeProof(s, v, b, seed, ctx)`. Both use:

- the same bit blindings, from `'range'` with `['bit-blinding', i]`;
- the same bit nonces, from `'bit'` with `{context, statement, commitments, index}`.

**Trace.** A caller reuses one `ctx` for a standalone range proof and for a composed branch on the same commitment. The honest bit then answers two challenges:

- the standalone challenge `c = FS_range(…)`;
- the branch challenge `c'`.

The simulated challenge `e_f` is deterministic, so `e_h − e_h' = c − c'`. The honest bit blinding is then recoverable as `s_i = (z − z')/(c − c')`. That reveals every bit and the total blinding `Σ 2^i s_i`.

The per-object `answered` flag does not help, because a fresh `prepareRangeProof` call regenerates identical nonces. The contract says the context must bind the enclosing statement, so this requires caller misuse.

**Fix.** Add a fixed mode tag inside the helpers:

- `proveRange` uses `{mode: 'standalone', context}`;
- `prepareRangeProof` uses `{mode: 'composed', context}`.

Use a distinct role between `proveBit` and prepared bits as well.

### F3 — Low (misleading test). Shuffle identity-point rejection is tested vacuously

In `shuffle.test.ts`, the test named "rejects … duplicate or identity points":

- calls `verifyShuffle({…identity output…}, {}, CONTEXT)`;
- calls `verifyShuffle({…identity publicKey…}, {}, CONTEXT)`.

Both would return `false` even if the identity checks were deleted, because `readProofRecord({}, ['challenge','responses'])` throws.

The duplicate-point case is tested only on the prover side (`proveShuffle` with a duplicated input). The verifier's `parsePoints` distinctness check for **output** duplicates is never exercised.

**Fix.** Pass a real proof with each mutated statement. Better still, stub-free: build an explicit transcript over a statement with a duplicate or identity output, and assert rejection comes from statement parsing.

### F4 — Low (test gap). Range verifier negatives use only the simulator

"Rejects every value outside `[0, 2^κ)`" is tested only on the prover side: `proveRange` throws. The only verifier-side negative is a simulated proof for 64.

Missing:

- a hand-built malicious proof whose bit commitment opens to 2, or to `ℓ−1` (the wraparound case `−1`);
- a check that such a proof fails `verifyRange` for every forging strategy in the harness, including a CDS proof whose honest side is replaced by a simulated side.

Similarly, "Shamir fewer fails" is only checked as an API throw. There is no test showing that `recoverSecret(t−1 shares, t−1)` from a degree `t−1` polynomial yields a secret other than the dealt one.

### F5 — Low (test name versus code). `uniformInt` does not bind the bound

`uniform.test.ts` says "binds label, bound, and context". However, `uniform.ts` derives from `{label, context, counter}` only, which matches the design text.

**Consequence.** Take the same `R`, label and context with bounds 3 and 6. Write `X` for the 64-bit candidate. Both calls accept on counter 0 unless `X ≥ 2^64 − 4`, so `uniformInt(…,3,…) = uniformInt(…,6,…) mod 3`. The outputs are correlated.

This is harmless while each certified request fixes `n`. Either rename the test, or add `bound` to the derivation and update the design.

### F6 — Low (test gap). `H` is only self-pinned

The test pins H's bytes but never checks Noble's `hashToCurve` against the RFC vectors. Specifically, it does not check `expand_message_xmd` with SHA-512 against RFC 9380, or the RFC 9496 A.3 one-way-map vectors. Nothing in the suite would catch H being a scalar multiple of G through a wrong helper.

**Fix.** Add one A.3 vector through Noble's element-derivation path. Add an expand-message KAT for the DST as well.

### F7 — Scope. The "CDS OR composition" deliverable is missing

The design's Step 1 lists "CDS OR composition". The code provides only range-level prepare, simulate and inspect.

The steal branch also needs:

- a composable Schnorr for opening `T_r − G` against H (prepare, simulate at a fixed challenge, inspect);
- a combinator that hashes every first message once and checks that the branch challenges sum.

Without these, Step 5 must write the composition itself, which is the riskiest part.

### F8 — Low (DoS ordering) in `verifyShuffle`

- The `challenge` string is base64-decoded before its length is checked. Check `length === 11` first.
- `parseStatement` decompresses all 2m points before checking the proof shape.
- `MAX_CARDS = 128` allows about 5× the work of the expected 25-card deck.

Callers must check the expected `m` and the context before calling.

## Integration obligations (not defects in these helpers)

- **Range widths.** `bits` must come from the protocol, never from the peer. `verifyRange` trusts `statement.bits` up to 16.
- **Composition verifier.** It must:
  - hash, per branch, both the `commitments` and the `announcements` from `inspectRangeProof`, plus the opening first message;
  - require the inspected challenge to equal the branch challenge for the opening and both ranges;
  - require the branch challenges to sum to one Fiat–Shamir challenge.
- **One-hot bit proofs.** `verifyBit` binds a single commitment. The context for each `T_r` proof must include the full T vector, the index and the sealed-payload hash, or proofs can be spliced across components or operations.
- **Dispute decryption.** `openSealedWithSharedPoint` trusts `sharedPoint`. It requires a prior `verifyDleq` with:
  - `base1 = G` and `point1 = E_thief`, where `E_thief` is the certified key version;
  - `base2 = ephemeral` and `point2 = K`.

  The `recipient` string must be that same certified encoding.

- **Seal determinism.** Sealing is deterministic per `(seed, context, recipient, plaintext)`. That is correct for exact retries, but every distinct delivery needs a distinct context.
- **Shuffle and deck dimensions.** Check the expected deck size, freshness and signature before `verifyShuffle`.
- **Label reuse.** `roundPermutation` reuses the `deckPermutation` label for ρ. It is separated by a `domain` tag in the context. As hygiene, switch it to `proofRandomness`, so it cannot collide with a caller's π derivation.

## Optional optimizations (for the Step 3 benchmark)

- ρ derivation makes about 64·(m−1) separate HKDF plus `uniformInt` calls, roughly 1,500 for m = 25. A single HKDF byte stream per round would be cheaper.
- Both the prover and the verifier `encodePoint` every reconstructed point. Each encoding costs about one inverse square root, so this is a measurable share of the time. Measure before changing anything.

## Checked and found consistent

- **Shuffle permutations.**
  - `permute` implements `(πX)_j = X_{π⁻¹(j)}`.
  - The prover sets `τ[ρ(i)] = π(i)`, so `τ = π∘ρ⁻¹`.
  - For bit 1, `u⁻¹·out_{τ(j)} = (r/a)·a·in_{ρ⁻¹(j)} = Y_j`, and `u⁻¹A = rG`.
- **Shuffle verification.**
  - Challenge bits are MSB-first, all eight bytes are compared, and the challenge covers the full statement and context.
  - Zero scalars, non-bijections, duplicates and identity points are rejected.
  - Canonical point encoding makes string distinctness equal point distinctness.
- **Bit and range proofs.**
  - The CDS bit equations are correct, and the last-bit blinding algebra is correct.
  - Simulated bit commitments and `(e0, e1 = c−e0, z0, z1)` have the same distribution as honest ones (up to the nonzero-scalar bias of 1/ℓ).
  - A simulated range cannot satisfy standalone Fiat–Shamir.
  - With 16 bits or fewer there is no wraparound.
- **Schnorr and DLEQ.** Transcripts include the domain, context, full statement and the canonical first-message strings. Identity bases are rejected, and identity targets and zero responses are allowed.
- **Lagrange interpolation.** The numerator and denominator are correct, and negative denominators are normalized.
- **`uniformInt` rejection.** The bound `2^64 − (2^64 mod n)` is correct, and Fisher–Yates is unbiased.
- **Seal HKDF info.** The info binds the context, recipient, ephemeral point and length, so different lengths give unrelated keystreams.
- **Canonical codec.** It rejects duplicate keys, the reserved `$b` tag and noncanonical base64url.

## Unverified

- **Noble internals.**
  - Whether `invertCt` exists and is constant-time in 2.4.0.
  - Whether `ristretto255_hasher.hashToCurve` follows RFC 9380 exactly.
  - Whether `Point.fromBytes` rejects every noncanonical encoding. The RFC 9496 A.2 negatives in the tests cover only three.
- **BigInt timing.** Response and nonce arithmetic runs on non-constant-time BigInt.
- **Composition and integration.** The composition code, the protocol checks and all browser performance targets are not implemented yet. The worker benchmarks for Steps 3 and 5 are still required.
