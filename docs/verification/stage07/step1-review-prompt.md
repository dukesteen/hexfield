# Stage 07 Step 1 implementation review

Review the attached pure cryptographic helpers for concrete correctness and
security defects. This is a read-only review. Do not implement anything, run
commands, open files beyond the supplied text, or access external services.

The product is a browser peer-to-peer board game. Stage 06 signed agreement and
certified history have passed their CI acceptance. These new helpers are Step 1
of Stage 07, not a finished online game. WebRTC, setup orchestration, durable
browser secrets and recovery activation are later steps/stages.

The attached Stage 07 design and prior review response define the contract.
Important boundaries:

- Ristretto255 group and SHA-256/HKDF use installed Noble 2.4.0 libraries.
  Pedersen H is hash-to-group, never a publicly known scalar multiple of G.
- Public encodings are canonical 32-byte base64url. Zero targets, commitments and
  response scalars are legitimate; key scalars, bases and encryption keys are
  nonzero. Some helpers throw on local misuse; public proof verifiers return
  false for malformed input.
- A protocol caller supplies the entire certified context, expected dimensions
  and 32-byte private entropy. Setup context uses ceremonyId because final genesis
  includes its transcript. Later contexts bind genesis, epoch, fixed operation,
  phase, participants, key versions and exact statement. Integration must reject
  stale contexts before expensive verification. Those protocol checks are not
  claimed to be implemented by these generic helpers.
- Deterministic proof randomness binds complete statements and contexts. Only
  exact retries may repeat proof bytes. The range prepare/respond API is for
  noninteractive CDS composition, not for answering challenges from a remote
  interactive verifier. The final composition hashes all first messages once.
- Sealing provides confidential ECDH/HKDF-XOR delivery. A signed envelope and
  semantic opening check provide integrity. Generic decryption deliberately
  returns untrusted bytes. The recipient must verify the opening before signing
  a receipt; the protocol will require that receipt before a steal commits.
  Public dispute decryption requires a valid DLEQ for the disclosed shared point.
- Feldman primitives allow generic thresholds for testing. Protocol setup limits
  eligibility to at least four original human devices and all other holders.
  Bots do not add holders. recoverSecret assumes authenticated, verified shares;
  it cannot authenticate without original commitments. No signing key is escrowed.
- Compact shuffle proof preserves the explicit 64-round cut-and-choose scheme.
  Old-index-to-new-index permutations mean (pi X)_j=X_[pi^-1(j)]. Exactly eight
  challenge bytes are MSB-first. Bit0 reconstructs R=rG and Y=rho(r input).
  Bit1 reconstructs R=u^-1 A and Y_j=u^-1 output_[tau(j)]. Hash the full
  reconstructed transcript and compare all eight bytes. Its target soundness is
  64 bits per attempt. It is not claimed to provide 128-bit shuffle soundness.
- Standalone bit/range proofs use Fiat–Shamir. Composable range helpers instead
  use one shared caller-supplied branch challenge, with each bit OR splitting
  that challenge. False ranges can be Sigma-simulated at a fixed challenge; this
  must not make them pass standalone Fiat–Shamir verification.

Inspect the actual implementation and tests. Prioritize:

1. An invalid public statement accepted by a verifier, with a concrete trace.
2. Secret leakage through nonce reuse, predictable H, permutation direction,
   response reconstruction, missing transcript binding or simulated-branch bias.
3. Range soundness, identity/zero edge cases and incorrect AND/OR composition.
4. Canonical decoding, shape/dimension limits and proof splicing.
5. Feldman interpolation/share checks, unbiased integer sampling, and seal
   keystream/context/recipient separation.
6. Missing meaningful tests or a misleading test that would miss a listed bug.

Give findings ranked by severity, with file/function and the exact failing
input or algebra. Separate confirmed defects from integration obligations and
optional optimizations. If no concrete defect is found, say what remains
unverified. Do not claim formal security or completed stage acceptance from
unit tests. Browser performance benchmarks remain required in Steps 3 and 5.

The generated review input appends exact source and test contents with SHA-256
fingerprints. It contains only project source, design and public test fixtures,
not actual game secrets or credentials.
