# Stage 07 committed-hand ledger review

Perform a read-only security review of this integration checkpoint. Tools are
disabled; the packet contains the listed source and tests, not live secrets.
Focus on concrete safety defects and missing high-value regressions. Do not
re-review the established curve primitives unless this integration misuses them.

This checkpoint adds mandatory public resource commitments to certified replay,
gross parent-balance debit obligations, six-bit spending proofs, a composable
command evidence envelope and owned-hand opening checks. Admission, voting and
objective command accusations share `validateCommandForEntry`. Replicated-log
admission also previews the candidate through `validateNextEntry` before retaining
or broadcasting a submission. Handled beacon/deck system inputs must fold hands.

Check that incoming credits cannot finance outgoing trade promises, a zero count
needs a real opening, proof contexts bind the full intent and statement, and a
permissive callback cannot replace missing evidence. Inspect deck/hand composition
for a way to omit one required section or substitute slots. Check replay/private
publication, missing ledgers and malformed or excessive proof envelopes.

Scope boundaries: signed Monopoly count delivery is the next checkpoint. Pure
count proofs are implemented and tested, but verified `REVEAL_COUNT` fails closed
before generic policy callbacks until its frozen operation/outbox exists. Every
verified `STEAL_RESULT`, named or hidden, is rejected until Step 5. Other-owner
trade proof transport is deferred to that step; a missing owned proof fails with
a distinct error. These paths are not enabled in the production online UI.

Initial hands are empty with zero blindings. Public changes preserve blindings.
No verified hidden transfer is reachable yet. Synthetic uncertain-hand fixtures
test proof obligations; they are not full legal peer histories. The legal deck
trace checks actual production/purchases and the replayed commitment ledger.

Existing `deck-reveal-v1` evidence is accepted only when no hand proof is required.
New driver output uses `command-proofs-v1` with exactly the derived deck/hand
sections. Protocol version remains 1 during this unpublished verified-mode
integration. Missing snapshot hand state fails closed; fresh replay derives it.
Mixed old/new verified peers and persisted consensus journals are not promised
compatible. Report any concrete compatibility risk before public online release.

Return findings by severity with the affected function, a concrete counterexample
and a focused correction. Separate implemented-scope defects from later Stage 07
requirements. Prefer a few targeted cases over large random-game batches.
