# Verified network game CPU profile (2026-09-27)

This is a bounded diagnostic, not a completed-game acceptance result. I built `@cp2p/sim` under Node 22 at source revision `2dbf8e0` (with the simulator's current uncommitted work), then ran one `runNetworkGame({ seed: 42, gameIndex: 0, scenario: 1, security: 'verified', maxElapsedMs: 55_000 })` with V8 `--cpu-prof`. The run reached certified revision 35 around 55 seconds and stopped at the explicit elapsed-time cap. No browser was used. The raw CPU profile and driver script are in `/private/tmp`; neither contains packet payload logging.

| Public progress      | Elapsed wall time |
| -------------------- | ----------------: |
| Revision 9, turn 0   |            22.1 s |
| Revision 19, turn 0  |            33.5 s |
| Revision 29, turn 2  |            46.4 s |
| Stopped, revision 35 |            55.1 s |

The V8 profile has 43,977 samples. Inclusive percentages overlap because callers include callees.

| Call path                                 | Inclusive CPU samples |
| ----------------------------------------- | --------------------: |
| `restoreConsensusState`                   |                 59.9% |
| Its caller `transition`                   |                 33.9% |
| Its caller `ConsensusController.snapshot` |                 25.8% |
| `validateProposal`                        |                 52.0% |
| `validateHandCommitments`                 |                 22.8% |
| `genesisDigest`                           |                 19.1% |
| `validateCertifiedEntry`                  |                 12.4% |
| `createVerifiedNetworkFixture`            |                 11.1% |
| `replayCertifiedPrefix`                   |                  1.1% |
| `requestSync`                             |                <0.01% |

`transition` calls `restoreConsensusState` for every in-memory consensus event. That function round-trips and schema-checks the safety state, then revalidates every retained proposal, vote, future-round hint, and lock. In this trace, 21,594 of 22,864 `validateProposal` samples came from this repeated restore. `ConsensusController.snapshot` runs the same full restore and accounts for another quarter of total CPU. The replica calls `snapshot` from input offering, proposing, pulses, and other routine paths. Revalidating a proposal also repeats genesis hashing, hand commitments, and deck/crypto checks. The source paths are `packages/protocol/src/consensus.ts` (`transition`, `restoreConsensusState`), `consensus-controller.ts` (`snapshot`), and `replicated-log.ts` (`offerAvailableInput`, `maybePropose`, `pulse`).

The reported `sync/fromSeq:1` is a last-operation status, not proof that peers remained at revision 0. `ReplicatedLog.restore` requests sequence 1 and `requestSync` sets that status. Certified commits clear the request dedupe record, but do not reset the displayed status. The profile puts full-prefix replay at 1.1% and `requestSync` below 0.01%; the advancing revisions confirm the peers are committing. Periodic sync traffic may still cost serialization, but it is not the leading bottleneck in this run.

The first production change to evaluate is separating **untrusted durable safety restoration** from **transitions and snapshots of the controller's already validated, privately owned in-memory state**. Keep full schema/signature/entry validation on create or restore, on every newly received proposal/certificate, and after any untrusted storage read. For subsequent internal state transitions, clone before mutation but avoid revalidating unchanged retained proposals. A snapshot can detach the private state without repeating the full verification if controller ownership and no mutable callback alias are established; `beforePersist` currently receives the internal previous state, so that alias needs examination. Do not simply remove `restoreConsensusState` from exported pure transition APIs, which may receive caller-supplied state. A narrower alternative is a cache keyed by the complete canonical signed proposal bytes and fixed certified parent, with a separate test proving modified signatures, proofs, and parent still fail closed. Its hashing cost must be measured.

After that, profile again before addressing `genesisDigest`. It recomputes a large genesis digest at many validation layers; a per-certified-context immutable cache may help, but a cache keyed only by a mutable genesis object would weaken tamper detection. A focused mid-game benchmark should include malicious safety-state mutation/restart cases and measure both CPU and progress per certified entry. Raising the 180-second fixture limit would conceal the measured repeated-work path.

## Controller-owned validation path

The implementation now fully validates a controller's safety record when it opens or restores, then keeps a private validated copy for that height. Incoming proposals, votes, and certificates still use their existing verification, and exported pure reducers still fully validate caller-supplied state. Snapshots and observer callbacks receive detached copies. A changed certified context stops voting; the controller checks again after an awaited durable write, before publishing any signed effects.

In one same-seed 55-second Node/V8 profile with those guards, the run reached revision 80, versus revision 35 at the same cap before the change. The result remained unfinished at the cap. Inclusive CPU samples moved from 59.9% to 0.8% for `restoreConsensusState`, 52.0% to 7.5% for `validateProposal`, and 1.1% to 1.3% for certified-prefix replay. Context stamping and private-state copying each accounted for about 7.5%. The final source adds one further detached controller mirror copy after persistence; that minor change was not included in this profile. These are one-run diagnostic measurements, not a completed-game runtime claim.

Raw profile: `/private/tmp/CPU.20260928.002102.34797.0.001.cpuprofile`. The earlier guarded version reached revision 95 in a separate 55-second run, before the final context-stamp hardening. The revision 80 result is the relevant conservative comparison; the prior revision 95 is not a final-source speed claim.
