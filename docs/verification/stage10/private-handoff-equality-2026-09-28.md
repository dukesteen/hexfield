# Exact private equality at focused handoff boundaries

Current-v6 focused session checks pass:

```sh
pnpm exec vitest run packages/protocol/src/transfer-session.test.ts -t 'fresh host takes a recovered bot' --maxWorkers=1 --minWorkers=1
pnpm exec vitest run packages/protocol/src/p2p-recovery.test.ts --maxWorkers=1 --minWorkers=1
```

The transfer case passed in 11.977 seconds (13.11-second runner). Before preparing
the real sealed private transfer, the current source session captures both its
human and recovered bot private states at the certified authorization parent.
The imported driver must match both complete snapshots and owned hand blindings
at that same parent. Restoring the activated destination must preserve them:
activation changes authority, not private material. Existing exact-master,
signature, custody, stale-key and outbox retry assertions remain intact.

The recovery/return case passed in 23.496 seconds (24.49-second runner). The
original owner is opened with a genuinely deactivated network transport, so it
cannot reveal its queued beacon to survivors. Its actual private state and
blindings are captured before its process closes. Reconstruction using the
recovered secret at that exact retained prefix must match those snapshots.
The survivors then complete certified recovery, a real bot setup command,
restart and another bot command. At the return authorization parent, the live
recovered bot's complete snapshot and blindings are captured. An independent
reconstruction at that same certified parent must match them exactly; replay
after return activation must still match. The former host loses control without
losing its own human hand.

Each complete engine snapshot includes seat, resource hand, development-card
slots and module extension data. Blindings are stored separately, so a test-only
read helper inspects the actual driver map, guards it as a Map and canonicalizes
only the named owned seat's record into a detached copy. These copies are never
fed into the protocol. No production API, validation or private input changed.
These setup-prefix fixtures do not claim nonempty coverage of every card or
resource branch, a fresh returned-human next action, or every-sequence equality.
The separate [representative persistence lifecycle](persistence-lifecycle-acceptance.md) supplies every-sequence
omniscient comparison; [native lifecycle evidence](native-takeover-acceptance.md) supplies continued returned
human play and full recovered-bot finish/audits.

An initial recovery attempt failed because its fixture requested a transport
after crashing that peer. Retaining the real handle before crashing fixed the
harness; the existing 60-second bound was unchanged. Final scoped lint,
formatting and diff checks passed. Shared typecheck found only the concurrent
`imported-transfer.e2e.ts` optional-baseURL edit, with no error in these tests.
The [source manifest](private-handoff-equality-2026-09-28.json) records post-check
hashes, not a before/after runtime source pin.
