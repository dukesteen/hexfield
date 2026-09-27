# Certified recovery implementation checkpoint

This checkpoint implements public recovery authorization and activation,
controller-key changes, durable share release and reconstruction checks. It is
not Stage 10 acceptance. The production online UI is still unfinished.

## Implemented behavior

- Recovery authorization requires the old certified quorum. It freezes the
  departed human and hosted bots, preserves pending cryptographic operations,
  and reserves fresh replacement keys. Activation requires checks from every
  remaining human and a certificate under the remaining membership.
- Readiness signatures follow durable storage of their exact replacement keys.
  An activated host can restore only keys that match the certified authorization
  and activation history. Pending replacement keys cannot control a seat.
- Original escrow holders release encrypted shares only after replaying a durable
  certified authorization. Outbox retries reuse exact ciphertext. Recipients
  verify the original commitments before reconstructing an affected master.
- Recovery checks replay public history and reconstruct every affected private
  hand. Recovered masters are saved before publishing approval. A restarted
  participant requires that private record before retransmitting an approval.
- The recovery participant coordinates shares and checks, bounds retained data,
  and suppresses output when the journal parent changes or the participant is
  disposed during I/O. Its caller must serialize prepare/send with journal
  commits and hold the browser writer lease.
- Live replicas gossip and certify recovery membership changes while an input
  is frozen. A removed local voter atomically saves its removal certificate and
  retired signing record, clears private ownership, and stops signing.
- A peer that missed its removal can use a signed higher-head heartbeat as a
  sync hint, verify the missing history, and retire. Former human keys may request
  history but cannot submit new commands, votes or contributions.
- The browser journal atomically commits entries and next-height safety records.
  The game writer lease prevents two same-origin workers from driving the same
  game/voter concurrently and drains accepted work before releasing its lock.

## Evidence

Focused tests cover a live four-voter authorization and three-voter activation,
delayed delivery of removal, refusal to reuse the retired key, original-share
reconstruction, exact retries after interrupted writes, private persistence
failure, activated-key restoration, and participant disposal during I/O. The
live replica test keeps the original beacon pending; it does not claim that a
recovered bot has completed a game.

The native [journal check](native-journal-check.md) and
[writer lease check](native-writer-check.md) passed in Chrome using two workers.
The writer run displayed all nine completion lines. No automated Firefox or
WebKit process was launched for these checks.

The 2026-09-27 verification run passed all static checks: production and test
typechecking, lint, formatting, dependency boundaries, engine purity and i18n.
The full unit suite took 162.68 seconds, with 1,090 passing tests, one outdated
error-code assertion and one intentionally skipped draw benchmark. The assertion
still expected membership handling to be unavailable; it now expects rejection
because the stub fixture lacks a verified recovery context. All six tests in
that file pass after the correction, as do its formatting and lint checks.
No implementation source changed after the full run. Together these runs cover
1,091 passing tests in 181 files; the complete suite was not repeated solely for
the assertion correction. The production build passed.

The [verification record](recovery-verification.json) links the command logs and
the 604-file manifests before and after that test correction. Hash comparisons
confirmed that only `packages/protocol/src/log.test.ts` changed between them.

## Remaining work

The participant's release/check packets still need live message routing. The
active bot host still needs to install recovered private drivers, signing keys
and beacon sources into the running session. Browser writer leases need their
production session consumer. Remaining Stage 10 work includes offline/takeover
policy UI, resume flows, returning humans, certified cross-device transfers,
save import/export, and complete recovery games followed by a successful audit.

Stage 07's complete audit, cheat integration and performance/chaos acceptance
remain open. Stages 08 and 09 still need their remaining networking, signaling,
lobby and end-to-end acceptance work. The next Claude implementation review is
pending its usage-limit reset. Milestones C and D remain incomplete.
