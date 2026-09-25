# Stage 06 implementation security review

Review the current strict-agreement implementation for concrete safety, liveness,
crash-recovery and privacy bugs. This is a read-only review. Do not modify files,
run commands, inspect credentials, or read files outside the list below. Reply
with ranked findings, exact file and line references, and a reproducible trace.
If there are no findings in a category, say so. Do not describe missing Stage 07
cryptography or Stage 10 membership as implemented: those stages remain pending.

Read these files:

- docs/verification/stage06/strict-agreement-design.md
- docs/06-protocol-event-log.md
- packages/crypto/src/identity.ts
- packages/protocol/src/types.ts
- packages/protocol/src/schemas.ts
- packages/protocol/src/genesis.ts
- packages/protocol/src/log.ts
- packages/protocol/src/votes.ts
- packages/protocol/src/proposal.ts
- packages/protocol/src/control.ts
- packages/protocol/src/consensus.ts
- packages/protocol/src/consensus-controller.ts
- packages/protocol/src/safety-store.ts
- packages/protocol/src/journal.ts
- packages/protocol/src/replay.ts
- packages/protocol/src/messages.ts
- packages/protocol/src/replicated-log.ts
- packages/protocol/src/p2p-session.ts
- packages/protocol/src/consensus-adversarial.test.ts
- packages/protocol/src/consensus-review.test.ts
- packages/protocol/src/consensus-controller.test.ts
- packages/protocol/src/replicated-log.test.ts
- packages/protocol/src/testing/simulation-driver.ts
- tools/sim/src/net.ts
- tools/sim/src/net-adversary.ts

The user chose strict agreement. For one through six human voters quorum is
1,2,3,3,4,4. At most one human is Byzantine except the sole-human mode, which has
one authority. Bots never vote. Commands bind the exact committed parent. Each
height has proposal, prevote and precommit rounds with persisted locks. A value
hash excludes its proposer, round and outer signature. Genesis normalizes consent
signatures out of its anchor hash. Voting records must persist before emission;
the journal commits the certified entry and the next-height safety record in one
CAS transaction. No lost-store reinitialization is authorized.

Check especially:

1. Conflicting certificates, hidden certificates, higher-round catch-up, nil
   votes, late proposals, lock monotonicity and valid-round justification.
2. Crashes around every write and effect, restore, stale storage writers,
   unknown signatures made by the local key, and committed-prefix preservation.
3. Whether certificate validation failures really stop voting and can only be
   repaired by replay with prior votes retained. Network snapshots must match
   replay-derived nonces, voters and exclusions, not just the engine state hash.
4. Authenticated accusations and certified proposer exclusion. Exclusion must
   leave voting weight and quorum unchanged. Local corruption, stale commands
   and missing ancestors must not incriminate an honest peer. Detecting a second
   distinct proven offender must fail closed.
5. Queued wire input bounds, replay/duplicate handling, flooding, sync, heartbeat
   claims, timeout progress and censorship. Duplicate known commits may be ignored
   without granting the incoming message any authority.
6. Public/private effects and successful command submission must occur only after
   durable commitment. The simulation driver is explicitly omniscient and must
   never run for verified production games.

The full local check at commit 0dab4fb passed 477 tests. Subsequent focused checks
cover control entries, accusations and snapshot repair. Full-game smoke runs pass
clean networking, duplicates/delay, one-peer crash, 2|2 and 3|1 partitions, proposal
censorship, corrupted-cache snapshot repair and simultaneous restarts. The simulation driver now retains dealt development-card identities after play,
and its draw/play/draw replay regression passes.
The 1,000-seed-per-scenario acceptance runs have not yet passed. Please review the
code, not these test results, as the source of truth.
