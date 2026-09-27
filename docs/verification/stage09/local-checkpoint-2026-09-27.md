# Local multiplayer checkpoint, 2026-09-27

This checkpoint adds signed chat, automatic capture of rejected signed proofs,
and a writer-lease loss callback. It does not complete M-C or M-D, move the online
protocol into a worker, or establish a new deployment.

## Changes

Chat has separate signed lobby/game scopes, bounded ingress and history,
reactions, mute controls and persisted history. The [two-profile browser check](chat-browser-check.md)
covers lobby delivery, scope transition, game delivery, restoration and phone
viewport layouts. The [Claude review disposition](chat-review-disposition.md)
records fixes for queue fairness, duplicate history, mute updates, delivery errors,
receive-window jitter and roster changes during a durable write.

Rejected signed protocol artifacts can now be extracted without weakening the
normal message decoder. The objective verifier checks every candidate before
it is stored or gossiped. The new two-peer bad-beacon test injects an actual
signed invalid reveal, certifies one finding with both votes, keeps the owed
outcome and public engine state unchanged, suppresses repeats and restores the
finding from the journal. Four extraction tests cover bounds, malformed inner
proofs, parent/genesis binding, ordered unlock prefixes and forged signatures.
The [capture review](../stage07/cheat-capture-review-disposition.md) found no
confirmed authentication or consensus defect. Worst-case capture latency is
still unmeasured; capture remains in the serialized receive task.

`GameWriterLease` now offers synchronous `onLost` notification and fences pending
work after unexpected lock loss, including while an explicit close drains the
queue. Normal release stays silent. Eleven focused tests pass. The
[worker design](online-worker-design.md) requires this hook to stop active network
signing, but that integration and the worker itself remain unfinished.

## Local checks

- `pnpm check:static` passes production/test types, engine ambient-global checks,
  Worker types, typed lint, format, dependency boundaries, purity and i18n.
- `pnpm build` passes. Existing bundle-size and unused-translation warnings remain.
- The complete uninstrumented workspace run took 319 seconds: 231 files passed,
  one file failed and one file was intentionally skipped. It passed 1,348 tests,
  failed two newly added chat regressions and skipped two opt-in tests. Those
  failures were captured while their fixes were being written, so this is not an
  unchanged-source full-suite pass.
- After freezing the corrections, the affected chat, panel, room-registry,
  online-game-screen and writer-lease files passed all 35 tests in five files.
  The two former failures now pass. Static checks and the production build ran
  again on the corrected source. The expensive unaffected crypto suite was not
  repeated.
- The dedicated capture integration and historical-finding regression passed
  10/10 before the workspace run. The workspace run also passed them.
- The production dice sampler check passes 100,000 rounds in about 1.9 seconds,
  testing each face distribution and the 2d6 sum distribution against predeclared
  chi-square bounds. It does not simulate 100,000 games.

The CI runtime fix is a separate commit, `1cf9636`. It retains the full functional
suite and the engine's 90% line / 85% branch thresholds, while applying V8 coverage
only to engine tests. Its local coverage run passed 180 tests with 98.29% lines
and 86.6% branches in about 14 seconds. GitHub run `36312974323` was started for
that commit; its final outcome is recorded separately, not inferred from the
local checks here.

Raw Claude inputs and responses are excluded from formatting so the reviewed
bytes and verbatim responses remain intact. Source and authored review
dispositions still pass formatting.

## Remaining work

Online setup and live engine/crypto still run on the main thread. Moving them
into the designed worker is the remaining responsiveness work. Invalid-crypto
proposer consequences, visible fairness state, seat transfer/return and the
remaining browser/performance acceptance also remain open. See the
[current M-C matrix](mc-remaining-acceptance.md) and `docs/STATUS.md`.
