# Verified owner-private discard expiry

The focused production `P2PSession` trace passes in 34.459 seconds, with a
35.58-second runner duration:

```sh
pnpm exec vitest run packages/protocol/src/private-discard-timer.test.ts \
  --maxWorkers=1 --minWorkers=1
```

Four human verified sessions legally place their setup pieces, roll through the
seeded beacon, discard when required, and complete an actual hidden steal.
A later seven reaches a discard parent with genuinely uncertain public resource
bounds and at least two cards in an affected owner's private hand. The fixture
sets the schema-valid discard limit to zero and a 30-second discard timer before
signing genesis. Other phase timers are 600 seconds. No hand is gifted, no dice
result is injected, and acceptance is not mocked. The trace is bounded to 120
legal choices and a 120-second test limit; it does not finish a game.

At that parent, a public system timeout is refused with
`private-discard-required`. A foreign session has no private state for the owner
and cannot submit even the owner's otherwise-valid discard. All certified heads
remain unchanged at one millisecond before local expiry. At expiry, production
automatic scheduling signs each pending owner's `DISCARD` with that owner's key.
The test verifies those signatures, discarded private counts, exact public hand
totals and the corresponding bank returns. All four peers retain identical
ordered entries and final heads; each peer's own quorum certificates strictly
replay to the same public state. Valid quorum subsets may differ between peers.

The final run passed after fixing fixture scheduling and assertions. Initial
attempts selected the next player before automatic work completed, then selected
an appended claim-only prompt instead of the remaining discard owner. A later
attempt passed timer, signature and accounting checks but incorrectly demanded
byte-identical quorum subsets. Those were harness failures, not product bugs;
production code and the timer bound were unchanged.

The [terminal stdout](private-discard-timer-2026-09-28.log) and
[source manifest](private-discard-timer-2026-09-28.json) are retained. The manifest
pins the final test/helper source and relevant production files after the run;
it is not a before/after immutability claim. Shared test typecheck and scoped
lint, formatting and diff checks passed. No competing crypto workload ran.

Together with the existing [signed system timer checks](../stage10/timer-acceptance.md),
this supplies the missing owner-private discard expiry path. It does not add
browser timing, takeover, guest-hosted bot commands or the durable
consent-write/abort race. Broader Stage 09 acceptance remains separate.
