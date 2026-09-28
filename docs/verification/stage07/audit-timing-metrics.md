# Audit dispatch timing

Checked on 2026-09-28. Scenario 5's failed current-v6 run at `0c56aa1` reached terminal head 869 at 714.1 s and timed out at 900.1 s with all four peers verifying. Its four `invocations: 0` records counted only settled jobs, so they did not mean no audit had started.

The simulator fixture now counts `invocations` on dispatch and reports `completedInvocations`, `pendingInvocations`, fixture-relative `lastStartedMilliseconds`, total pending `runningMilliseconds` and `oldestPendingMilliseconds`. Running durations measure wall time, not worker CPU time. Existing `totalMilliseconds` and `lastMilliseconds` still describe settled jobs, including rejection or cancellation.

The deferred-executor fixture test, handle `9390`, passed in 6.805 s (8.20 s runner). A controlled monotonic clock checks two pending jobs at 100/80 ms, zero completed durations before settlement, then completed counts and exact durations after rejection. It retains the private-comparison reservation and failure-propagation assertions. Shared test typecheck `90583`, scoped type-aware lint and formatting passed. No full game or audit algorithm was run for this change.

Source SHA-256 at this checkpoint:

| File                                                             | SHA-256                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/protocol/src/testing/verified-network-fixture.ts`      | `8acb19a99724fcfccde9c6eb83500a258ba39bae66ff95ded60188ca61dade52` |
| `packages/protocol/src/testing/verified-network-fixture.test.ts` | `067bb6be22e9c0e3271a26727f8b9aa1e214135e880bfb19afce42ebb3df2375` |
| `tools/sim/src/net.ts`                                           | `1951a8e6595159a2ac42bd5a72982f8cab37d12457348cf69595084f1153eff0` |

The runner change only aliases the report's timing type to the exported fixture type. Audits remain independent per peer, with unchanged validation and wall deadlines. Worker CPU profiling is needed to apportion the long pending tail; these counters do not identify its algorithmic stage.
