# Live deck checkpoint

This checkpoint connects verified deck operations to live replicas and owned
private state. Step 3 and Stage 07 remain incomplete.

`DECK_CONTRIB` delivers signed ordered unlock prefixes for the locally certified
draw. Each host checks its human and bot keys and persists outgoing reservations
and unlocks before sending. A restarted peer retransmits the same bytes and
certifies the same card. `VerifiedSessionDriver` reconstructs only owned hands
from certified history and produces reveal evidence before session commands are
signed. A real two-human, two-bot test restores the private hand and plays its
knight through both live sessions.

Private application is atomic across owned seats. The session checks driver
ownership before journal initialization and detects a journal change between
private and public restore. Both the session and driver enforce applied-head
continuity. Notification and automatic-input exceptions cannot turn a successful
private apply into a consensus failure. Snapshot repair clears a stale halted
diagnostic after applying the retained certificate.

## Local evidence

- `pnpm check`: 737 tests in 130 files passed, plus production/test typechecking,
  lint, formatting, dependency checks, engine-purity checks and i18n checks. Raw
  log: `/private/tmp/hexfield-step3-live-bounded-check.log`.
- `pnpm build`: workspace builds and the production web bundle passed. Raw log:
  `/private/tmp/hexfield-step3-live-final-build.log`.
- The final run set `VITEST_MAX_FORKS=2`, `VITEST_MIN_FORKS=1`,
  `VITEST_MAX_THREADS=2` and `VITEST_MIN_THREADS=1`. An earlier unrestricted run
  passed 733 of 734 tests but measured 1.253 ms against the existing one-millisecond
  longest-road bound under concurrent crypto load. That unchanged engine test
  passed in isolation and in the final full run. No timing threshold was relaxed.
- The live deck tests cover missing source/store or hosted keys before journal
  initialization, missing/foreign private-driver seats, dropped unlocks, a failed
  durable write on restore, exact retransmission, certified dealing, owner-only
  restoration and certified knight reveal. Host factories retain only locally
  owned human and bot masters.
- The session suite covers a second successful command despite a throwing
  subscriber, automatic-input and timer-projection failures, split journal reads,
  and explicit/snapshot repair with usable local commands. A failed private
  callback leaves the certified entry in the journal and fails on replay with the
  same rejecting driver. Driver tests reject skipped/repeated callbacks and
  demonstrate atomicity with an observable first-seat change followed by failure.
- No browser process was launched for this checkpoint.

The [source manifest](step3-live-source-manifest.json) records 193 source/test files
with fingerprint
`9942dd06a80d38c3fe5ea0b87ea124bba92c59e3fcd9d1dc49be58e7474c7d17`.
It was independently recomputed after the final source changes. The
[review response](step3-live-review-response.md) covers both Claude reviews,
reproduced defects, rejected claims and remaining work. Review packets each have
their own source manifest.

## Remaining work

The [integration plan](step3-integration-plan.md) retains automatic victory-claim
coverage and retry, larger-roster/adversarial delivery cases, the complete draw
latency benchmark and the unmet three-second Chrome shuffle target. Resource
commitments, sealed steals, escrow, final audit and real-crypto chaos acceptance
remain later Stage 07 work. WebRTC, the lobby and browser recovery remain stages
08–10. This code is not exposed as a production online game yet.
