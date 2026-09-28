# Ceremony timeout and disclosure integration

Focused checks on 2026-09-28 add four missing pre-consent phase-timeout cases and
a genuine authenticated post-consent disclosure through the coordinator, startup
controller and rendered lobby UI. These are protocol/component fixtures, not
browser or full-game traces. Production code is unchanged.

```sh
pnpm exec vitest run packages/protocol/src/online-ceremony.test.ts \
  -t 'missing .* retires .* before consent' --maxWorkers=1 --minWorkers=1
pnpm exec vitest run apps/web/src/features/online/OnlineLobby.ceremony.test.tsx \
  --maxWorkers=1 --minWorkers=1
```

The four protocol cases pass in 339 ms, with a 1.01-second runner duration.
They withhold the actual signed creation timestamp, approval, beacon tip or seed
reveal, exercising `frozen`, `approvals`, `beacon-tips` and `seed-reveals`.
Each observes the original 20-second deadline, durable retirement, no consent or
genesis result, and refusal to revive the same attempt after restart. Existing
cases cover bindings, escrow, deck and seed-commit timeout paths, invalid signed
shares/passes, explicit abort and interrupted retirement. Escrow lifecycle tests
separately prohibit reuse of retired reserved masters.

All three UI bridge cases pass in 19.938 seconds, with a 22.00-second runner
duration. Existing timeout cases prove genuine pre-consent retirement and
post-consent waiting across restore, then assemble the exact retained agreement
when the missing signature arrives. The new disclosure case uses four real human
ceremonies, an actual produced escrow envelope, the holder's persisted material,
a holder-signed DLEQ dispute and a device-authenticated ceremony packet. It
reaches the production coordinator before the startup controller halts the
rendered UI. Consent remains durable across restore; game opening, retry and a
new-room action remain unavailable. The deliberately false complaint still
constitutes authenticated secret disclosure under the ceremony policy. This
check establishes the restored halted/waiting state required by the acceptance
criterion. It does not claim that normal gameplay resumes after disclosure.

Shared test typecheck, scoped type-aware lint, formatting and diff checks pass.
No concurrent crypto workload ran during either focused test command.

The focused leaves this report initially identified now have separate
acceptance evidence: the [owner-private discard expiry](private-discard-timer-2026-09-28.md),
the [guest-hosted bot command](guest-bot-consent-races-2026-09-28.md), and both
winners of the [cross-coordinator abort-versus-consent race](guest-bot-consent-races-2026-09-28.md).
Early signed timeout refusal remains covered for `preRoll` and trade at verified
replicas. The [retained-evidence opening fence](disclosure-opening-fence-2026-09-28.md)
adds real-coordinator evidence that an authenticated disclosure remains durable
and blocks activation after restore. Together these checks satisfy the Stage 09
promise-plus-recoverable-waiting criterion; they do not require normal gameplay
to resume after disclosure.
