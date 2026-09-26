# Hidden-steal proof and delivery checkpoint

This checkpoint adds the proof and private-delivery helpers for Stage 07 Step 5.
It does not enable verified robber steals in the live protocol. The certified
entry lifecycle, peer delivery and private hand updates still need integration.

## Implemented behavior

- One-hot transfer commitments and a CDS index proof compose a branch opening
  with two six-bit ranges. The pure verifier supports one through eight types;
  the base-game wrapper requires exactly five. Proofs bind the complete statement,
  frozen operation and ciphertext hash.
- Victim-signed contributions seal the resource index and transfer blindings to
  the thief. Every resource uses the same plaintext and ciphertext lengths.
- Receipt production checks the provisional opening. Receipts bind the fixed
  contribution entry and signed body without depending on the eventual result's
  parent. Public disputes authenticate the shared ECDH point with a DLEQ and
  prove an invalid opening. An honest opening cannot support a valid complaint.
- Unauthenticated receipts and disputes fail before expensive transfer proof
  verification. A failed transport value is not automatically accusation evidence.
- A master-backed source derives per-seat encryption keys from the original
  signing identity and fresh ceremony nonce. Proof seeds use separate domains.
  Disposal clears retained master bytes; bigint cleanup remains best-effort.
- Verified genesis and consent require distinct canonical nonidentity encryption
  keys for every human and bot. The roster places them in the pre-deck ceremony
  manifest and final signed genesis. Stub games cannot claim those keys.

## Focused evidence

The [review response](step5-foundation-review-response.md) records the security
review and corrections. Tests cover zero-resource gaps, first and last indices,
large prefixes and totals, eight types, malformed dimensions and encodings,
wrong one-hot transfers, shared challenges, and a forged zero-count CDS branch.
Delivery tests include an authenticated malicious ciphertext with a genuine
public transfer proof, valid and false disputes, changed-context signatures,
recipient signatures, fixed-entry replay, and verification cost ordering.

The encryption-key roster changes deterministic deck permutations. A bounded
permutation scout selected replacement fixture seeds without repeatedly creating
full shuffle proofs. Monopoly uses seed 16 with its original board, victory-card
recovery uses seed 3 with its original board, and Knight unlock recovery uses
seed 3 with the existing board-50 placement order and a specified human buyer.
The same legal command limits and durable-restart assertions remain. Their
focused traces passed in about 29, 52 and 33 seconds respectively.

## Full local gate

The [combined check](step5-foundation-check.txt) passes type checks, lint,
formatting, dependency boundaries, engine purity, translation-key validation and
832 tests in 145 files. One opt-in draw benchmark is intentionally skipped.
Vitest completed in 175.89 seconds with at most two workers. The
[production build](step5-foundation-build.txt) passes.

The [source manifest](step5-foundation-source-manifest.json) covers 246 files in
codec, crypto, engine, protocol and simulation source, including nested fixtures.
Its fingerprint is
`9f597b83bff7efd92a92f9c3074e2551a87cc6a18dc11c7527bb02c47b593f5d`.
The source remained unchanged during verification. Final documentation updates
were formatted afterward.

## Remaining acceptance work

The live log still rejects `STEAL_RESULT`. It must derive the operation from the
certified beacon, certify the victim's fixed contribution, verify a receipt or
record a dispute, consume the same beacon outcome exactly once, and atomically
update public commitments and owned private counts and blindings. Persisted
messages must survive restarts without selecting a new transfer. Uncertain
counterparty trade proofs, cheat evidence, escrow and audit remain required.

The eight-type 300 ms Chromium target remains open. Contended Node measurements
suggest the group work needs optimization. A private-process generator-cache
experiment improved the diagnostic, but still exceeded that target. The raw
[window-four](step5-generator-precompute-4.json) and
[window-eight](step5-generator-precompute-8.json) measurements retain the valid
proof results and process details. It changed no production code and is not a
browser acceptance measurement. Existing deck
timings predate this new genesis format and are not fresh performance evidence.

No browser process, physical-phone test or large simulation batch ran for this
checkpoint. The unpublished verified format still needs an explicit protocol
version and migration cutoff before release. Milestones C and D remain open.
