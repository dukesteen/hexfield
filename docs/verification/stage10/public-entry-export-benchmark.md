# Detached public entry export benchmark

Measured 2026-09-28. `ReplicatedLog.getEntries()` now deep-clones its owned,
validated canonical wire entries with `structuredClone`, instead of canonical
encoding and decoding the entire prefix. Restore still validates the certified
history; commit still validates and durably stores each entry before appending
its checked wire entry and certificate. Public exports remain detached.

The existing signed persist/restore regression compares exported canonical bytes
with the durable journal and canonical round-trip output. Mutating an exported
entry, nested command, certificate signature and vote body leaves the internal
prefix unchanged. The normal focused test passed in 338 ms. The opt-in benchmark
and the same regression passed in 549 ms (1.75 seconds for the runner).

Five alternating batches of 1,000 exports use the same genuinely committed
two-entry signed fixture, 2,518 canonical bytes. Median old cloning time is
69.16 ms per batch; median new cloning time is 10.17 ms, about 6.80 times faster.
The [raw log](public-entry-export-benchmark.log) and
[measurements and exact source hashes](public-entry-export-benchmark.json)
preserve this run. Shared test TypeScript checking, scoped type-aware lint and
formatting pass.

This is a small-fixture cloning measurement, not a full-game runtime gate or an
estimate of savings for long histories. CI run 36402607911 measured 65.15 seconds
in 1,044 full-prefix actor exports before this change. Actor prefix hashing,
first-terminal master-reveal replay and persistence restore costs remain separate
work. Independent final audits and private-state comparisons are unchanged.

Reproduce the bounded benchmark with `CP2P_ENTRY_EXPORT_BENCH=1 pnpm exec vitest
run packages/protocol/src/replicated-log.test.ts -t 'persists genesis, certified
entries and next-height safety before notifying'`. Normal test runs omit the
timing loop; it has no timing assertion.
