# Sequencer interruption during unlock

Checked on 2026-09-28 against protocol v6. These focused live protocol traces cover the three unlock boundaries in the [bounded acceptance policy](../p2p-acceptance-policy.md).

`packages/protocol/src/deck-replica.test.ts` adds `restores the elected sequencer during unlock (%s)` with three independent cases:

| Boundary                          | Fault and observation                                                                                                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before-persist`                  | Hold the elected proposer's real signed unlock before its durable insertion. Crash it, abort the insertion, restore retained storage and retry the same frozen draw. No contribution or next-height vote is emitted before the crash.                                |
| `persisted-before-send`           | Persist the exact signed unlock, hold the storage return before transport emission, then crash. Restore and retransmit the same operation without replacing the stored contribution.                                                                                 |
| `peer-accepted-before-local-deal` | Hold the elected proposer's local deal transaction. The other peer genuinely accepts and durably commits its proposal, whose evidence contains that exact signed unlock. Crash before the local transaction commits. Restore and retransmit the same certified deal. |

Each case starts from genuine verified deck setup and legal base-engine play through a development-card purchase. The target is selected from the actual live controller round and certified draw parent. No parent, certificate or checkpoint is synthesized. The retained journal is byte-for-byte unchanged by the interrupted transaction; all existing outbox records survive unchanged, and closing the sender prevents later output.

After recovery, both peers have identical certified histories with exactly one deal and matching independent public replay. The deck advances once. Restoring owned private drivers yields exactly one decoded card slot for its owner and no foreign private state.

## Results and provenance

- Final handle `36248`: **3/3 passed**, 25.723 s test time, 26.77 s runner time. Individual cases: 12.073 / 6.493 / 7.155 s. The existing 120 s per-case bound was retained.
- Shared test typecheck `13665`, scoped type-aware lint and formatting: **passed**.
- Frozen test SHA-256: `e0beaa556d67343566a393f78f1d16b5efb812ab1a7d9809919335edcc6a5622`.
- A final typing-only assertion change decodes the durable store load already checked equal to the captured unlock bytes; runtime behavior is unchanged.

An initial fixture run was interrupted when a lagging peer was incorrectly used to select the target. An intermediate accepted-deal case incorrectly required another unlock transmission after restoration had already completed its saved certificate; the final assertion requires the same certified deal instead. Neither was a production failure.

These are two-human headless boundary traces, not a full-game audit or browser interruption check. Generic consensus tests separately retain persist-before-vote, failed-save and exact-signature restore coverage. Periodic four-human restart, every-sequence private equality, native storage abort and the mixed-browser matrix remain separate requirements.
