# Stage 07 helper review follow-up

Review the attached current cryptographic helpers and tests for concrete
correctness or security defects. This is read-only. Do not write code, run tools,
open other files or access external services. The user has approved these project
reviews. The bundle contains project source and public test fixtures, no actual
game secrets or credentials.

The original review and coordinator response are included. Check that F1-F8 are
addressed without introducing a new flaw. Focus on the new CDS OR composition,
composable Schnorr, proof-mode nonce separation, expected Feldman parameters,
and stronger verifier tests. The CDS helper permits up to eight branches, each
with an opening and zero to two ranges. The steal protocol later supplies the
exact one-hot/index statements and fixed widths from certified state; this helper
does not choose application statements.

Require one outer Fiat-Shamir challenge over all ordered statements and first
messages. Every opening/range component must use its branch challenge; all branch
challenges must sum to that outer challenge. Simulated false branches are valid
Sigma transcripts at chosen challenges but must not pass complete OR verification
without a true branch. Check whether mode or context reuse can leak witnesses.
Prepared responders are only for noninteractive composition and must answer once.

Report confirmed issues with precise inputs or algebra. Distinguish misuse of a
documented caller contract from an actual helper flaw. The generic shuffle limit
stays at 128 cards; protocol callers enforce the expected deck size and operation
before verification. Revisit any test that appears strong but would still pass if
the tested validation were removed.

Do not infer full Stage 07 acceptance from helper tests or this review. Browser
worker timings, full-session integration, setup, secret recovery and the later
adversarial acceptance suite are still outstanding.
