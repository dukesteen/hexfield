# Stage 06 strict-agreement implementation review

This review covers only the code in the listed files. I ran nothing and changed no files. I did not treat test results as evidence. Stage 07 cryptography and Stage 10 membership are still pending, and nothing below assumes either one exists.

**Summary.** The core Tendermint-style rules are implemented correctly: locking, justifying a reproposal with a prior round's prevotes, and handling nil and late votes. I found no way for honest peers to commit two different values while at most one voter is Byzantine and every safety store stays intact. The serious problems are in the layers around that core:

- a lost store can be reinitialized and vote again;
- two of the fail-closed checks don't survive a restart;
- one Byzantine peer can exhaust memory, storage or CPU, or get honest peers disconnected;
- local corruption and failures while applying private state are harder to recover from than the design requires.

## High

### H1. A lost journal can be reinitialized, and the peer then votes again with the same key (safety)

- **Where:** `ReplicatedLog.create` at `replicated-log.ts:96-120` has one guard: `journal.initialize` refuses if a record already exists (`journal.ts:72-81`). `p2p-session.ts:101-106` and `replicated-log.ts:1007-1020` accept any secret key that matches the genesis seat key. `tools/sim/src/net.ts:329-348` passes the same device identity it used for genesis.
- **Trace:**
  1. A four-voter game is at height H. Seat 2 precommits value A in round 1, so it is locked on A.
  2. Seat 2's journal is lost.
  3. The app calls `P2PSession.create` with the same genesis and key. `initialize` succeeds on the empty journal, and a heartbeat triggers sync (`:867-868`).
  4. `persistCommit` replays heights 1 to H-1 and opens a fresh round-1 record at H with no lock (`:730`).
  5. Seat 2 can now prevote or precommit B in round 1. That is an equivocation.
  6. Add one real Byzantine voter and two conflicting quorums become possible.
- **Why it matters:** The design says the voting key is per-game and stored atomically with the safety records, so losing the store means the seat cannot vote. The code has no per-game key and no marker that "this key has already voted". An empty journal is simply treated as a new game.

### H2. Fail-closed decisions are lost on restart, and a second offender at a later height is never detected (safety, crash recovery)

- **Where:**
  - `replica-fault-limit` (`replicated-log.ts:634-642`) and `replica-conflict` (`:486-491`) only call `failClosed`, which disposes the instance (`:986-990`). Nothing is persisted.
  - The accusation is held only in memory and is cleared on every commit (`:751`).
  - Evidence is only valid against the current parent (`control.ts:57-63,111`).
  - The consensus `equivocations` list starts empty at each new height (`consensus.ts:588`).
- **Trace A:**
  1. A verified certificate for a past height conflicts with local history, and `replica-conflict` disposes the replica.
  2. The process restarts. `ReplicatedLog.restore` replays the local journal and resumes voting.
  3. The design says to halt permanently in this case.
- **Trace B:**
  1. At height 30, seat 1 sends two different prevotes. Seat 0 builds an accusation.
  2. Value X already has a prevote quorum from {0, 2, 3}, so X commits and the accusation is cleared.
  3. At height 31, seat 2 equivocates. `verified.excludedProposers` is empty and `this.accusation` is null, so seat 2 is accepted as a _first_ offender.
  4. Two distinct proven offenders exist, but the game never fails closed.

### H3. Normal backpressure permanently disconnects honest peers (liveness)

- **Where:**
  - A full queue strikes the sender (`replicated-log.ts:333-340`).
  - Strike counts never decay, and blocked peers are never unblocked (`:368-382`).
  - A queue slot is released only after the queued task finishes (`:344-348`).
- **Traces:**
  - **Pulse burst.** Every 2 seconds, `pulse` sends a heartbeat plus every local proposal and vote for the current height (`:829-852`, `consensus.ts:1083-1089`). Around round 6 that is about 14 messages in one burst. `replicated-log.test.ts:387-389` shows that 13 back-to-back valid PINGs are enough to disconnect a peer.
  - **Catch-up.**
    1. A lagging peer handles up to 200 commits inside one queued task (`:497-508`).
    2. Meanwhile, every heartbeat from a peer that is ahead triggers another broadcast `SYNC_REQ` (`:867-868`).
    3. The honest responders' `SYNC_RES`, heartbeats and votes go over the per-peer limit of 8.
    4. After five lifetime strikes, each responder is blocked.
  - **Shared cap.** When the 32-message total cap fills up, the strike lands on whichever peer's message happens to arrive next, even if it did nothing wrong.
- **Impact:** In two- or three-human games, blocking one peer stalls the game until the process restarts.

### H4. One Byzantine proposer can grow persisted state without limit (liveness, DoS)

- **Where:**
  - `recordProposal` stores every distinct valid proposal and records the equivocation only once (`consensus.ts:327-359`).
  - `receiveProposal` also accepts proposals for past rounds (`:929-934`).
  - Every transition re-runs `validateProposal` on every stored proposal, which applies each one through the engine (`:528`, `:620-623`).
  - The whole record is re-encoded and saved on every dispatch (`consensus-controller.ts:148`).
- **Trace:**
  1. At any height where seat B was proposer in some round up to the current one, B signs thousands of proposals.
  2. Each is its own valid command with a different nonce. That is allowed because the nonce only has to exceed the last one (`log.ts:68`).
  3. In stub mode, B can instead vary system inputs.
  4. Every honest voter persists all of them, and the cost of each later transition grows accordingly.
  5. Being tolerated as a single equivocator never bounds this.

## Medium

### M1. Local derived-state corruption becomes fatal instead of being repaired in place (crash recovery, liveness)

- **Where:** The same re-validation of stored proposals (`consensus.ts:620-623`) fails with `consensus-restore`. That stops voting and zeroes the key (`consensus-controller.ts:143-145`) and is treated as fatal (`replicated-log.ts:997-1005`). After that, `repair()` cannot run (`:303`, and `:182-183`).
- **Trace:**
  1. The peer has stored the proposal for height H.
  2. Its derived state becomes corrupted.
  3. The next event disposes the replica.
  4. Only a full process restart recovers it, not an in-place replay with the vote records kept.
- **Test gap:** The scenario-8 harness deliberately drops that height's PROPOSAL and VOTE messages so this path is never exercised (`net.ts:303-308`).
- **Related inconsistency:** A certificate assembled from votes that fails validation calls the terminal `halt` (`consensus.ts:462-466`). The `receiveCommit` path uses the repairable `haltForCertifiedValue` instead (`:998-1001`).

### M2. A value that passes public validation can permanently brick every peer when private state is applied (crash recovery)

- **Where:**
  - The journal commit happens first, then `onCommit` runs (`replicated-log.ts:739-765`). If `onCommit` throws, the instance is disposed.
  - `P2PSession.restore` replays the same entry and fails again every time (`p2p-session.ts:125-145`).
  - Proposal validation only checks public engine rules.
- **Trace (stub mode):**
  1. A Byzantine proposer proposes `REVEAL_COUNT` with a false count. Stub evidence can be recomputed by anyone (`log.ts:121-126`).
  2. The public engine accepts it, assuming the engine only checks the count against public bounds. I didn't read the engine to confirm this.
  3. The value is certified.
  4. On every peer, the driver's bounds check fails (`simulation-driver.ts:156-170`).
  5. Every peer halts and cannot be restored.
- **Scope:** The exploit only applies in stub mode, but committing first and having no way to recover from a failed private application is a general gap.

### M3. Expensive work runs before authentication, and sync can be driven by unauthenticated input (liveness, DoS)

- **Full replays from genesis:**
  - A conflicting past-height `COMMIT` triggers a full replay _before_ its signatures are checked (`replicated-log.ts:477-485`).
  - Every failed `PROPOSAL`, including honest proposals for stale heights, goes through `rememberAccusation`, which replays in full (`:399-423`, `:615-621`).
  - Every `SNAPSHOT_REQ` triggers a full replay (`:937-942`).
  - While the peer is halted, every `SNAPSHOT_RES` does too (`:448-456`, `:194-200`).
- **Unauthenticated sync:**
  - A `COMMIT` claiming a future height starts a sync broadcast without any authentication (`:493`).
  - A `SYNC_RES` with `more:true` whose entries are all already known passes the non-empty check (`:440-445`). It then triggers another broadcast (`:507`), so one Byzantine responder can keep every honest peer resending batches of up to 200 entries indefinitely.

### M4. Signatures from the local key inside larger objects are not checked (crash recovery, safety detection)

- **Where:** Only direct VOTE and PROPOSAL messages are compared against local records (`consensus.ts:907-926`, `:955-971`). Several paths accept signatures by the local key without that check:
  - commit certificates (`:985-1015`);
  - proposal justification prevotes (`proposal.ts:155-168`);
  - proposals returned for `PROPOSAL_REQ`;
  - `ACCUSE` evidence (`control.ts:102-117`).
- **Why it matters:** Peers only broadcast their own votes. The embedded paths are therefore how a stale writer or a cloned key would actually show up, and those are the paths that go unchecked.

## Low

- **L1. System inputs, including TIMEOUT, are chosen by the proposer (stub only).**
  - Stub evidence binds only the game, the parent and the input. Validators never compare it with their own driver's answer (`log.ts:121-126`).
  - Nothing checks a local deadline (`simulation-driver.ts:81-90`), so a proposer can force a TIMEOUT on any human.
  - The design's "a local deadline can cause a nil prevote" is not implemented.
- **L2. Nonces come from the last committed value, not a persisted counter.**
  - The nonce is the last committed nonce plus 1 (`p2p-session.ts:259`).
  - After a restart, the same nonce is signed again at the same parent, so an abandoned command held in other peers' buffers can still commit.
  - `submit` can report a failure such as `replica-transport` after it has already stored the command for proposing (`replicated-log.ts:242-249`).
- **L3. The prevote timer is armed during the propose step.**
  - The timer is armed at `consensus.ts:511-514`. When it fires, it signs nil for both prevote and precommit (`:1055-1062`).
  - Its 750 ms base is shorter than the 1000 ms propose timeout (`replicated-log.ts:803`).
  - This affects liveness only.
- **L4. Accusations are lost or never acted on.**
  - Stored equivocations are never re-emitted by `recoverConsensusEffects` (`consensus.ts:1074-1116`).
  - Valid evidence doesn't make honest voters vote nil.
  - I could not find the code path that `replicated-log.test.ts:196-245` relies on to re-send ACCUSE after a restart. Please re-run that test.
- **L5. The command buffer is easy to crowd out.**
  - It is a shared FIFO of 32 that a single sender can fill with its own valid commands (`replicated-log.ts:605-610`).
  - `candidate()` only tries `commands[0]` (`:563-577`).

## Categories with no findings

- **Privacy:** No concrete leak outside stub mode.
  - `CARD_DEALT.card` is rejected (`log.ts:117`), and `getPrivate` only returns seats this peer controls.
  - The simulation driver refuses non-stub genesis (`simulation-driver.ts:53`, `genesis.ts:106-108`).
  - Keeping it out of verified games still depends on the caller's `allowStub` policy. I did not review the app wiring that sets it.
- **Protocol safety:** No violation found in the core rules. These hold:
  - quorum sizes 1, 2, 3, 3, 4, 4;
  - lock and valid-round monotonicity and the reproposal justification check;
  - value hashes exclude proposer, round and outer signature;
  - genesis normalization;
  - persisting before any effect is emitted;
  - an atomic compare-and-swap journal commit together with the next height's safety record;
  - snapshot checks against replay-derived nonces, voters and exclusions (`replay.ts:72-94`);
  - duplicate known commits are ignored without granting any authority (`replicated-log.ts:476`);
  - exclusion leaves voting weight and quorum unchanged (`proposal.ts:106-135`).
