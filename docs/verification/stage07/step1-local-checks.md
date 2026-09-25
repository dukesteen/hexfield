# Stage 07 Step 1 local checks

The cryptographic helpers are implemented and pass local checks. This checkpoint
does not complete Stage 07 or provide playable online multiplayer. The external
implementation review is pending specific approval to send the unpublished
source to Claude.

## Scope

The new helpers provide strict Ristretto/scalar encodings, domain-separated HKDF,
hash-chain links, unbiased integer sampling, Feldman-verified Shamir shares,
Schnorr/DLEQ proofs, Pedersen bit and range proofs, Sigma range composition,
ECDH/HKDF sealed delivery and a compact 64-round shuffle proof. They accept
explicit inputs and contain no platform randomness or game-session state.

The [review manifest](step1-review-manifest.json) records SHA-256 hashes of 24
source, test and design files. The files were unchanged through the final local
check and build. The review input hash is
`cbf974e779f003eb3b19a5e5a70504e496d970dc130e3569b2a7c0ed264db3da`.
This records the prepared review payload, not a completed external review.

## Results

On 2026-09-26, using Node 22.23.3 and pnpm 10.7.1:

- `pnpm check` passed typechecks, type-aware lint, formatting, dependency rules,
  purity and i18n checks, plus **586 tests in 107 files**.
- `pnpm build` passed for every workspace package and the web app.
- The coordinator checked the final process exit codes and rehashed all manifest
  files after the run. No files changed.
- No local Firefox, WebKit or other browser process was launched for this work.

Focused coverage includes RFC 9496 encodings, pinned derivation/transcript
vectors, a pinned integer-sampling rejection, every threshold subset for up to
six Shamir holders, tampered shares, wrong proof keys and contexts, canonical
parsing, hostile records/arrays, every six-bit range value, invalid range targets,
zero/identity cases, Sigma simulation versus standalone Fiat–Shamir, and both
directions of explicit/compact shuffle equivalence. The explicit shuffle fixture
constructs commitments before the challenge and checks the original forward
equations. Sealing tests independently check HKDF using Node's implementation
and preserve the requirement to validate decrypted openings.

The internal review also corrected two API issues: derivation labels are frozen
at runtime, and malformed typed-array proxies cannot make hash-chain verification
throw. Point and scalar strings are length-checked before base64 decoding.

## Remaining work

The [read-only Claude review brief](step1-review-prompt.md) is ready. Automatic
approval review declined the upload because the source is unpublished and
cryptographic, and requested specific user approval for this payload. No source
was sent by that attempt.

Game-session evidence verification, frozen operation state, deck/hand/steal
orchestration, escrow distribution, audit and replacement of the simulation driver
remain later Stage 07 steps. Browser worker performance and the full adversarial
game acceptance suite are not established by these unit tests.
