# Stage 07 Step 1 local checks

The cryptographic helpers are implemented and pass local checks. This checkpoint
does not complete Stage 07 or provide playable online multiplayer. The approved
[external implementation review](step1-review.md) is complete. Its
[response](step1-review-response.md) records the changes and the completed
read-only follow-up review.

## Scope

The new helpers provide strict Ristretto/scalar encodings, domain-separated HKDF,
hash-chain links, unbiased integer sampling, Feldman-verified Shamir shares,
Schnorr/DLEQ proofs, Pedersen bit and range proofs, Sigma range composition,
ECDH/HKDF sealed delivery and a compact 64-round shuffle proof. They accept
explicit inputs and contain no platform randomness or game-session state.

The [review manifest](step1-review-manifest.json) records SHA-256 hashes of 24
source, test and design files from the initial checkpoint. The review input hash is
`cbf974e779f003eb3b19a5e5a70504e496d970dc130e3569b2a7c0ed264db3da`.
This records the exact input of the completed first review. The follow-up has its
own [manifest](step1-followup-review-manifest.json).

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

After both reviews and their fixes, `pnpm check` passed **623 tests in 112 files**,
plus all type, lint, format, dependency, purity and i18n checks. `pnpm build`
passed every workspace package and the production web build. The coordinator
checked both exit codes. This working-tree check also includes the in-progress
beacon state, extension and derivation helpers for Step 2.

The final regressions include mathematically valid shuffle transcripts containing
duplicate or identity cards, and independently constructed false range/AND proofs.
The [mutation checks](step1-mutation-checks.json) show that removing the relevant
guards makes the targeted assertions fail. Source files were restored before the
final check and build. No browser was launched.

Game-session evidence verification, frozen operation state, deck/hand/steal
orchestration, escrow distribution, audit and replacement of the simulation driver
remain later Stage 07 steps. Browser worker performance and the full adversarial
game acceptance suite are not established by these unit tests.
