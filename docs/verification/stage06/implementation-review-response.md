# Implementation review follow-up

The [Claude review](implementation-review.md) was read-only and covered the
[approved file list](implementation-review-prompt.md). The review's claims are
being checked against code and focused regressions before Stage 06 acceptance.

## Second review

The [second Claude review](implementation-follow-up.md) used the same approved
file list. Its findings remain part of the Stage 06 acceptance gate.

- Finding 1 reproduced as `control-history` when restoring a complete session
  after a historical exclusion. Session restore now uses the certified replay
  path and applies private consequences in order. The regression checks the
  reconstructed hand and public state, with and without an exclusion.
- Finding 5 reproduced nine history reconstructions where three sufficed when
  alternating between two evidence heights. A bounded cache retains recent
  certified parent contexts. The regression confirms later checks reuse both.
- Findings 2 and 3 added terminal checks for local-key and second-offender
  evidence through live entries, replay repair and restored records. The third
  review identified remaining paths described below.
- Findings 4 and 6 through 9 added unknown-outcome results after an accepted
  submission, authenticated accusations before replay, terminal handling of
  conflicting certificates, bounded sync requests and serialized recovery.
- Recovery now retransmits the newest rounds first. A regression checks that a
  bounded burst delivers the current round before older saved messages.

## Third review

The [third Claude review](final-review.md) covered a subset of the same approved
files. It identified a blocking liveness trace: a delayed accusation against an
already excluded proposer can leave a stale pending control in the journal.
That can prevent later proposals and restoration. The adapter now treats that
evidence as already handled. A regression replays the old accusation, sends new
conflicting votes from the same excluded seat, commits an ordinary move, and
restores a journal containing an exact stale pending accusation. Restoration
clears that stale pending value through a persisted transition.

Further regressions cover a crash after retaining a second offender's evidence,
authenticated evidence inside a policy-rejected proposal, and the first proof
arriving through a valid proposal. The first proof now persists across a
competing gameplay commit. Forged outer signatures and forged embedded evidence
do not cause a terminal halt. Historical proposals and old certificates
authenticate before consuming replay-work slots. The full gate is still pending.

The first twenty-game-per-scenario batch stopped scheduling new jobs after
scenario 3 failed at game indices 1 and 4. The five already-started batches
completed with 23 passing games and two failed assertions. The failure concerned
whether a crashed proposer's height used a later term; no divergent history was
reported. These reports are retained in `network-acceptance-initial-failed` and
do not satisfy acceptance. The fault injector now waits until the surviving
voters know an applicable input and have armed proposal timers before crashing
the proposer. All five affected layouts now certify a replacement in a later
round while the original proposer is still offline. The full acceptance batch
must run again on the final source.

## Reproduced and fixed

- M4: A valid commit certificate or proposal justification could contain a local
  vote absent from the durable voting record. Three regressions failed before
  the fix. Authenticated current-height proofs now check the persisted local
  signature before use; an unknown signature causes a terminal halt. Restore
  performs the same check. Certificate tests now use actual recorded local votes
  or a quorum of other voters, instead of inventing the receiver's votes.
  Embedded votes in accusation evidence are independently authenticated before
  this check, so a foreign proposer cannot force a halt with a forged local vote.
- H4: A proposer could store arbitrarily many conflicting values for one round.
  The regression reproduced a third stored value. A round now retains at most
  two conflicting proposals, enough for its evidence; locked and justified
  values retain their independent proofs. Restore rejects an overfull record.
- H3: Queue congestion counted as misconduct. Overflow now drops the packet
  without a strike. A valid retransmission burst regression passes. Malformed
  and oversized packets still count against their sender.
- L4: Restore now reconstructs and revalidates accusations from durable
  equivocation evidence before regossiping them. Accepted accusations persist
  before gossip and retain their authenticated evidence parent across heights.
- H2: Terminal safety halts survive restart. A bounded record of the first proven
  offender survives a competing gameplay commit, and historical control entries
  validate against replayed certified context. A later distinct proven offender
  causes a durable terminal halt. Regressions cover catch-up from a control
  certificate without having received its earlier accusation.
- M3: Old and future commit envelopes authenticate before replay or sync.
  Expensive accusations, snapshot traffic and conflicting old commits share a
  per-peer replay budget. A continued sync response must advance the local
  certified head, not merely advertise a higher sequence.
  Historical-control proposals consume that budget before core validation can
  replay their evidence parent.
- L2: A send failure after retaining a signed command reports it as pending.
  It may still commit, so the submission does not report a final rejection.

- L5: Pending commands are limited to four per seat and 32 overall. Admission
  drops excess remote commands without evicting another seat's intent; local
  overflow is rejected before retaining or broadcasting it. A sender-flood
  regression preserves another seat's submitted command.

## Scope and retained behavior

H1 concerns the owner of the raw signing key. `create` is only the first
activation of a fresh game key; `restore` refuses missing safety records.
An API that accepts a copied raw key cannot establish whether the caller erased
another journal. Stage 06 injects that owner and journal. The simulation already
uses separate deterministic keys per game, explicitly as test fixtures. Stage
10 must store a nondeterministic per-game key atomically with safety records and
forbid initialization as a recovery fallback. This requirement is documented in
`docs/10-persistence-reconnection.md`; durable key ownership is not claimed here.

M1 has two paths. An authenticated certificate whose value fails deterministic
validation uses a persisted, repairable halt, whether received directly or
assembled from votes. If already-stored proposals cannot be revalidated because
the local derived context is damaged, the controller stops signing and retains
its journal. That path requires a fresh session restore and certified replay.
Existing controller regressions check the preserved journal and successful
fresh restore. In-place automatic recovery of every corrupted-cache path is not
claimed.

M2 and L1 describe the explicitly insecure simulation driver. A stub hash binds
an input to its parent but proves neither a hidden fact nor a deadline. A false
publicly plausible input can consequently fail the later private-state check.
Halting without rolling back its certified entry is intentional. Verified games
require their command and system proof verifiers before engine application;
Stage 07 implements these proofs. The production build excludes the stub UI and
driver. These limitations are now explicit in the Stage 06 document.

L2's nonce observation does not allow a command to cross a committed parent.
An uncommitted signed intent may still commit at its original parent after a
restart, so an unavailable transport cannot be presented as cancellation.

L3's earlier nil votes preserve the lock and do not certify a value. The timer
is armed only after a quorum of prevotes is known. Increasing round timeouts
still govern progress. No safety-rule change is warranted by this observation.
