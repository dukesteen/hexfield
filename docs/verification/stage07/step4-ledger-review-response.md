# Committed-hand ledger review response

The [read-only review](step4-ledger-review.md) found no high-severity safety defect
in the implemented proof checks. It confirms parent-balance debit accounting,
zero-count openings, complete proof contexts, mandatory checks before optional
callbacks, bounded evidence and private publication checks. The
[manifest](step4-ledger-review-manifest.json) identifies the exact reviewed packet;
additional tests below were added afterward.

## Added regressions

- Two real engine trade forms, with explicitly synthetic uncertain hands, require
  both owners' gross debit proofs. An active-only private driver returns
  `hand-proof-owner` when the other owner's proof is unavailable.
- Substituting the parent commitment invalidates the original spending proof.
  Two independently owned obligations reject reordered proofs, and a count proof
  cannot replace a range proof.
- Envelopes above 30 hand proofs or 128 deck entries fail before range verification.
- The existing certified purchase trace supplies a parent for a synthetic uncertain
  hand fixture. Missing required evidence fails both command admission and entry
  validation before a permissive callback. A signed proposal containing that
  command is objective accusation evidence only at its matching parent; a stale
  parent remains contextual.

The combined gate also found a simulation-only callback regression: proof policy
was invoked for stub commands without evidence. Restored the previous conditional
behavior while keeping verified command policy after mandatory built-in checks.
The affected 19 session tests pass after the correction.

## Open integration boundaries

**M1 — unfinished phases can stall a verified game.** A Monopoly play can certify
before its signed count delivery exists, and a robber move can lead to a steal
whose transfer protocol is unfinished. Rejecting the final result protects safety
but does not provide liveness. This remains open; it is not fixed by these tests.
The next count-delivery checkpoint and Step 5's sealed transfer path must resolve
it before Stage 07 acceptance or production online play. This unpublished driver
is not exposed in the production game UI. We are completing those paths rather
than adding temporary UI filters that would immediately be removed.

**L1/C1 — wire compatibility.** Legacy deck-only evidence remains a deliberate
transition path for commands with no resource obligation. Every command has one
strict evidence envelope; it cannot mix two envelopes or omit a required section.
A protocol-version gate and an explicit legacy cutoff remain required before
public verified deployment. Old verified consensus journals and mixed-version
verified peers are not promised compatible. Missing ledger snapshots fail closed.
Local saved games do not use this protocol and retain their engine state hashes.

**L2 — supported resource limits.** The six-bit maximum is a precondition for
verified modules, alongside explicit resource effects from hooks. The base game
cannot reach more than 63 cards of one resource. Expansions must review these
limits before enabling their rules in verified mode.

Pure system proof checks reject any required obligation when no proof is supplied.
Count delivery, uncertain-hand timeout handling and other-owner trade proof
transport still need their dedicated integration tests. Blindings currently replay
from zero because all enabled resource changes are public. Step 5 must supply
verified hidden-transfer blinding updates and their durable recovery.
