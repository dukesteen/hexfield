# Verified CI follow-up, 2026-09-28

[CI run 36416940673](https://github.com/dukesteen/hexfield/actions/runs/36416940673)
tested protocol v6 at commit `80133af2acd4172b11b9842286d27ce5e8657237`,
with seed 42, game index 0, one worker and the unchanged 900,000 ms network
limit. Scenario artifacts report source fingerprint
`cf48a67bb4e255086cb90d8cb58ce2715007e8dab4bf155d161025f92c208387` and
`sourceUnchanged: true`. The [compressed public run data](verified-ci-36416940673-artifacts.tar.gz)
contains the run metadata, scenario 2/5/6 JSON and revision files, the two
failed-job logs and the shard 3 log. SHA-256:
`194a982e11248b29c71acd7d576f88632f846328eeaa6d27e9f43584e30aeb40`.

## Real-crypto scenario outcomes

| Scenario                       | Artifact result                                                                                                                                                                                                                                                                                       | Disposition                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2, latency and duplicates      | At 900.10 s, all four peers agreed at seq 494, turn 79, with no terminal result. Each had pending `STEAL_RESULT` for thief 3/victim 2 and a player `CLAIM_VICTORY` input for seat 3. Last progress was 899.10 s; virtual time was 458.48 s.                                                           | Timed out while nonterminal. The game had progressed almost to the deadline, so this run does not establish a deadlock. Cumulative session flush time was 867.19 s across 37,052 calls; network delivery accounted for 3.16 s across 36,679 calls. The artifact does not identify why the pending steal result was not committed before cutoff. |
| 5, three-against-one partition | Completed in 798.29 s at seq 869, turn 152. All four audits completed cleanly at the same final head `71a122805db3766f9257b71d8267201af4ff11606e5dfeed3aed99a80aa5cb0b`. The fault was injected and recovered.                                                                                        | Passes this seed and scenario on this source fingerprint. The earlier timeout in run 36411956997 remains historical and is superseded for current scenario status by this completed trace.                                                                                                                                                      |
| 6, invalid proposer            | Reached public-victory result for winner 2 at turn 182, seq 1064. All four peers agreed at head `9019b0eaa04069d9e5aca9611da05abd0fd876c7b414a5b11a7ecdbcb4e6d0fd`; no gameplay input was pending. Three independent audits had started but were still pending 24.1 to 25.6 s at the 900.01 s cutoff. | Timed out during terminal audits. All reported master-reveal packet types had arrived at each auditing peer. This artifact does not establish a missing reveal or audit failure; it records no completed audit result.                                                                                                                          |

The run also passed the build/check job, simulation, all nine stub network
scenarios and unit shards 1, 2 and 4. The persistence lifecycle job was skipped.
Real-crypto scenarios 2 and 6 remain open under their unchanged bound; scenario
5 now has a passing trace at this commit. Earlier failures remain in the linked
[prior CI checkpoint](verified-ci-checkpoint-2026-09-28.md).

## Unit shard 3

Shard 3 completed 80 test files and 462 tests with no reported assertion
failure, then exited with one unhandled Vitest worker error:
`Timeout calling "onTaskUpdate"`. The shard ran for 1,078.36 s, including
1,023.02 s of test time. The repository config sets `maxWorkers` to one in CI.
The slowest file was `packages/protocol/src/online-ceremony.test.ts` at
328.27 s for 35 tests. Other long files were `steal-replica.test.ts` at
79.91 s, `online-transfer-destination.test.ts` at 74.02 s, and
`audit.test.ts` at 64.87 s. Those are file totals. Only one individual test
exceeded 60 s: the owner-private discard timer test at 64.495 s. At the tested
commit, its drain loop awaited session flushes but did not yield a macrotask.
The log records the RPC error at 11:58:01Z, 3 min 38 s after that test's
11:54:23Z completion. That makes runner responsiveness worth checking, but the
log does not establish causality. The recorded failure is a worker-to-runner
RPC timeout, not a test assertion, and does not justify changing a runner
timeout or worker schedule by itself.

## Focused drain-yield follow-up

After this run, the owner-private discard test's drain loop added one
`setImmediate` yield after each session flush. The yield lets the Node event
loop process test-runner RPCs without advancing the fake network clock. The
focused test passed in 28.218 s (29.19 s runner duration). The raw output is
retained at `/private/tmp/hexfield-private-discard-yield-2026-09-28.log`,
SHA-256 `e3a51b4b0a1b4466e5c955052d753bfb79da78d1290b800b502940585b883250`.
This checks the modified drain loop only. It does not establish that the yield
caused the earlier `onTaskUpdate` timeout or that it prevents one in the full
shard.
