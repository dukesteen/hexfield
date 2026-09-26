# Certified hidden-steal lifecycle review

Review the attached exact source snapshot, read-only, with no tools or external
file access. Fixture keys are deterministic test data, never live secrets.
The user has authorized Claude reviews of this unpublished code.

The prior checkpoint supplied transfer/index proofs and sealed delivery. This
change connects those helpers to certified replay, owned private hands and live
peer delivery. It is not Stage 07 acceptance or a completed multiplayer release.

The replayed context freezes the operation from the certified beacon result,
genesis identities and victim commitments. A `steal-fixed` entry commits the
victim's contribution without changing hands. A hidden `STEAL_RESULT` requires
the thief's signed receipt; the mandatory shared log check runs before engine
application. Only the engine's exact matching hidden-transfer effect permits the
componentwise commitment fold. The result consumes the fixed beacon once.

A certified `steal-dispute` records a genuine authenticated bad opening and
prevents a later result. Exclusion, recovery and fairness UI are later steps.
A malicious thief can sign a receipt it should have disputed. Receipt/dispute
conflicts follow certified ordering; no later complaint rolls back a result.

The private driver owns only local keyed seats. It reconstructs the victim's
opening from retained secrets, decrypts for an owned thief, folds all transfer
blindings and counts into candidate maps, and publishes only after the resulting
owned commitments match. Replay reconstructs this without an ephemeral inbox.

Outgoing victim and recipient messages use immutable write-before-send stores.
One response slot holds either a receipt or a dispute. Restore verifies and
resends existing bytes. The delivery inbox is disposable; stale messages and
duplicates should avoid repeated proof work. Session options cannot inject raw
proof callbacks in place of the private driver. Verified replica startup requires
the proof callbacks and delivery store. Browser IndexedDB adapters remain later.

Focus on concrete safety, privacy, restart and liveness errors:

1. Can a sender choose or replace an index, ciphertext, participant key or parent
   commitment? Can an optional policy bypass mandatory steal verification?
2. Can a stale, duplicate, reordered or conflicting receipt/dispute move resources
   twice, consume a new beacon, or leave public and private state inconsistent?
3. Can storage races, disposal, retries or partial private failure publish or sign
   a second result? Are secret derivations stable across a restart?
4. Can an invalid delivery cause false blame, or can a valid dispute be ignored
   before certification? Distinguish self-harm by a dishonest owner from an attack
   on an honest owner or agreement.
5. Are cheap envelope/signature checks and bounded delivery caches sufficient to
   avoid obvious unauthenticated proof-work amplification?

The actual two-peer test drives legal play from genesis, drops the victim's
contribution, restarts both peers, checks byte-identical retransmission, commits
one hidden transfer, and verifies the same private hands after another restart.
The focused tests also cover proof failures, corrupt stores and private atomicity.
Do not ask for large random simulations. The existing eight-type Chromium proof
performance target is still open and no current browser timing claim is made.

Report severity, file/function, an explicit failing trace and the smallest fix.
Separate actual bugs from future escrow, audit, counterparty spending-proof
delivery, real WebRTC/lobby, and pre-release protocol-version work.
