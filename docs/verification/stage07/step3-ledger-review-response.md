# Deck ledger review response

The [first review](step3-ledger-review.md) covers the source recorded in its
[manifest](step3-ledger-review-manifest.json). The user has authorized all
project Claude reviews. Review packets contain source, design and deterministic
test fixtures, with no live credentials or game secrets. Claude runs in safe mode
with tools, hooks, custom instructions, MCP and session persistence disabled.

## Command admission

H1 is fixed by checking a complete prospective entry before admitting a command.
`deriveCandidate` is shared by local submission, remote SUBMIT admission and
candidate generation. It applies the reducer, signs a disposable entry and runs
`validateNextEntry`, including the required reveal, additional command policy,
invariants and pending-request capture. The preview is never transmitted,
persisted or used as an operation authority. Remote admission first checks the
signed command's exact parent, nonce and public legality. A repeated accepted
remote command returns before proof verification. Candidate generation removes a
command that no longer passes, so it cannot block later commands or cause an
honest proposer to broadcast invalid evidence.

The replica regression uses a real legal setup command and two voters. It rejects
bad local and remote proofs, checks duplicate admission avoids repeated work,
changes a policy after admission to exercise candidate rejection, and certifies a
subsequent valid command without excluding a proposer. The deck-log regression
separately checks actual Knight and false victory-card evidence through the shared
admission function with a permissive policy. The follow-up regression also rejects
reducer and invariant failures before queueing on followers, addressing R3.

The [follow-up review](step3-ledger-followup-review.md) found R1, where a peer could
repeat invalid proofs without a strike. A failure after the cheap command gates
now counts toward disconnecting that sender after five distinct failures. Exact
retries reuse bounded rejection records; stale retries remain unpenalized. A full
per-seat queue rejects additional variants before proof
work. The test checks both behaviors and confirms that blocked retries do no more
proof verification. Third-party relay remains allowed; it does not bypass these
checks or the sender's limit.

For R2, `verifyCommand` now explicitly requires a pure, deterministic verdict from
the signed command and certified public context. Objective invalid-command
evidence uses the same `validateCommandForEntry` proof checks, with the policy from
the replayed parent, including historical replay. Missing verifier configuration,
exceptions and stale context do not establish misconduct. Tests cover rejected,
accepted, unavailable and throwing policies. A state-hash disagreement alone
still does not establish an invalid command.

## Consent and immutable evidence

M1 is addressed by `prepareGenesisConsent`, the required outgoing consent API.
It canonical-copies the final body, verifies the deck transcript and local human
key, then atomically stores one final digest and signature per ceremony and seat.
A retry must match those bytes. A different final body cannot reuse that ceremony
reservation. Storage errors return no consent. The helper copies its signing key
before awaiting storage and clears that copy on every exit. Tests cover restart,
competing redrafts, corrupt records, wrong keys and failed writes.

The lower-level signers remain internal helpers and are not exported from the
package entry. The store contract requires transaction completion before returning
success, not an IndexedDB request-success notification. Stage 09 must use the durable API,
generate fresh game keys and ceremony nonces, and retain its stores. The browser
storage implementation and lobby ceremony are not part of this checkpoint.

L4 is fixed by copying each raw signed pass once before hashing and proof
validation. Both operations consume that same detached value. A hostile descriptor
regression checks that the raw pass is read only once.

## Repeated work and message bounds

M2 is reduced by a 32-entry successful-proof cache. Its key hashes the complete
validated predecessor and full signed pass, including proof bytes. It retains only
hash strings, never caller-owned state or results. Actor, order, signature, output
and resulting-state validation still run. Changed proofs and predecessors cannot
use a warmed result; failed proofs are not cached. Mutation tests cover both
shuffle and lock passes. The real deck-log test fell from about 27 to 14 seconds
locally after this change; that measurement is not browser performance acceptance.

`decksReady` now reads the cursor of an already validated replay-derived ledger.
The external contribution-preparation boundary still validates its ledger first.
Ledger validation compares the committed definition to the validated setup instead
of reconstructing the same initial points. Per-slot operation checks and certified
historical replay remain in place. The cold browser setup performance target is
still open.

L3 is fixed by strict local transcript envelopes, exact committed hashes and a
requirement to retain every uncommitted pass before startup or partial restore.
A complete certified journal can restore without duplicate local pass blobs.
The constructor retains the same parsed transcript copies that passed validation;
it does not reread caller objects afterward. Startup tests reject missing and
mismatched passes before initializing the journal.
L6 is fixed by authenticating a proposal signature before its expensive entry
proofs are checked. The controller also compares an incoming proposal's complete
canonical bytes to its already validated private records before invoking the
state transition. An exact replay skips proof work and persistence. A proposal
whose current-round prevote still needs recovery follows the normal path.

The [final correction review](step3-ledger-final-review.md) accepted the checkpoint
with two further robustness findings. F1 is addressed by a bounded 16-entry
failure cache in the controller. It keys the full canonical proposal and retains
only non-control entry-validation failures at the controller's fixed certified
parent, never consensus-state failures. Repeats return without deriving the entry again. The
adapter also strikes rejected proposals at its exact current parent, including
fresh variants, so a proposer cannot evade the bound by changing proof bytes.
The regression checks eviction, unchanged persistence, subsequent valid proposals
and disconnection after five invalid variants.

F2 is addressed by catching exceptions in signed-command validation and candidate
derivation. They reject the input rather than disposing the replica. Tests inject
throws into both engine validation and application, then certify a valid move on
the same replica. These failures do not support objective accusations.

The [guard review](step3-ledger-guards-review.md) found that exact retries could
consume repeated strikes after a local fault. The adapter now records each rejected
command or proposal hash once per certified parent, with a 16-value bound. Commit
and repair clear those records. Repeated SUBMITs skip validation; repeated proposal
rejections are wrapped without another strike. Distinct invalid variants still
reach the sender limit. Tests repeat an injected invariant failure six times and a
proposal validator exception eight times without disconnecting the peer. The exception
test also confirms that no accusation or vote is emitted and the replica remains
available for repair.

Control failures are excluded from the controller cache because their evidence can
reveal a second offender after another proof is retained at the same height. A
four-voter regression first rejects a wrong-state-hash control, stages a different
offender's proof, then replays the exact control and checks the persisted terminal
halt. This preserves the state-dependent fault check.

The package exposes only its root and explicit testing entry, with no deep source
exports. Preview anchors have valid hashes and a later sequence than deck creation;
beacon freezing checks their shape but does not choose validity from their content.
They are discarded after admission and never authorize an outgoing contribution.

For L5, a real 25-card first shuffle against a six-seat canonical manifest fits in
schema-valid maximum-digit envelopes. PROPOSAL with six prior prevotes is 13,000
bytes, COMMIT with six precommits is 12,808 bytes, and ACCUSE containing two full
proposals is 26,091 bytes, below 262,144. The certificates in this size test are
explicitly synthetic envelope fixtures, not claims of certified game history.

## Scope clarifications

L1 is not an engine/protocol mismatch. `claimVictory` requires at least one hidden
slot. A win entirely from public points is detected automatically in the base
module's `refresh` path.

L2 identifies remaining lobby duties. The deck-signing helper does not claim to
check every game configuration or reconstruct the signer's private sources. Stage
09 must run those checks before outgoing consent. Actual verified genesis
initialization already requires matching module version, canonical base catalogue,
complete roster and exact engine deck keys/counts. Only the base deck is configured
here, so the reported multi-deck ordering concern is not reachable in this stage.

Step 3 and Stage 07 remain incomplete. Live unlock gossip, owner-only session
application and replay, automatic reveal-evidence production and browser durability
still need integration. The isolated `DeckInbox` verifies ordered prefixes and
constructs a complete deal candidate, but does not yet send or receive messages in
a live replica.
