# Four-human persistence acceptance

This profile implements the periodic-restart and everyone-left cases in the
[bounded acceptance policy](../p2p-acceptance-policy.md). A complete acceptance
result is still pending. The profile uses the normal ten-point victory target,
four human protocol participants and real cryptographic contributions.

Run one deterministic game after building the simulation:

```sh
pnpm exec tsc -b tools/sim
node tools/sim/dist/index.js net --security verified --scenario 1 \
  --lifecycle persistence --seeds 1 --seed 42 --start-index 0 \
  --parallel 1 --max-elapsed-ms 900000
```

The command rejects the persistence profile with stub cryptography or another
network scenario. The nine Stage 07 fault cases retain their existing behavior.

The result must record a rotating peer restart at each reached approximately
50-entry boundary, and one mid-game closure of all four sessions followed by
reopening in order 2, 0, 3, 1. For everyone-left, the virtual clock runs for two
seconds while every session is closed, then advances 250 ms and flushes between
reopenings. The result records the actual closed interval and reopen gaps.

Before a restored session votes, the journal wrapper checks the retained prefix
and safety bytes. It observes the controller's real `loadSafety` call and
requires the stored height, revision and bytes to match the retained record.
The first restored `saveSafety` or `commit` must use that record's revision as
its compare-and-swap base. After each restore, the peer must still have its exact
pre-crash certified head. A later certified command must match a non-nil
precommit emitted by a restored seat at the same sequence and entry hash. A
rotating restart requires that seat's precommit. Everyone-left requires three
distinct restored seats, even if the chosen certificate wrapper contains a
different valid vote subset.

This profile restarts peers only at a shared, quiescent head with no pending
submission. It does not interrupt an in-flight journal write or command. The
separate signing, persistence and fault fixtures remain responsible for those
interruption points. These session restarts retain in-memory stores; they
supplement the native browser storage and process-restart checks.

Each seat's driver records only its own private-state hash at genesis and every
certified sequence, including replay after restoration. At terminal audit,
`reconstructPrivateSeats` compares the reconstructed state directly with those
live hashes at every sequence. Separately, `auditCertifiedGame` checks its
deterministic per-sequence reconstruction against private states from the
omniscient engine replay. Passing requires both comparisons, exact replay
snapshot counts, all four complete successful audits, matching final histories
and no false misconduct findings. Before terminal disclosure, this profile
never reads another seat's private state or the fixture's master-secret
accessor.

Retain the JSON result and the source revision/fingerprint before claiming this
gate passed. A passing CLI or scheduling test does not establish full-game
acceptance. `faultInjected` remains false because this profile schedules no
adversarial fault; use `lifecycle.restarts` for its restart evidence. No full
persistence-profile game has passed yet. The [review disposition](persistence-lifecycle-review-disposition.md)
and [frozen source manifest](persistence-lifecycle-final-source-manifest.sha256)
record the current implementation and remaining limits.
