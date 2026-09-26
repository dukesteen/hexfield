# Stage 07 Step 1 follow-up review: CDS, composable Schnorr, nonce modes, Feldman

## Verdict

I found **no confirmed verifier soundness break and no confirmed witness leak** in the revised helpers. F1, F2, F5, F7 and F8 are fixed in code. F6 is adequately addressed.

The new gaps are all in the tests. Two checks that soundness depends on can be deleted without any test failing:

- the CDS range-challenge equality check (N1);
- the range weighted-sum check (N2).

F3 is only partly fixed. The identity-point negatives still pass without the identity check (N3).

This is a code review, not formal verification. It does not accept Stage 07.

## Findings

### N1 — Low (test gap, soundness-critical check). CDS range-vs-branch challenge equality is never isolated

In `cds.ts` `inspectBranch`, this line enforces the AND inside a branch:

```ts
if (inspected.challenge !== challenge) throw …
```

Deleting it leaves every test in `cds.test.ts` passing. Each existing mutation is caught by something else first:

- `changedRange` alters only bit 0, so `inspectRangeProof` throws "share one challenge".
- `ranges: first.ranges` fails the weighted sum, and its challenge 13 is also caught first.
- The "independent per-component challenges" case replaces only the opening, which `inspectSchnorrProof` catches.

**Why the check matters.** The attack below needs no discrete log. It proves a true opening AND a false range. Start from the `claim()` fixture, but change branch 1's range to `commitment: pedersenCommit(5n, 17n), bits: 2`. The value 5 is outside `[0, 4)`.

1. Branch 0: simulate the whole branch at `e₀ = 13`, using `simulateSchnorrProof` and `simulateRangeProof`.
2. Branch 1, opening: pick nonce `k` and send `kH`.
3. Branch 1, range: `simulateRangeProof(range₁, 7n, …)`. This proof is internally consistent at challenge 7.
4. Compute `c = proofChallenge('cds-or', CONTEXT, statement, firstMessages)`. Set `e₁ = c − 13`, and respond to the opening with `k + e₁·23`.

With the check removed, all remaining checks pass:

- the Schnorr equation at `e₁`;
- the range's weighted sum and shared bit challenge (7);
- `e₀ + e₁ = c`.

The verifier would therefore accept a proof of "23H opening ∧ 5 ∈ [0,4)".

**Test to add.** Build this proof and assert `verifyCdsOr(...) === false`. Add two control assertions so the failure can only come from the equality check:

- `inspectRangeProof(range₁, forged).challenge === 7n`;
- `inspectSchnorrProof(opening₁, forgedOpening, e₁)` does not throw.

The coordinator response says independent per-component challenges are tested. That is true for the opening only.

### N2 — Low (test gap, soundness-critical check). Range weighted-sum check is never isolated

In `range.ts` `inspectRangeProof`, the check `weighted.equals(decodePoint(parsed.commitment))` is what binds the bits to the statement commitment. Deleting it leaves `range.test.ts` and `cds.test.ts` passing:

- In the F4 forgery test the width is 1, so the only bit commitment equals the statement commitment and the sum holds trivially.
- The tests that change the statement or the commitments are rejected by Fiat–Shamir, because both are hashed.

**Forgery if the check were removed.** It uses only the public API:

```ts
const honest = statement(13n, 17n); // bits sum to this
const lie = { commitment: pedersenCommit(100n, 17n), bits: 6 };
const prepared = prepareRangeProof(honest, 13n, 17n, SEED, CONTEXT);
const c = proofChallenge('range', CONTEXT, lie, {
  commitments: prepared.commitments,
  announcements: prepared.announcements,
});
expect(verifyRange(lie, prepared.respond(c), CONTEXT)).toBe(false);
```

Every bit is valid at `c`, and Fiat–Shamir matches `lie`. Only the weighted sum rejects this proof, which would otherwise show that 100 lies in `[0, 64)`.

This is the multi-bit, out-of-range verifier negative that F4 asked for. It is still missing.

### N3 — Low (test gap, F3 not fully resolved). Shuffle identity-point rejection is still non-isolating

In "rejects substituted/re-keyed outputs, duplicate or identity points…", the identity cases now pass `validProof` together with a mutated statement. Because the statement is hashed, `challengeFor` differs and verification returns `false` even if `nonIdentity: true` were removed from `parsePoints`.

The duplicate-point check _is_ now isolated, by the independent transcript over `[1n, 1n, 3n, 4n]`. Do the same for identity:

```ts
const statement = fixture(PI, [0n, 2n, 3n, 4n]); // input[0] = identity, output has identity at π(0)
const { forwardRelations, compact } = independentExplicitProof(statement);
expect(forwardRelations.every(Boolean)).toBe(true);
expect(verifyShuffle(statement, compact, CONTEXT)).toBe(false);
```

`scalePoint` already returns `ZERO` for identity inputs, so the fixture and the explicit proof build correctly. This check matters because an identity card is a fixed point of every re-encryption, so its position is visible through the whole shuffle.

A `publicKey` identity cannot be isolated this way. It forces `u = 0`, which the nonzero-scalar decode rejects on any bit-1 round. That redundancy is fine.

### N4 — Low (test gap). CDS opening wiring is covered only by the Schnorr unit test

Every CDS negative that touches the opening changes the commitment or the challenge, and both are hashed. Consider a hypothetical regression where `inspectBranch` read `record.opening.commitment` directly instead of calling `inspectSchnorrProof`. The CDS tests would still pass, and a proof with a garbage `opening.response` would be accepted.

`sigma.test.ts` does isolate the Schnorr equation itself (`inspectSchnorrProof(…, 24n)` throws). What is missing is a CDS-level test that changes only `second.opening.response` and expects `false`.

Bit proofs do not have this gap, because their announcements are recomputed from the responses and therefore hashed.

### N5 — Low (misleading regression). Half of the F2 test does not test F2

In "separates standalone and composed nonces…":

- **Holds:** `prepared.commitments ≠ inspected.commitments` catches the actual F2 defect, where standalone and composed ranges shared bit blindings. Removing the `'standalone-range'`/`'composed-range'` tags makes it fail.
- **Trivial:** `verifyRange(claim, prepared.respond(c+1))` is false for any challenge other than the Fiat–Shamir one.
- **Would pass without the fix:** the `proveBit` versus one-bit `proveRange` response-subtraction check. Range bits were already derived under a context containing `statement`, `commitments` and `index`, while `proveBit` used the bare context. Removing the `'standalone-bit'` tag would not break it.

The coordinator's statement that "a regression checks that response subtraction cannot recover the shared blinding across modes" describes a pair of modes that was never vulnerable. Either rename the test, or repeat the subtraction check on the standalone-range and composed-range pair.

### N6 — Hardening (requires caller misuse). CDS uses the public composed modes without a CDS-private tag

`proveCdsOr` calls the exported `prepareSchnorrProof` (domain `'schnorr-composed'`) and `prepareRangeProof` (mode `'composed-range'`). The contexts are shaped as `{context, statement, branch, component[, index]}`.

A direct caller of `prepareSchnorrProof` or `prepareRangeProof` could pass a context with exactly that shape and answer a different challenge. That would reuse the CDS nonce.

This needs a crafted context, so it is caller misuse and not a helper flaw. The fix is cheap: wrap the context in `{mode: 'cds-or', …}` inside `proveCdsOr`, or use internal prepare variants.

## F1–F8 status

| Finding | Status                                                                                                                                                                                                                                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1      | **Fixed.** `commitments.length === threshold` bounds the degree at t−1, `encoded[0] === masterPub` binds F₀, and `index === recipientIndex` binds the recipient. Each check is isolated by a test. An identity top coefficient (degree below t−1) is still accepted; that weakens only the dealer's own secret, so it is not an escrow escape. |
| F2      | **Fixed in code:** standalone-bit, range-bit, standalone-range, composed-range and schnorr-composed are all separated. The test is partly misleading (N5).                                                                                                                                                                                     |
| F3      | **Partly fixed.** Duplicates are now isolated; identity is not (N3).                                                                                                                                                                                                                                                                           |
| F4      | **Partly fixed.** The 1-bit forgeries fail for the right reason, but the multi-bit sum forgery is still untested (N2). The Shamir t−1 test is acceptable; it tests mathematics, not a validation.                                                                                                                                              |
| F5      | **Fixed** by renaming the test.                                                                                                                                                                                                                                                                                                                |
| F6      | **Fixed.** K.3 validates `expand_message_xmd`, A.3 validates the element map, and `deriveToCurve(expand(msg, DST, 64)) == H` ties `hashToCurve` to both. The bundle cannot verify that the 64-byte intermediate was computed independently, but the chain does not depend on it.                                                               |
| F7      | **Fixed**, apart from the test gaps N1 and N4.                                                                                                                                                                                                                                                                                                 |
| F8      | **Fixed.** The challenge length and the responses array shape are checked before the statement is read, and the Proxy test isolates this ordering.                                                                                                                                                                                             |

## Checked and found consistent

**Outer challenge.** One `proofChallenge('cds-or', context, parsed, firstMessages)` covers:

- the ordered, normalized statement;
- each opening commitment;
- each range's bit commitments and recomputed announcements.

The independent transcript test pins the exact hash input, so omitting any hashed field would break the positive test.

**Challenge arithmetic.**

- Branch challenges are canonical scalars (zero is allowed).
- They must sum to the outer challenge modulo ℓ.
- The opening and every range are checked at the branch challenge.

Special soundness holds: two accepting transcripts with different outer challenges differ in at least one branch challenge. In that branch every bit's `(e₀, e₁)` differs in at least one coordinate. That extracts the opening secret and every bit, and the weighted sum then yields the range opening.

**Simulation.** Simulated branches are valid Sigma transcripts at their chosen challenge. An all-simulated proof would need `Σeᵢ = H(fm(e₁…eₙ))`, which is infeasible in the random-oracle model.

**Witness indistinguishability.**

| Component        | Honest                 | Simulated         | Distribution                           |
| ---------------- | ---------------------- | ----------------- | -------------------------------------- |
| Bit commitments  | `bG + sH`, `s` uniform | `rH`, `r` uniform | same; the last one is fixed by the sum |
| Opening          | `(kH, k+ex)`           | `(zH−eP, z)`      | same                                   |
| Branch challenge | `c − Σ` (uniform)      | uniform           | same                                   |

**Nonce reuse across proofs.**

- Every honest nonce is derived from the seed, the full `parsed` statement (all branches), the context, the branch index and the component.
- The honest challenge is a deterministic function of those same inputs. Re-running with identical inputs reproduces the identical proof, so no nonce ever answers two challenges.
- Changing any other branch changes the nonce as well as the challenge. This rules out the "change a false branch to shift the honest challenge" leak.
- If the prover knows two branches, each branch index gets its own nonce.

**Single-use responders.** Each prepared object sets `answered` after validating the challenge, so a rejected challenge never touches the secret. `proveCdsOr` calls each responder once.

**Parsing.** Statement and proof parsing is exact-shape and getter-free, with 1–8 branches and 0–2 ranges. Range widths are validated when inspecting, proving and simulating.

**Timing.** Total proving work does not depend on which branch is honest, provided all branches have the same range count. With mixed shapes it would depend on it; keep all branches the same shape in Step 5.

## Integration obligations (unchanged, not helper defects)

- Range widths, card counts, `masterPub`, threshold and recipient index must come from certified state.
- The one-hot and index statements, including binding the T vector, index and sealed-payload hash into the context, are Step 5 work.
- `openSealedWithSharedPoint` still requires a prior `verifyDleq` against the certified key.
- `recoverSecret` still uses only the first `threshold` shares, each of which must be verified.

## Not established by this review

- Browser worker timings.
- Full-session integration.
- Setup and secret recovery flows.
- The adversarial acceptance suite.
- Noble internals: whether `invertCt` is constant-time and whether `fromBytes` is complete.
- Non-constant-time BigInt arithmetic.

Stage 07 acceptance cannot be inferred from these helper tests or from this review.
