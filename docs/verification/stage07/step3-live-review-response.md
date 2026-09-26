# Live deck review response

The [review](step3-live-review.md) found session lifecycle defects alongside
verification gaps. This remains a Step 3 checkpoint, not Stage 07 acceptance.

## Confirmed findings

- M1 reproduced with a throwing subscriber and with a throwing automatic-input
  hook after a certified commit. Session notifications now isolate each listener.
  Automatic selection runs in a guarded microtask and reports a diagnostic on
  failure. These exceptions do not roll back state or stop consensus.
- L2 reproduced with two authentic certified journal prefixes returned by the
  two restore reads. Startup rejects different private/public heads. Each private
  callback also checks its parent against the session's current head. The verified
  driver retains its own applied head and rejects skipped or repeated callbacks.
  Its initial state requires a genesis parent. Failed private updates do not
  advance this cursor.
- L3: temporary identity copies from session key validation are cleared in a
  `finally` block. Caller-owned keys remain untouched.
- L4: the driver factory receives the seats derived from validated local keys.
  Every keyed seat must have a matching private state. Verified sessions reject
  any additional private seat before initializing a voting journal. The simulation
  driver may retain other seats because its synthetic system inputs need an
  omniscient fixture; that exception is limited to stub sessions.
- L6: the inbox already retains a fully verified prefix. Building its candidate
  no longer repeats the same complete-draw proof verification. The independent
  certified-entry validator still checks all evidence before voting. The existing
  prepared-prefix cache already avoids repeated source derivation and storage
  access until the prefix changes.

## Decisions and remaining checks

L1's fail-closed storage behavior is retained. An outgoing persistence failure
stops this instance, and restore retries against the retained journal and outbox.
Both beacon and deck paths follow this rule. The tested failed restore emits no
new unlock or vote; a later restore with working storage completes the original
draw. An automatic browser storage-retry policy belongs with Stage 10 lifecycle
handling. No volatile fallback is allowed.

L5 identifies a latency risk, not a different accepted history. Contributions for
an operation not yet certified locally are ignored and resent by pulses. The
50 ms-link draw benchmark remains required; its result will determine whether
delivery needs a bounded early-message cache or another immediate retry path.

The follow-up tests restrict each host's deck source to its own human and hosted
bots, and exercise a real card play through `P2PSession.submit`. Earlier
`deck-draw.test.ts` cases already cover matching and mismatching CAS winners,
corrupt reservations and unlock records, and failures before secret access.
The private callback tests distinguish a failed private apply from a failed UI
notification. Further multi-seat draw, automatic victory-claim and performance
coverage remains part of completing Step 3.

Hidden steals, resource commitments and count reveals, escrow, the final audit,
browser persistence and the lobby remain unfinished. No public online mode uses
this partial verified driver yet.

## Follow-up review

The [follow-up](step3-live-followup-review.md) found no safety defect in the
continuity, ownership or inbox changes. Its packet preceded the final ownership
and live-knight tests, so its report correctly lists those as unavailable to the
reviewer.

- F1's claimed repair deadlock does not match the implementation. Successful
  `resumeAfterReplay` emits the retained certificate's commit, and private
  application resets the session to running. Tests cover both explicit repair
  and a valid `SNAPSHOT_RES`, with the recovered local player able to place a
  settlement. The snapshot path did retain a stale halted diagnostic; successful
  private application now clears that diagnostic. Terminal failures still halt.
- F2 reproduced with a throwing timer projection. Notification construction now
  runs inside the same guard as the listener. A broken view cannot turn a
  successful private application into a consensus failure. Each listener still
  gets its own projected state.
- F3's same-parent automatic-claim retry remains open alongside the required
  real automatic-victory integration test. The pending work is recorded in the
  [integration plan](step3-integration-plan.md). This checkpoint does not claim
  complete automatic-claim recovery or Step 3 acceptance.

The strengthened automatic-input regression uses a normal engine copy, records
that the failing hook ran, and checks its diagnostic. The driver unit regression
rejects skipped and repeated callbacks; the session regression rejects differing
certified prefixes on restore. A private callback failure leaves the accepted
entry in the journal and fails again when replayed with the same rejecting driver.

The reviewed microtask scheduler uses `Promise.resolve().then` in the final source
because the protocol package targets ES2023 without DOM or Node globals. This
preserves the reviewed scheduling order without adding a browser dependency.
