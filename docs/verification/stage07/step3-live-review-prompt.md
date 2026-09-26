# Live deck and private-session review

Review this Stage 07 Step 3 integration for concrete security, correctness and
liveness defects. This is a read-only review. Do not write code, run tools, or
change the protocol. The user has given standing approval for project Claude
reviews. Supplied keys and secrets occur only in deterministic test fixtures.

The previously reviewed checkpoint is local commit `f64ac4a`. It binds the
canonical base deck and signed setup transcript to genesis, certifies those exact
passes, freezes draw operations from the replayed engine pending, verifies full
CARD_DEALT unlock chains, and requires owned reveal proofs before command votes.
Its ledger review artifacts are supplied for context, not a request to repeat
that whole review.

The new code connects these helpers to live replicas:

- `DECK_CONTRIB` carries an ordered signed unlock prefix for the local certified
  operation. Peers can relay valid prefixes. Stale operations are ignored.
- `prepareDeckUnlock` reserves every locally controlled participant, including
  the drawer, and persists each outgoing unlock before it is broadcast. A source
  factory reconstructs fresh disposable deterministic per-deck secrets.
- Human and hosted bot keys are checked against genesis, copied for the replica,
  and cleared on disposal. Verified deck sessions require keys for all locally
  hosted bots and durable contributions before journal initialization.
- Pulses and reconnects resend prefixes. A complete inbox produces CARD_DEALT
  before ordinary command candidates. Certified entry validation remains the
  authority. Invalid fresh prefixes are bounded; exact rejected retries are cheap.
- `VerifiedSessionDriver` retains only controlled-seat private state. It decodes
  certified owner receipts, applies owned private state transactionally, and
  checks resource totals/bounds and private/public slots. It fails closed for an
  owned hidden steal, which is not implemented in this step.
- `P2PSession.submit` calls `prepareCommand` with detached context before signing,
  including automatic victory claims through the same path. The driver derives
  reveal proofs bound to the whole command, parent, seat and nonce. Restore replays
  certified entries through the same private callback.

Examine stale/future/concurrent messages, order and reconnect behavior, durable
write failures and retries, secrets or card identities leaking to other peers,
sender flooding, caller-owned mutable data, driver failure after public commit,
and nonce/proof reuse. Check that a permissive optional policy cannot override
the built-in deck checks. Distinguish true defects from unsupported later work.

This is not Stage 07 acceptance. Resource commitment accounting, sealed steals,
escrow, final audit, browser persistence and the lobby remain later work. The
test policy permits public engine-legal commands while built-in beacon/deck checks
still apply. No claim is made that this permits full verified games yet. The cold
browser shuffle performance target remains unmet.

Return findings ranked by severity, with source references, a concrete failing
trace, and the smallest reasonable correction. Identify verification gaps
separately. Existing positive network testing uses two humans and two bots, a
real 25-card transcript, legal setup/production/purchase, packet loss, exact
durable retransmission, a certified deal, and private session restore. Additional
storage and driver-failure assertions are still being added, so assess the
implementation independently of their presence.
