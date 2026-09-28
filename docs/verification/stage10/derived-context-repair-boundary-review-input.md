# Repair queue-boundary correction review

Read-only focused final review. No tools. Assess concrete remaining safety/liveness defects in these corrections to your follow-up M-A/L-B/L-C findings. Return APPROVE or REQUEST_CHANGES, distinguish blockers from hypotheticals and missing full-game acceptance. Do not expand unrelated scope.

M-A reproduced before correction in commit-strike regression: pause journal.loadSafety inside persistCommit, corrupt bank, inject oversized packet, release read. The old code entered derivedRepair synchronously, set controller=null, then disposed on consensus-effects. Original pending-save oversized case passed and is retained separately; do not claim it reproduced the defect. New code detects fault synchronously but defers hold entry to the serialized enqueue boundary. One bounded queued no-op ensures a direct ingress/trade call schedules that boundary. Precheck stops queued work after a known fault, postcheck and exception path prioritize newly entered repair/context fault over consequential errors. Existing terminal safety errors still dispose. Cached proposal returns now check controller snapshot. persistCommit checks snapshot before replay.

L-A disproved: verifyReplaySnapshot is EXACT canonical hash equality to snapshotFromContext; code included. L-D certificate looseness disproved: authenticateCertifiedEntry and held commit both call same verifyCertificate with same expected fields; full strict certificate parser included. Signature/proposer and full entry validation still run after restoration.

L-B corrected: verified preexisting strikes/blocked peers persist; fault-time strikes are prevented by snapshot check. L-C corrected: direct trade request checks snapshot before proof validation/mutation/send and schedules repair boundary on context fault.

Original scenario8 review mistakenly described outgoing precommit injection. Actual trigger is INCOMING non-null precommit, at next height after seq20 on a non-proposer rotation. It no longer drops proposal/votes. It requires exact consensus-context diagnostic, matching snapshot parent/hash, running advance, then later certified command. Full scenario8 game remains pending.

Focused current 62 tests in controller+replica passed, including verified genesis and two deck-pass opening comparisons, genuine lock/safety CAS tests, pending-write and mid-commit strikes, cache context guards, direct unobserved trade fault, legitimate blocked-peer preservation. No full game claimed.

## Previous follow-up review

# Derived-context repair: follow-up review

The fixes close H1, the direct M1 path, M3's replay amplification and L1's overwrite. I found one medium defect that remains, plus four low items and one open scenario-8 risk. I found no new safety issue: every remaining defect ends in a fail-closed dispose, a lost opportunity to act, or a Byzantine peer being let back in. None leads to an unsafe vote or a reset.

I had no file-access tools this session, so this is based only on the source you pasted. Where a finding depends on code I couldn't see, I say so.

## M-A: Medium (liveness). Repair can start in the middle of an operation, and the rest of that operation then disposes the replica

**Where:** `strikePeer`, `captureRejectedProofs`, `ReplicatedLog.enqueue`, the synchronous strike in `attachTransport.onMessage`, and `ConsensusController.dispatch` (the cached-rejection path).

**Mechanism:**
- **Repair starts too early.** `strikePeer` and `captureRejectedProofs` now call `enterDerivedRepair()` themselves. That call sets `this.controller = null` immediately. The operation that called them keeps running afterwards, so any later `activeController()` call throws. `enqueue`'s `catch` then reports `replica-transition` and calls `dispose()`, which is terminal.
- **Paths that reach this:**
  - **Oversized or non-`Uint8Array` messages.** `onMessage` calls `strikePeer` synchronously, outside the queue. It can land while an operation is waiting on `saveSafety`, which is exactly the "pending" window. Any peer can trigger this whenever a fault exists that hasn't been detected yet.
  - **Strikes inside `receive` branches** (`DECK_CONTRIB`, `COUNT_CONTRIB`, `STEAL_*`, `TRADE_PROOF_REQUEST`, `SUBMIT`) whose code keeps going after the strike. I couldn't see these branch bodies, so check each one.
  - **The `PROPOSAL` branch's own capture call.** `ConsensusController.dispatch` returns a cached `rejectedProposals` entry before `reduce`, so the context check never runs. The branch's inline `captureRejectedProofs` (not the post-receive one in `attachTransport`) then enters repair. The branch continues to `proposerFor(this.context…)` and `rememberAccusation`. Whether that throws depends on whether `admitExpensiveRequest` deduplicates, which I couldn't see.
- **Wrong post-check in `enqueue`.** Once repair has started mid-operation, `this.controller` is null. `this.controller?.hasContextFault()` is then `undefined`. An outcome such as `consensus-stopped` from the disposed controller then matches `FATAL_CONTROLLER_ERRORS` and the replica disposes.
- **Operations run on a context already known to be bad.** `enqueue` only checks the fault flag after the operation. Any operation queued after the flag is set still runs against the corrupted context first.

**Smallest fix:**
1. In `strikePeer` and `captureRejectedProofs`, return as soon as `snapshot()` fails. `stopVoting('consensus-context')` has already set `contextFault`. Don't call `enterDerivedRepair`/`failClosed` there.
2. In `enqueue`:
   - Before the operation: if `this.controller?.hasContextFault()` is set, enter repair and return `consensus-context`.
   - After the operation, and in `catch`: if `this.derivedRepair` became set during the operation, or the fault flag is set, return `consensus-context` before the fatal-code check.
3. For the synchronous strike in `onMessage`, enqueue a no-op with `duringRepair = true` after it. That makes the boundary check run.
4. In `ConsensusController.dispatch`, run `this.owned.snapshot()` before returning a cached rejection.

**Test:** pause `saveSafety` during a `PROPOSAL`, corrupt the bank, send an oversized message, release the write, then send a `DECK_CONTRIB`. Assert that the replica is held and not disposed.

## L-A: Low (liveness, depends on L2). The M3 hash gate may be stricter than `verifyReplaySnapshot`

**Where:** `repairNow`, the `hold.replayed` gate.

**Mechanism:**
- On the first pass, a snapshot is accepted if `verifyReplaySnapshot(snapshot, fresh)` passes.
- On later passes, acceptance requires `hashValue(snapshot) === hashValue(snapshotFromContext(fresh))`.
- If `verifyReplaySnapshot` compares by meaning rather than by exact bytes, an honest peer's snapshot can pass the first check and fail the second. Examples: nonce order (L2 covers only early epochs), optional keys that are either absent or `undefined`.
- In that case the honest peer's snapshot is rejected on every retry, and the hold never ends.

**Fix:** when the hash doesn't match, run `verifyReplaySnapshot(snapshot, hold.replayed.context)` instead of rejecting. That check is cheap and still skips the journal load and replay. Alternatively, confirm that `verifyReplaySnapshot` is exactly hash equality and note that in the code.

## L-B: Low (Byzantine isolation). Every repair now unblocks all peers

**Where:** the shared reset in `repairNow`, which also runs on the non-hold `certified-validation` path.

**Mechanism:**
- `invalidByPeer.clear()` and `blockedPeers.clear()` bring back peers that were disconnected for real misconduct, such as bad envelopes or bad signatures.
- These clears are no longer needed. `strikePeer` now refuses to record a strike while the context is faulty, so no strike can come from the corrupted context.

**Fix:** remove those two clears. Keep clearing the rejection caches.

## L-C: Low. `requestTradeProof` only checks the fault flag

**Mechanism:** if the corruption hasn't been detected yet, the call still validates against the corrupted log. It can then send a `TRADE_PROOF_REQUEST` that the counterparty rejects and counts as a strike against us.

**Fix:** call `this.controller?.snapshot()` first and return `replica-repairing` if it fails. The fault flag gets set, and the next `enqueue` starts repair (with M-A's pre-check).

## L-D: Low (residual from L1). The first certificate that passes verification is kept

**Mechanism:**
- `retainHeldCommit` keeps whichever copy of a certificate passes `verifyCertificate` first.
- If `validateCertifiedEntry` checks certificates more strictly (exact quorum size, duplicate votes, ordering, size limit), a Byzantine voter can get a looser copy stored first.
- That copy then fails in `acceptCertified`, and repair falls back to `requestSync`.
- This only costs liveness, and sync still recovers. I couldn't see how strict either function is.

**Fix:** run the same certificate check `acceptCertified` uses, or replace a stored copy that later fails with the next valid one.

## Scenario 8: open risk (unverified)

The new trigger in `net.ts` corrupts the bank from inside seat 0's outgoing non-nil precommit send. The lock and precommit are already durable by then, which is the right setup for H1. One ordering is not covered by any test:

- If that local precommit completes the precommit quorum, the same `handleEffects` batch goes on to the `commit` effect.
- `persistCommit` then runs against the corrupted context without first going through the controller guard.
- If it validates the new state against `this.context`, the failure code is probably not `consensus-context`. The result would then be fatal or a `certified-validation` halt, not the hold.

**Fix:** start `persistCommit` with `this.activeController().snapshot()` and return on failure. Alternatively, confirm the existing path already returns `consensus-context`.

Other open items for scenario 8:
- Confirm that the old proposal/vote drop filter (originally `net.ts:455-460`) is gone.
- `desyncObserved` still accepts any error status. Require `consensus-context`, and assert that the repair actually used the recorded `repairSnapshotHash`.
- No scenario-8 game has been run, so scenario 8 can't be counted as accepted on this evidence.

## Confirmed fixed (from the diff, nothing was run)

- **H1:** `checkContext` no longer restores against the untrusted context. Terminal evidence still fails closed through `requireExactRestore` against the fresh replay. The `locked` test repairs a real lock and keeps the safety record's bytes and revision unchanged.
- **M1:** fatal `PROPOSAL` dispatch errors now return before any capture. Cheat candidates are rechecked against the fresh context. Durable store entries still depend on the recheck in `recoverCheatCandidates` when the replica restarts.
- **M3:** a distinct forged snapshot now exits before `journal.load`, and the test checks this. A matching snapshot still rereads the journal, checks the prefix hash and rechecks the safety record.
- **L1:** a stored held commit can't be overwritten. Certificates are verified against a frozen copy of the voter membership, so a Byzantine voter can't fill the slots with distinct valid-looking commits.
- **L3:** the fault flag survives a swallowed `snapshot()` failure. The `swallowed` test covers this.
- **Controller persistence:** `persistedBytes` is now copied from exactly the bytes handed to storage, so it matches the durable record even when `commit()` fails.

The Atlassian and Google Drive connectors are unavailable until they're authorized in your claude.ai connector settings.

## packages/protocol/src/replicated-log.ts

```typescript
  private controllerAnchor: {
    seq: number;
    hash: string;
    genesisDigest: string;
    voters: readonly string[];
    membership: VoteContext;
  } | null = null;
  private derivedRepair: {
    stopped: ConsensusController;
    anchor: NonNullable<ReplicatedLog['controllerAnchor']>;
    heldCommits: Map<string, CertifiedEntry>;
    lastRequestAt: number;
    replayed?: {
      context: ProposalContext;
      entries: CertifiedEntry[];
      snapshotHash: string;
      prefixHash: string;
    };
  } | null = null;


```

```typescript
  /** Replays the certified parent before retrying a retained, authenticated certificate. */
  repair(snapshot?: unknown): Promise<Result<void>> {
    return this.enqueue(() => this.repairNow(snapshot), true);
  }

  private async repairNow(snapshot?: unknown): Promise<Result<void>> {
    const hold = this.derivedRepair;
    if (hold) await hold.stopped.settled();
    else {
      const state = this.activeController().snapshot();
      if (!state.ok) return state;
      if (state.value.haltKind !== 'certified-validation')
        return failure('replica-repair', 'Only a certified validation halt can be repaired');
    }
    if (
      hold?.replayed &&
      snapshot !== undefined &&
      // verifyReplaySnapshot uses this same canonical hash equality.
      toHex(hashValue(snapshot)) !== hold.replayed.snapshotHash
    )
      return failure('snapshot-mismatch', 'Snapshot differs from the certified replay');
    let record: Awaited<ReturnType<ProtocolJournal['load']>>;
    try {
      record = await this.options.journal.load();
    } catch {
      return failure('replica-storage', 'Could not read the certified journal for repair');
    }
    if (!record)
      return this.failClosed('replica-journal', 'Certified journal is missing during repair');
    if (
      !sameBytes(canonicalEncode(record.genesis), canonicalEncode(this.genesisEntry)) ||
      !sameBytes(canonicalEncode(record.genesis), canonicalEncode(this.options.genesisEntry))
    )
      return this.failClosed('replica-genesis', 'Repair journal differs from the original genesis');
    const prefixHash = toHex(hashValue({ genesis: record.genesis, entries: record.entries }));
    if (hold?.replayed && prefixHash !== hold.replayed.prefixHash)
      return this.failClosed('replica-journal', 'Certified journal changed during repair');
    const replayed = hold?.replayed
      ? success(hold.replayed)
      : replayCertifiedPrefix(
          record.genesis,
          record.entries,
          this.options.engine,
          this.options.policy,
        );
    if (!replayed.ok)
      return hold ? this.failClosed(replayed.error.code, replayed.error.message) : replayed;
    const fresh = replayed.value.context;
    if (
      record.height !== fresh.log.head.seq + 1 ||
      fresh.log.head.seq !== (hold?.anchor.seq ?? this.context.log.head.seq) ||
      entryHash(fresh.log.head) !== (hold?.anchor.hash ?? entryHash(this.context.log.head))
    )
      return this.failClosed('replica-journal', 'Certified parent changed during repair');
    if (hold && !hold.stopped.opensOn(fresh))
      return this.failClosed(
        'replica-authority',
        'Durable replay differs from the controller opening context',
      );
    if (hold && !hold.replayed)
      hold.replayed = {
        context: fresh,
        entries: replayed.value.entries,
        snapshotHash: toHex(hashValue(snapshotFromContext(fresh))),
        prefixHash,
      };
    if (hold && snapshot === undefined)
      return failure('replica-repairing', 'Derived repair requires a replay-verified snapshot');
    if (snapshot !== undefined) {
      const checked = verifyReplaySnapshot(snapshot, fresh);
      if (!checked.ok) return checked;
    }
    let restored: ConsensusController | null = null;
    if (hold) {
      const safety = record.safety;
      if (!hold.stopped.matchesPersistedRecord(safety))
        return this.failClosed(
          'consensus-write-conflict',
          'Durable vote or lock record changed during repair',
        );
      const local = checkLocalKey(this.options, fresh);
      if (!local.ok) return this.failClosed(local.error.code, local.error.message);
      for (const key of local.value.keys.values()) key.fill(0);
      const opened = await this.restoreController(fresh, true);
      if (!opened.ok) return this.failClosed(opened.error.code, opened.error.message);
      restored = opened.value;
      let stillStored: Awaited<ReturnType<ProtocolJournal['loadSafety']>>;
      try {
        stillStored = await this.options.journal.loadSafety(record.height);
      } catch {
        restored.dispose();
        return failure('replica-storage', 'Could not recheck durable safety during repair');
      }
      if (!stillStored || !hold.stopped.matchesPersistedRecord(stillStored)) {
        restored.dispose();
        return this.failClosed(
          'consensus-write-conflict',
          'Durable safety changed while restoring repair',
        );
      }
    }
    if (!hold) this.activeController().dispose();
    this.controller = null;
    this.context = fresh;
    this.timerObserver.advance(fresh.log.timers ?? []);
    this.clearTimedVoteRetry();
    this.clearRecoveryCandidate();
    this.rejectedCommands.clear();
    this.rejectedProposals.clear();
    this.rejectedDeckContributions.clear();
    this.rejectedCountContributions.clear();
    this.rejectedStealMessages.clear();
    this.rejectedMasterReveals.clear();
    this.preparedDeckPrefix = null;
    this.sentDeckPrefix = null;
    this.entries = replayed.value.entries;
    this.refreshHistoricalHumanPeers();
    for (const [id, claim] of this.cheatCandidates)
      if (!this.verifiedCheatClaim(claim).ok) this.cheatCandidates.delete(id);
    if (!restored) {
      const opened = await this.openController();
      if (!opened.ok) return this.failClosed(opened.error.code, opened.error.message);
      return this.activeController().dispatch({ kind: 'resume-after-replay' });
    }
    this.installController(restored, fresh);
    this.derivedRepair = null;
    const resumed = await restored.resume();
    if (!resumed.ok) return resumed;
    for (const certified of hold?.heldCommits.values() ?? []) {
      // oxlint-disable-next-line no-await-in-loop -- Retained untrusted hints are fully validated on the freshly restored parent.
      const accepted = await this.acceptCertified(certified);
      if (!accepted.ok && FATAL_CONTROLLER_ERRORS.has(accepted.error.code)) return accepted;
    }
    this.schedulePulse();
    return this.requestSync(this.context.log.head.seq + 1);
  }


```

```typescript
  /** Send one authorized trade-proof request directly to its counterparty host. */
  requestTradeProof(value: SignedTradeProofRequest): Result<void> {
    if (this.disposed) return failure('replica-disposed', 'Replica has been disposed');
    if (this.derivedRepair || this.controller?.hasContextFault())
      return failure('replica-repairing', 'Awaiting certified derived-state repair');
    const context = this.controller?.snapshot();
    if (context && !context.ok) {
      if (context.error.code !== 'consensus-context')
        return this.failClosed(context.error.code, context.error.message);
      this.queueContextCheck();
      return failure('replica-repairing', 'Awaiting certified derived-state repair');
    }
    const checked = verifyTradeProofRequest(value, this.context.log);
    if (!checked.ok) return checked;
    const request = checked.value;
    const finalizerHost = tradeProofHost(
      this.context.log.genesis,
      request.body.seat,
      this.context.log.authority,
    );
    const ownerHost = tradeProofHost(
      this.context.log.genesis,
      request.body.command.withSeat,
      this.context.log.authority,
    );
    if (
      !this.deckKeys.has(request.body.seat) ||
      finalizerHost !== this.self ||
      !ownerHost ||
      ownerHost === this.self
    )
      return failure('trade-proof-route', 'Request is not for a remotely hosted trade owner');
    const requestId = tradeProofRequestId(request.body);
    const existing = this.pendingTradeProofs.get(requestId);
    if (existing && !sameBytes(canonicalEncode(existing.request), canonicalEncode(request)))
      return failure('trade-proof-request-id', 'Request identifier is already reserved');
    if (!existing && this.pendingTradeProofs.size >= MAX_TRADE_PROOF_CACHE)
      return failure('trade-proof-capacity', 'Too many trade-proof requests are pending');
    this.pendingTradeProofs.set(requestId, { request, ownerHost });
    return this.send(ownerHost, { t: 'TRADE_PROOF_REQUEST', request });
  }

  /** Cancel a pre-admission proof wait; late responses are then ignored. */

```

```typescript
  private restoreController(
    context: ProposalContext,
    exact = false,
  ): Promise<Result<ConsensusController>> {
    return ConsensusController.restore({
      context,
      requireExactRestore: exact,
      seat: this.options.seat,
      secretKey: this.secretKey,
      store: journalSafetyStore(this.options.journal, context.log.head.seq + 1),
      onEffects: (effects) => this.handleEffects(effects),
      admitLocalValue: (proposal) => this.canVoteForRecoveryProposal(proposal),
      beforePersist: (previous, next) => {
        const timed = this.admitTimedVotes(previous, next);
        return timed.ok ? this.admitRecoveryVotes(previous, next) : timed;
      },
    });
  }

  private installController(controller: ConsensusController, context: ProposalContext): void {
    this.controller = controller;
    this.controllerAnchor = Object.freeze({
      seq: context.log.head.seq,
      hash: entryHash(context.log.head),
      genesisDigest: context.membership.genesisDigest,
      voters: Object.freeze(context.membership.voters.map((voter) => voter.publicKey)),
      membership: Object.freeze({
        ...context.membership,
        voters: Object.freeze(
          context.membership.voters.map((voter) => Object.freeze({ ...voter })),
        ),
      }),
    });
  }

  private async openController(): Promise<Result<void>> {
    const opened = await this.restoreController(this.context);
    if (!opened.ok) return opened;
    this.installController(opened.value, this.context);
    return success(undefined);
  }

  private enterDerivedRepair(): boolean {
    if (this.derivedRepair) return true;
    if (!this.controller || !this.controllerAnchor) return false;
    const stopped = this.controller;
    stopped.dispose();
    this.controller = null;
    this.derivedRepair = {
      stopped,
      anchor: this.controllerAnchor,
      heldCommits: new Map(),
      lastRequestAt: -Infinity,
    };
    this.clearConsensusTimers();
    this.clearTimedVoteRetry();
    this.status({ kind: 'halted', code: 'consensus-context' });
    this.requestDerivedSnapshot();
    this.schedulePulse();
    return true;
  }

  private requestDerivedSnapshot(): Result<void> {
    const hold = this.derivedRepair;
    if (!hold || this.options.clock.now() - hold.lastRequestAt < 2_000) return success(undefined);
    hold.lastRequestAt = this.options.clock.now();
    return this.broadcast({
      t: 'SNAPSHOT_REQ',
      genesisDigest: hold.anchor.genesisDigest,
      atSeq: hold.anchor.seq,
    });
  }

  private retainHeldCommit(certified: CertifiedEntry): void {
    const hold = this.derivedRepair;
    if (
      !hold ||
      certified.entry.seq !== hold.anchor.seq + 1 ||
      certified.entry.prevHash !== hold.anchor.hash ||
      hold.heldCommits.size >= 4
    )
      return;
    const hash = entryHash(certified.entry);
    if (hold.heldCommits.has(hash)) return;
    if (
      !verifyObject(
        'entry',
        entryBody(certified.entry),
        certified.entry.sig,
        parsePeerId(certified.entry.sequencer),
      )
    )
      return;
    const certificate = verifyCertificate(certified.certificate, hold.anchor.membership, {
      seq: certified.entry.seq,
      term: certified.entry.term,
      phase: 'precommit',
      valueHash: hash,
    });
    if (!certificate.ok) return;
    hold.heldCommits.set(hash, copyCanonical(certified));
  }

  private receiveDuringRepair(from: PeerId, message: ProtocolMessage): Promise<Result<void>> {
    const hold = this.derivedRepair;
    if (!hold || !hold.anchor.voters.includes(from)) return Promise.resolve(success(undefined));
    if (message.t === 'SNAPSHOT_RES') {
      if (
        message.genesisDigest !== hold.anchor.genesisDigest ||
        message.atSeq !== hold.anchor.seq ||
        !this.admitExpensiveRequest(from, `snapshot-response/${toHex(hashValue(message.snapshot))}`)
      )
        return Promise.resolve(success(undefined));
      return this.repairNow(message.snapshot);
    }
    if (message.t === 'COMMIT') this.retainHeldCommit(message.certified);
    if (message.t === 'PING') return Promise.resolve(this.send(from, { t: 'PONG', n: message.n }));
    return Promise.resolve(success(undefined));
  }

  private enqueue<T>(
    operation: () => Promise<Result<T>>,
    duringRepair = false,
  ): Promise<Result<T>> {
    const result = this.queue.then(async (): Promise<Result<T>> => {
      if (this.disposed) return failure('replica-disposed', 'Replicated log is closed');
      if (this.controller?.hasContextFault() && this.enterDerivedRepair())
        return failure('consensus-context', 'Certified context changed; awaiting durable replay');
      if (this.derivedRepair && !duringRepair)
        return failure('replica-repairing', 'Awaiting certified derived-state repair');
      const repairing = this.derivedRepair;
      try {
        const outcome = await operation();
        if (
          ((!repairing && this.derivedRepair) ||
            this.controller?.hasContextFault() ||
            (!outcome.ok && outcome.error.code === 'consensus-context')) &&
          this.enterDerivedRepair()
        )
          return failure('consensus-context', 'Certified context changed; awaiting durable replay');
        if (!outcome.ok && FATAL_CONTROLLER_ERRORS.has(outcome.error.code)) {
          this.status({ kind: 'halted', code: outcome.error.code });
          this.dispose();
        }
        return outcome;
      } catch {
        if (
          ((!repairing && this.derivedRepair) || this.controller?.hasContextFault()) &&
          this.enterDerivedRepair()
        )
          return failure('consensus-context', 'Certified context changed; awaiting durable replay');
        this.status({ kind: 'halted', code: 'replica-transition' });
        this.dispose();
        return failure('replica-transition', 'Replicated log transition failed');
      }
    });
    this.queue = result;
    return result;
  }

  /** Synchronous ingress may detect a fault while a persisted transition is awaiting storage. */
  private queueContextCheck(): void {
    if (this.contextCheckQueued || this.disposed) return;
    this.contextCheckQueued = true;
    void this.enqueue(() => Promise.resolve(success(undefined)), true).then(() => {
      this.contextCheckQueued = false;
      return undefined;
    });
  }

  private attachTransport(): void {
    this.unsubscribers.push(
      this.options.transport.onMessage((from, bytes) => {
        if (this.blockedPeers.has(from)) return;
        if (!this.knownSyncPeer(from)) {
          this.rejectPeer(from);
          return;
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_MESSAGE_BYTES) {
          this.strikePeer(from);
          return;
        }
        const peerQueued = this.queuedByPeer.get(from) ?? 0;
        if (
          peerQueued >= MAX_QUEUED_MESSAGES_PER_PEER ||
          this.queuedMessages >= MAX_QUEUED_MESSAGES_TOTAL
        ) {
          // Congestion does not prove peer misconduct. Honest retransmission bursts
          // may exceed the bounded queue while a certified batch is replaying.
          return;
        }
        const copy = bytes.slice();
        this.queuedByPeer.set(from, peerQueued + 1);
        this.queuedMessages += 1;
        void this.enqueue(async () => {
          const result = await this.receive(from, copy);
          if (
            !this.derivedRepair &&
            !this.controller?.hasContextFault() &&
            !result.ok &&
            !FATAL_CONTROLLER_ERRORS.has(result.error.code)
          )
            await this.captureRejectedProofs(from, copy);
          return result;
        }, true).then((result) => {
          this.queuedMessages -= 1;
          const remaining = (this.queuedByPeer.get(from) ?? 1) - 1;
          if (remaining === 0) this.queuedByPeer.delete(from);
          else this.queuedByPeer.set(from, remaining);
          if (
            !result.ok &&
            (result.error.code === 'invalid-envelope' ||
              result.error.code === 'invalid-encoding' ||
              result.error.code === 'message-too-large' ||
              result.error.code === 'command-proof-invalid' ||
              result.error.code.endsWith('-signature'))
          )
            this.strikePeer(from);
          return undefined;
        });
      }),
    );
    this.unsubscribers.push(
      this.options.transport.onPeerChange((peer, online) => {
        void this.enqueue(async () => {
          if (this.derivedRepair) return this.pulse();
          const checked = this.activeController().snapshot();
          if (!checked.ok) return checked;
          this.observeAllRecoveryPresence();
          if (online) this.cancelRecoveryForReturningPeer(peer);
          return this.pulse();
        }, true);
      }),
    );
  }


```

```typescript
  private strikePeer(peer: PeerId): void {
    if (this.derivedRepair) return;
    const checked = this.controller?.snapshot();
    if (checked && !checked.ok) {
      if (checked.error.code === 'consensus-context') this.queueContextCheck();
      else this.failClosed(checked.error.code, checked.error.message);
      return;
    }
    const count = (this.invalidByPeer.get(peer) ?? 0) + 1;
    this.invalidByPeer.set(peer, count);
    if (count >= INVALID_MESSAGE_LIMIT) this.rejectPeer(peer);
  }

  private rejectPeer(peer: PeerId): void {
    if (this.blockedPeers.has(peer)) return;
    this.blockedPeers.add(peer);
    try {
      this.options.transport.disconnect(peer);
    } catch {
      // The local receive path still blocks this peer if transport teardown fails.
    }
  }

  /** Bound repeated work without allowing trade preparation to consume repair capacity. */

```

```typescript
  private async captureRejectedProofs(from: PeerId, bytes: Uint8Array): Promise<void> {
    if (
      this.disposed ||
      this.derivedRepair ||
      this.controller?.hasContextFault() ||
      this.context.log.genesis.security !== 'verified'
    )
      return;
    const checked = this.controller?.snapshot();
    if (checked && !checked.ok) {
      if (checked.error.code !== 'consensus-context')
        this.failClosed(checked.error.code, checked.error.message);
      return;
    }
    if (
      !this.context.membership.voters.some((voter) => voter.publicKey === from) ||
      !this.admitExpensiveRequest(from, `capture/${toHex(hashValue(bytes))}`, 'cheat')
    )
      return;
    for (const claim of rejectedWireProofCandidates(bytes, this.context.log)) {
      // Retain before gossip; a candidate is still untrusted until the objective
      // verifier checks its signature and proof against this certified parent.
      // oxlint-disable-next-line no-await-in-loop -- Bounded candidates share one durable outbox.
      const retained = await this.rememberCheatClaim(claim, true);
      if (!retained.ok && retained.error.code.startsWith('cheat-store-'))
        this.status({ kind: 'rejected', code: retained.error.code });
    }
  }


```

```typescript
  private async handleEffects(effects: readonly ConsensusEffect[], index = 0): Promise<void> {
    const effect = effects[index];
    if (!effect || this.derivedRepair) return;
    switch (effect.kind) {
      case 'broadcast-proposal':
        this.requireSend(this.broadcast({ t: 'PROPOSAL', proposal: effect.proposal }));
        break;
      case 'broadcast-vote':
        this.requireSend(this.broadcast({ t: 'VOTE', vote: effect.vote }));
        break;
      case 'schedule-timeout':
        this.scheduleConsensusTimeout(effect.phase, effect.round);
        break;
      case 'request-value':
        void this.enqueue(() => this.maybePropose());
        break;
      case 'request-proposal':
        this.requireSend(
          this.broadcast({
            t: 'PROPOSAL_REQ',
            genesisDigest: this.context.membership.genesisDigest,
            epoch: this.context.membership.epoch,
            seq: this.context.log.head.seq + 1,
            term: effect.round,
            valueHash: effect.hash,
          }),
        );
        break;
      case 'commit':
        await this.persistCommit(effect.certified);
        break;
      case 'equivocation': {
        void this.enqueue(() => this.rememberAccusation(controlForEquivocation(effect.evidence)));
        break;
      }
      case 'halt': {
        this.status({ kind: 'halted', code: effect.reason });
        const state = this.activeController().snapshot();
        if (state.ok && state.value.haltKind === 'certified-validation')
          this.requireSend(
            this.broadcast({
              t: 'SNAPSHOT_REQ',
              genesisDigest: this.context.membership.genesisDigest,
              atSeq: this.context.log.head.seq,
            }),
          );
        break;
      }
    }
    await this.handleEffects(effects, index + 1);
  }

  private async persistCommit(certified: CertifiedEntry): Promise<void> {
    const prior = this.activeController().snapshot();
    if (!prior.ok) throw new Error(`Voting record failed: ${prior.error.code}`);
    const previous = this.context;
    const checked = validateCertifiedEntry(certified, previous);
    if (!checked.ok) throw new Error(`Certified entry failed replay: ${checked.error.code}`);
    const advanced = advanceContext(previous, checked.value);
    if (!advanced.ok) throw new Error(`Certified context failed: ${advanced.error.code}`);
    const next = advanced.value;
    const controlProof =
      checked.value.entry.payload.kind === 'control'
        ? objectiveProofParentHash(checked.value.entry.payload, previous)
        : null;
    if (controlProof && !controlProof.ok)
      throw new Error(`Committed accusation proof failed: ${controlProof.error.code}`);
    const provenOffender =
      prior.value.provenOffender ??
      (checked.value.entry.payload.kind === 'control' && controlProof?.ok
        ? {
            control: checked.value.entry.payload,
            atSeq: objectiveEvidenceSeq(checked.value.entry.payload),
            parentHash: controlProof.value,
          }
        : null);
    const pendingAccusation =
      checked.value.entry.payload.kind === 'control' ? null : prior.value.pendingAccusation;
    const retired = !next.membership.voters.some(
      (voter) => voter.seat === this.options.seat && voter.publicKey === this.self,
    );
    const nextSafety = retired
      ? createRetiredSafety(previous, certified, this.options.seat, prior.value)
      : createConsensusState(next, this.options.seat, provenOffender, pendingAccusation);
    if (!nextSafety.ok) throw new Error(`Next voting state failed: ${nextSafety.error.code}`);
    const current = await this.options.journal.loadSafety(certified.entry.seq);
    const snapshot = this.activeController().snapshot();
    if (
      !snapshot.ok ||
      !current ||
      current.revision !== this.activeController().persistedRevision() ||
      !sameBytes(current.bytes, canonicalEncode(snapshot.value)) ||
      !(await this.options.journal.commit(
        certified.entry.seq,
        this.activeController().persistedRevision(),
        certified,
        canonicalEncode(nextSafety.value),
      ))
    )
      throw new Error('Certified journal commit lost its safety CAS');
    this.activeController().dispose();
    this.context = next;
    this.observeAllRecoveryPresence();
    if (checked.value.entry.payload.kind === 'membership') this.pruneRetiredBotOwnership();
    this.timerObserver.advance(next.log.timers ?? []);
    this.clearTimedVoteRetry();
    this.clearRecoveryCandidate();
    this.pendingTradeProofs.clear();
    this.tradeProofResponses.clear();
    this.tradeProofRequestsByFinalizer.clear();
    this.entries.push({ entry: checked.value.entry, certificate: [...checked.value.certificate] });
    this.rememberHumanActivation(checked.value.entry);
    if (checked.value.entry.payload.kind === 'cheat-proof') {
      const id = cheatCandidateId(checked.value.entry.payload.claim);
      this.cheatCandidates.delete(id);
      try {
        await this.options.cheatCandidateStore?.delete(id);
      } catch {
        // A stale auxiliary record is removed during restore after certified replay.
      }
    }
    if (this.lastSyncRequest && next.log.head.seq >= this.lastSyncRequest.fromSeq)
      this.lastSyncRequest = null;
    this.commands.length = 0;
    this.rejectedCommands.clear();
    this.rejectedProposals.clear();
    this.rejectedDeckContributions.clear();
    this.rejectedCountContributions.clear();
    this.rejectedStealMessages.clear();
    this.sentCountContributions.clear();
    this.sentBeaconOperations.clear();
    this.preparedRecovery = null;
    this.sentRecoveryPackets.clear();
    this.accusation = pendingAccusation;
    this.clearConsensusTimers();
    this.refreshPreparedStealStage();
    if (!retired) {
      const opened = await this.openController();
      if (!opened.ok) throw new Error(`Next voting controller failed: ${opened.error.code}`);
    }
    try {
      this.options.onCommit?.(
        detachedValidated(checked.value),
        detachedContext(previous),
        detachedContext(next),
      );
    } catch {
      this.status({ kind: 'halted', code: 'commit-application' });
      this.dispose();
      throw new Error('Committed private-state application failed');
    }
    if (!retired && checked.value.entry.payload.kind === 'membership') {
      const installed = await this.installAuthorityOwnership();
      if (!installed.ok) {
        this.status({ kind: 'halted', code: installed.error.code });
        this.dispose();
        throw new Error(`Certified recovery key installation failed: ${installed.error.code}`);
      }
    }
    this.settlePending(certified);
    const sent = this.broadcast({ t: 'COMMIT', certified });
    if (retired) {
      if (!sent.ok) this.status({ kind: 'rejected', code: sent.error.code });
    } else this.requireSend(sent);
    if (checked.value.entry.payload.kind === 'membership') {
      try {
        const routed = this.options.onMembershipCommitted?.(this.getEntries());
        if (routed && !routed.ok) throw new Error(routed.error.code);
      } catch {
        this.status({ kind: 'halted', code: 'membership-routing' });
        this.dispose();
        throw new Error('Certified membership routing failed');
      }
    }
    // Report a matching membership commit only after the final COMMIT is sent
    // on the old route and the new route is installed. A failed hook disposes
    // with an outcome-unknown result instead of reporting false success.
    this.settleMembership(certified);
    if (retired) {
      this.status({ kind: 'retired', seat: this.options.seat });
      this.dispose();
      return;
    }
    if (pendingAccusation)
      this.requireSend(this.broadcast({ t: 'ACCUSE', control: pendingAccusation }));
    void this.enqueue(async () => {
      await this.captureCertifiedDelivery();
      return this.offerAvailableInput();
    });
  }

  private settlePending(certified: CertifiedEntry): void {
    const committed =
      certified.entry.payload.kind === 'command'
        ? commandHash(certified.entry.payload.signed)
        : null;
    for (const pending of this.pending.splice(0)) {
      this.options.clock.clearTimeout(pending.pendingTimer);
      pending.resolve(
        committed === pending.hash
          ? success(undefined)
          : failure(
              'renewed-intent',
              'A different value committed; confirm the command against the new head',
            ),
      );
    }
  }

  private settleMembership(certified: CertifiedEntry): void {
    const pending = this.membershipIntent;
    this.membershipIntent = null;
    if (!pending) return;
    if (pending.pendingTimer !== undefined) this.options.clock.clearTimeout(pending.pendingTimer);
    const payload = certified.entry.payload;
    const committed = payload.kind === 'membership' ? toHex(hashValue(payload.change)) : null;
    pending.resolve?.(
      committed === pending.hash
        ? success(undefined)
        : failure('renewed-intent', 'Membership intent changed at the certified parent'),
    );
  }

  private resolvePending(hash: string, result: Result<void>): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const pending = this.pending[index];
      if (!pending || pending.hash !== hash) continue;
      this.pending.splice(index, 1);
      this.options.clock.clearTimeout(pending.pendingTimer);
      pending.resolve(result);
    }
  }

  private scheduleConsensusTimeout(phase: TimeoutPhase, round: number): void {
    const height = this.context.log.head.seq + 1;
    const key = `${height}/${round}/${phase}`;
    if (this.timers.has(key)) return;
    const base = phase === 'propose' ? 1_000 : 750;
    const delay = Math.min(2_147_483_647, base * 2 ** Math.min(round - 1, 22));
    const handle = this.options.clock.setTimeout(() => {
      this.timers.delete(key);
      void this.enqueue(() =>
        height === this.context.log.head.seq + 1
          ? this.activeController().dispatch({ kind: 'timeout', phase, round })
          : Promise.resolve(success(undefined)),
      );
    }, delay);
    this.timers.set(key, handle);
  }


```

## packages/protocol/src/consensus-controller.ts

```typescript
  dispatch(event: ConsensusEvent): Promise<Result<void>> {
    return this.enqueue(async () => {
      if (event.kind === 'proposal' && this.isRecordedProposalReplay(event.proposal)) {
        const checked = this.snapshot();
        return checked.ok ? success(undefined) : checked;
      }
      const proposalKey = event.kind === 'proposal' ? this.proposalKey(event.proposal) : null;
      const rejected = proposalKey ? this.rejectedProposals.get(proposalKey) : undefined;
      if (rejected) {
        const checked = this.snapshot();
        if (!checked.ok) return checked;
        return failure(rejected.code, rejected.message, {
          proposalEntryRejected: true,
          cached: true,
        });
      }
      const next = this.reduce(event);
      if (!next.ok) {
        if (next.error.code === 'consensus-restore' || next.error.code === 'consensus-context')
          this.stopVoting(next.error.code);
        else if (
          proposalKey &&
          next.error.details?.proposalEntryRejected === true &&
          next.error.details.proposalControl !== true
        ) {
          // Entry validation depends on this controller's fixed certified parent,
          // not its current round/votes. Controls can discover a second offender
          // after another proof is retained, so always reconsider them.
          this.rejectedProposals.set(proposalKey, {
            code: next.error.code,
            message: next.error.message,
          });
          if (this.rejectedProposals.size > 16) {
            const oldest = this.rejectedProposals.keys().next().value;
            if (oldest !== undefined) this.rejectedProposals.delete(oldest);
          }
        }
        return next;
      }
      const candidate = next.value.state;
      const admitted = this.options.beforePersist?.(
        copyConsensusStateData(this.state),
        copyConsensusStateData(candidate),
      );
      if (admitted && !admitted.ok) {
        this.owned.discard();
        return admitted;
      }
      let persistedBytes: Uint8Array;
      try {
        const bytes = canonicalEncode(candidate);
        persistedBytes = bytes.slice();
        if (!(await this.options.store.save(this.revision, bytes))) {
          this.owned.discard();
          this.stopped = true;
          return failure(
            'consensus-write-conflict',
            'Voting stopped because a newer record exists',
          );
        }
      } catch {
        this.owned.discard();
        this.stopped = true;
        return failure(
          'consensus-storage',
          'Voting stopped because its state could not be persisted',
        );
      }
      this.persistedBytes = persistedBytes;
      this.revision += 1;
      const committed = this.owned.commit();
      if (!committed.ok) {
        this.owned.discard();
        this.stopVoting(committed.error.code);
        return committed;
      }
      this.state = copyConsensusStateData(candidate);
      // A dispose/crash during the write must not transmit after the write resolves.
      if (this.stopped)
        return failure('consensus-stopped', 'Controller stopped during persistence');
      return this.emit(next.value.effects);
    });
  }

  dispose(): void {
    this.stopVoting();
  }

  private stopVoting(code?: string): void {
    if (code === 'consensus-context') this.contextFault = true;
    this.stopped = true;
    this.secretKey.fill(0);
    this.rejectedProposals.clear();
  }


```

```typescript
  private enqueue(operation: () => Promise<Result<void>>): Promise<Result<void>> {
    const result = this.queue.then(async (): Promise<Result<void>> => {
      if (this.stopped)
        return failure('consensus-stopped', 'Restore the persisted record before continuing');
      try {
        return await operation();
      } catch {
        this.owned.discard();
        this.stopVoting();
        return failure('consensus-controller', 'Consensus transition failed; voting has stopped');
      }
    });
    this.queue = result;
    return result;
  }

  private reduce(event: ConsensusEvent): Result<ConsensusTransition> {
    return this.owned.dispatch(event, this.secretKey, this.options.admitLocalValue);
  }

  private async emit(effects: readonly ConsensusEffect[]): Promise<Result<void>> {
    if (effects.length === 0) return success(undefined);
    try {
      await this.options.onEffects(effects);
      return success(undefined);
    } catch {
      // The saved state can reproduce signed messages after a partial delivery.
      this.stopped = true;
      return failure('consensus-effects', 'Effect delivery failed; restore before retrying');
    }
  }
```

## packages/protocol/src/replay.ts

```typescript
export function snapshotFromContext(context: ProposalContext) {
  return canonicalDecode(
    canonicalEncode({
      genesisDigest: context.membership.genesisDigest,
      seq: context.log.head.seq,
      hash: entryHash(context.log.head),
      state: context.log.state,
      crypto: context.log.crypto,
      authority: context.log.authority ?? null,
      recovery: context.log.recovery ?? null,
      transfer: context.log.transfer ?? null,
      timers: context.log.timers ?? [],
      lastNonces: [...context.log.lastNonces].toSorted(([a], [b]) => a - b),
      membership: context.membership,
      excludedProposers: context.excludedProposers,
    }),
  );
}


```

```typescript
export function verifyReplaySnapshot(value: unknown, context: ProposalContext): Result<void> {
  try {
    return toHex(hashValue(value)) === toHex(hashValue(snapshotFromContext(context)))
      ? success(undefined)
      : failure('snapshot-mismatch', 'Snapshot differs from the certified replay');
  } catch {
    return failure('snapshot-malformed', 'Snapshot is not canonical data');
  }
}

```

## packages/protocol/src/proposal.ts

```typescript
export function authenticateCertifiedEntry(
  value: unknown,
  context: ProposalContext,
): Result<CertifiedEntry> {
  const parsed = parseCanonical(value, certifiedEntrySchema);
  if (!parsed.ok) return parsed;
  const { entry, certificate } = parsed.value;
  if (context.membership.genesisDigest !== genesisDigest(context.log.genesis))
    return failure('proposal-context', 'Membership does not match the game genesis');
  const authority = validateControllerContext(context);
  if (!authority.ok) return authority;
  const proof = verifyCertificate(certificate, context.membership, {
    seq: entry.seq,
    term: entry.term,
    phase: 'precommit',
    valueHash: entryHash(entry),
  });
  if (!proof.ok) return proof;
  let proposer: VoteContext['voters'][number];
  try {
    proposer = proposerFor(entry.seq, entry.term, context.membership, context.excludedProposers);
  } catch {
    return failure('proposal-context', 'No valid proposer for this height and round');
  }
  if (entry.sequencer !== proposer.publicKey)
    return failure('wrong-term', 'Entry does not belong to the verified sequencer term');
  const currentProposer = (context.log.authority?.controllers ?? context.log.genesis.seats).find(
    (seat) => seat.kind === 'human' && seat.publicKey === proposer.publicKey,
  );
  if (!currentProposer)
    return failure('sequencer-signature', 'Entry signature does not match the sequencer');
  try {
    if (!verifyObject('entry', entryBody(entry), entry.sig, parsePeerId(proposer.publicKey)))
      return failure('sequencer-signature', 'Entry signature does not match the sequencer');
  } catch {
    return failure('sequencer-signature', 'Entry signature does not match the sequencer');
  }
  return success({ entry, certificate: proof.value });
}


```

## packages/protocol/src/votes.ts

```typescript
export function verifyCertificate(
  votes: unknown,
  context: VoteContext,
  expected: ExpectedVote,
): Result<readonly SignedVote[]> {
  const membership = validateContext(context);
  if (!membership.ok) return membership;
  const target = parseCanonical(expected, expectedSchema);
  if (!target.ok) return target;
  const voterCount = membership.value.voters.length;
  const parsed = parseCanonical(
    votes,
    v.pipe(v.array(signedVoteSchema), v.minLength(quorumSize(voterCount)), v.maxLength(voterCount)),
  );
  if (!parsed.ok) return parsed;
  const certified: SignedVote[] = [];
  let priorSeat = -1;
  for (const vote of parsed.value) {
    if (vote.body.seat <= priorSeat)
      return failure('vote-order', 'Certificate votes must be distinct and sorted by seat');
    priorSeat = vote.body.seat;
    const checked = validateWithContext(vote, membership.value);
    if (!checked.ok) return checked;
    const body = checked.value.body;
    if (
      body.seq !== target.value.seq ||
      body.term !== target.value.term ||
      body.phase !== target.value.phase ||
      body.valueHash !== target.value.valueHash
    )
      return failure('vote-conflict', 'Certificate votes do not agree on one height and value');
    certified.push(checked.value);
  }
  return success(certified);
}

```

## packages/protocol/src/replicated-log.test.ts

```typescript
class PausableJournal extends MemoryProtocolJournal {
  pauseUpdates = false;
  pauseSafetyReads = false;
  safetyWrites = 0;
  loads = 0;
  private notify: () => void = () => undefined;
  private release: () => void = () => undefined;
  readonly entered = new Promise<void>((resolve) => {
    this.notify = resolve;
  });
  private readonly resumed = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private notifyRead: () => void = () => undefined;
  private releaseRead: () => void = () => undefined;
  readonly readEntered = new Promise<void>((resolve) => {
    this.notifyRead = resolve;
  });
  private readonly readResumed = new Promise<void>((resolve) => {
    this.releaseRead = resolve;
  });

  releaseWrite(): void {
    this.pauseUpdates = false;
    this.release();
  }

  releaseSafetyRead(): void {
    this.pauseSafetyReads = false;
    this.releaseRead();
  }

  override async loadSafety(height: number) {
    if (this.pauseSafetyReads) {
      this.notifyRead();
      await this.readResumed;
    }
    return super.loadSafety(height);
  }

  override load() {
    this.loads++;
    return super.load();
  }

  override async saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean> {
    this.safetyWrites++;
    if (this.pauseUpdates) {
      this.notify();
      await this.resumed;
    }
    return super.saveSafety(height, revision, bytes);
  }
}


```

```typescript
  test.each([
    'unchanged',
    'locked',
    'proposal',
    'pending',
    'pending-strike',
    'commit-strike',
    'trade-unobserved',
    'blocked-peer',
    'swallowed',
    'bad-submit',
    'safety',
    'locked-safety',
    'engine',
  ] as const)(
    'repairs a corrupted derived context only with unchanged durable authority (%s)',
    async (mutation) => {
      const fixture = fourHumanFixture();
      const engine = { ...fixture.engine };
      const first = fixtureAt(fixture.identities, 0);
      const second = fixtureAt(fixture.identities, 1);
      const local = fixtureAt(fixture.identities, 3);
      const journal = new PausableJournal();
      const transport = new CapturingTransport(local.peerId);
      const clock = new ManualClock();
      const statuses: string[] = [];
      const replica = value(
        await ReplicatedLog.create({
          genesisEntry: fixture.entry,
          engine,
          policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
          seat: 3,
          secretKey: local.secretKey,
          transport,
          clock,
          journal,
          onStatus: (status) => statuses.push(status.kind === 'halted' ? status.code : status.kind),
        }),
      );
      const parent = replica.getContext();
      if (mutation === 'blocked-peer')
        for (let index = 0; index < 5; index++)
          transport.injectBytes(
            fixtureAt(fixture.identities, 2).peerId,
            new Uint8Array(256 * 1024 + 1),
          );
      let safetyBefore = await journal.loadSafety(1);
      if (!safetyBefore) throw new Error('Missing initial durable safety record');

      const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
      const applied = value(fixture.engine.apply(parent.log.state, input));
      const entry = signEntry(
        {
          seq: 1,
          term: 1,
          prevHash: entryHash(parent.log.head),
          payload: { kind: 'system', input, evidence: stubEvidence(parent.log, input) },
          stateHash: toHex(hashValue(applied.state)),
          sequencer: first.peerId,
        },
        first.secretKey,
      );
      const certified = {
        entry,
        certificate: ([0, 1, 2] as const).map((seat) =>
          signVote(
            {
              genesisDigest: genesisDigest(fixture.genesis),
              epoch: 0,
              seat,
              seq: 1,
              term: 1,
              phase: 'precommit',
              valueHash: entryHash(entry),
            },
            fixtureAt(fixture.identities, seat).secretKey,
          ),
        ),
      };

      const proposal = signProposal(
        {
          genesisDigest: parent.membership.genesisDigest,
          epoch: 0,
          entry,
          validRound: null,
          prevotes: [],
        },
        first.secretKey,
      );
      const commandBody = {
        gameId: parent.log.genesis.gameId,
        genesisDigest: parent.membership.genesisDigest,
        seat: 0 as const,
        nonce: 1,
        headSeq: 0,
        headHash: entryHash(parent.log.head),
        command: { type: 'END_TURN' },
      };
      if (mutation === 'locked' || mutation === 'locked-safety') {
        transport.inject(first.peerId, {
          t: 'PROPOSAL',
          proposal,
        });
        await replica.flush();
        for (const seat of [0, 1] as const) {
          transport.inject(fixtureAt(fixture.identities, seat).peerId, {
            t: 'VOTE',
            vote: signVote(
              { ...fixtureAt(certified.certificate, seat).body, phase: 'prevote' },
              fixtureAt(fixture.identities, seat).secretKey,
            ),
          });
          // oxlint-disable-next-line no-await-in-loop -- Persist each authentic prevote before reaching the polka.
          await replica.flush();
        }
        const locked = value(replica['activeController']().snapshot());
        if (
          locked.locked?.hash !== entryHash(entry) ||
          !locked.votes.some((vote) => vote.body.seat === 3 && vote.body.phase === 'precommit')
        )
          throw new Error('Fixture did not persist a real local lock and precommit');
        safetyBefore = await journal.loadSafety(1);
        if (!safetyBefore) throw new Error('Missing locked safety');
      }
      let capturedRejectedProofs = 0;
      const capture = replica['captureRejectedProofs'];
      replica['captureRejectedProofs'] = async (from, bytes) => {
        capturedRejectedProofs++;
        return capture.call(replica, from, bytes);
      };
      const votesBefore = transport.sent.filter((message) => message.t === 'VOTE').length;
      if (mutation === 'pending' || mutation === 'pending-strike') {
        journal.pauseUpdates = true;
        transport.inject(first.peerId, {
          t: 'PROPOSAL',
          proposal,
        });
        await journal.entered;
      } else if (mutation === 'commit-strike') {
        journal.pauseSafetyReads = true;
        transport.inject(second.peerId, { t: 'COMMIT', certified });
        await journal.readEntered;
      }
      let derived: unknown = replica;
      for (const property of ['context', 'log', 'state', 'bank']) {
        if (typeof derived !== 'object' || derived === null)
          throw new Error(`Cannot corrupt derived state at ${property}`);
        derived = Reflect.get(derived, property);
      }
      if (typeof derived !== 'object' || derived === null)
        throw new Error('Missing derived bank state');
      const brick = Reflect.get(derived, 'brick');
      if (typeof brick !== 'number' || !Reflect.set(derived, 'brick', brick + 1))
        throw new Error('Could not corrupt derived bank state');

      if (mutation === 'trade-unobserved') {
        const request = replica.requestTradeProof(
          signTradeProofRequest(
            {
              ...commandBody,
              seat: 3,
              command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
            },
            local.secretKey,
          ),
        );
        if (request.ok || request.error.code !== 'replica-repairing')
          throw new Error('Unobserved corrupt context was used for an outbound trade request');
      } else if (mutation === 'commit-strike') {
        transport.injectBytes(second.peerId, new Uint8Array(256 * 1024 + 1));
        journal.releaseSafetyRead();
      } else if (mutation === 'pending-strike') {
        transport.injectBytes(second.peerId, new Uint8Array(256 * 1024 + 1));
        journal.releaseWrite();
      } else if (mutation === 'pending') journal.releaseWrite();
      else if (mutation === 'swallowed') {
        const fault = replica['activeController']().snapshot();
        if (fault.ok || fault.error.code !== 'consensus-context')
          throw new Error('Swallowed snapshot did not detect the context fault');
        transport.inject(second.peerId, { t: 'VOTE', vote: fixtureAt(certified.certificate, 1) });
      } else if (mutation === 'bad-submit')
        transport.inject(first.peerId, {
          t: 'SUBMIT',
          cmd: signCommand(commandBody, second.secretKey),
        });
      else if (mutation === 'locked')
        transport.inject(second.peerId, { t: 'VOTE', vote: fixtureAt(certified.certificate, 1) });
      else if (mutation === 'proposal')
        transport.inject(first.peerId, {
          t: 'PROPOSAL',
          proposal,
        });
      else transport.inject(second.peerId, { t: 'COMMIT', certified });
      await replica.flush();
      if (mutation === 'pending' || mutation === 'pending-strike' || mutation === 'commit-strike') {
        safetyBefore = await journal.loadSafety(1);
        if (!safetyBefore || safetyBefore.revision !== 1)
          throw new Error('Pending write did not durably retain the signed prevote');
      }
      expect(statuses).toContain('consensus-context');
      expect(replica['disposed']).toBe(false);
      expect(capturedRejectedProofs).toBe(mutation === 'bad-submit' ? 1 : 0);
      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
      expect(transport.sent).toContainEqual({
        t: 'SNAPSHOT_REQ',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: parent.log.head.seq,
      });
      expect((await journal.load())?.height).toBe(1);
      expect(await journal.loadSafety(1)).toEqual(safetyBefore);
      expect(replica.getContext().log.head.seq).toBe(0);

      const writesBeforeHoldTraffic = journal.safetyWrites;
      const tradeRequest = replica.requestTradeProof(
        signTradeProofRequest(
          {
            gameId: parent.log.genesis.gameId,
            genesisDigest: parent.membership.genesisDigest,
            seat: 3,
            nonce: 1,
            headSeq: 0,
            headHash: entryHash(parent.log.head),
            command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
          },
          local.secretKey,
        ),
      );
      expect(tradeRequest.ok ? null : tradeRequest.error.code).toBe('replica-repairing');
      expect(replica['pendingTradeProofs'].size).toBe(0);
      replica.cancelTradeProofRequest('absent');
      transport.inject(first.peerId, {
        t: 'SUBMIT',
        cmd: signCommand(commandBody, first.secretKey),
      });
      transport.inject(second.peerId, { t: 'VOTE', vote: fixtureAt(certified.certificate, 1) });
      transport.inject(second.peerId, {
        t: 'COMMIT',
        certified: {
          entry,
          certificate: certified.certificate.map((vote) => ({
            ...vote,
            sig: fixtureAt(certified.certificate, 0).sig,
          })),
        },
      });
      transport.inject(first.peerId, {
        t: 'SYS_CONTRIB',
        genesisDigest: parent.membership.genesisDigest,
        contribution: {
          kind: 'beacon-reveal',
          signed: {
            body: {
              operationId: entryHash(entry),
              seat: 0,
              index: 1,
              value: parent.membership.genesisDigest,
            },
            sig: fixtureAt(certified.certificate, 0).sig,
          },
        },
      });
      clock.advance(2_000);
      clock.fireFirst();
      await replica.flush();
      expect(journal.safetyWrites).toBe(writesBeforeHoldTraffic);
      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
      expect(transport.sent.filter((message) => message.t === 'CHEAT_CLAIM')).toHaveLength(0);
      expect(transport.sent.filter((message) => message.t === 'TRADE_PROOF_REQUEST')).toHaveLength(
        0,
      );
      expect(transport.disconnected).toHaveLength(mutation === 'blocked-peer' ? 1 : 0);

      transport.inject(second.peerId, {
        t: 'SNAPSHOT_RES',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: parent.log.head.seq,
        snapshot: { forged: true },
      });
      await replica.flush();
      expect((await journal.load())?.height).toBe(1);
      expect(await journal.loadSafety(1)).toEqual(safetyBefore);
      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
      const loadedAfterReplay = journal.loads;
      transport.inject(second.peerId, {
        t: 'SNAPSHOT_RES',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: 0,
        snapshot: { forged: 'distinct' },
      });
      await replica.flush();
      expect(journal.loads).toBe(loadedAfterReplay);

      if (mutation === 'safety') {
        if (!(await journal.saveSafety(1, safetyBefore.revision, safetyBefore.bytes)))
          throw new Error('Could not inject a competing durable safety revision');
      } else if (mutation === 'locked-safety') {
        const changed: unknown = canonicalDecode(safetyBefore.bytes);
        if (typeof changed !== 'object' || changed === null || !journal['record'])
          throw new Error('Missing durable safety fixture');
        Reflect.set(changed, 'locked', null);
        // Deliberately corrupt durable bytes without advancing its CAS revision.
        Reflect.set(journal['record'].safety, 'bytes', canonicalEncode(changed));
      } else if (mutation === 'engine') {
        const apply = engine.apply.bind(engine);
        engine.apply = (state, nextInput) => apply(state, nextInput);
      }

      transport.inject(second.peerId, {
        t: 'SNAPSHOT_RES',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: parent.log.head.seq,
        snapshot: snapshotFromContext(parent),
      });
      await replica.flush();
      // oxlint-disable vitest/no-conditional-expect -- Parameterized authority mutations intentionally have different terminal outcomes.
      if (mutation === 'safety' || mutation === 'locked-safety' || mutation === 'engine') {
        expect((await journal.load())?.height).toBe(1);
        expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(votesBefore);
        expect(statuses).toContain(
          mutation === 'engine' ? 'replica-authority' : 'consensus-write-conflict',
        );
        replica.dispose();
        return;
      }
      // oxlint-enable vitest/no-conditional-expect
      if (
        mutation === 'locked' ||
        mutation === 'proposal' ||
        mutation === 'pending' ||
        mutation === 'pending-strike' ||
        mutation === 'trade-unobserved' ||
        mutation === 'swallowed' ||
        mutation === 'bad-submit'
      ) {
        if (JSON.stringify(await journal.loadSafety(1)) !== JSON.stringify(safetyBefore))
          throw new Error('Repair changed locked durable safety');
        if (mutation === 'pending' || mutation === 'pending-strike') {
          const saved: unknown = canonicalDecode(safetyBefore.bytes);
          if (typeof saved !== 'object' || saved === null)
            throw new Error('Missing decoded pending safety');
          const durableVotes: unknown = Reflect.get(saved, 'votes');
          const emitted = transport.sent
            .filter((message) => message.t === 'VOTE')
            .map((message) => message.vote);
          if (
            !Array.isArray(durableVotes) ||
            durableVotes.length !== 1 ||
            toHex(canonicalEncode(emitted)) !== toHex(canonicalEncode(durableVotes))
          )
            throw new Error('Repair did not retransmit exactly the persisted local prevote');
        }
        transport.inject(second.peerId, { t: 'COMMIT', certified });
        await replica.flush();
      }
      expect((await journal.load())?.height).toBe(2);
      expect(replica.getContext().log.head).toEqual(entry);
      expect((await journal.load())?.entries).toEqual([certified]);
      const replayed = value(
        replayCertifiedPrefix(fixture.entry, [certified], engine, replica['options'].policy),
      );
      expect(replica['activeController']().opensOn(replayed.context)).toBe(true);
      expect(replica['blockedPeers'].has(fixtureAt(fixture.identities, 2).peerId)).toBe(
        mutation === 'blocked-peer',
      );
      replica.dispose();
    },
  );
});

```

## packages/protocol/src/consensus-controller.test.ts

```typescript
  test.each(['accepted', 'rejected'] as const)(
    'a %s proposal cache cannot mask a changed controller context',
    async (kind) => {
      const { options, candidate, emissions, store } = setup();
      const controller = await create(options);
      const proposal = signProposal(
        {
          genesisDigest: options.context.membership.genesisDigest,
          epoch: 0,
          entry:
            kind === 'accepted'
              ? candidate
              : signEntry(
                  { ...entryBody(candidate), stateHash: '0'.repeat(64) },
                  options.secretKey,
                ),
          validRound: null,
          prevotes: [],
        },
        options.secretKey,
      );
      expect((await controller.dispatch({ kind: 'proposal', proposal })).ok).toBe(
        kind === 'accepted',
      );
      const saved = await store.load();
      const sent = emissions.flat().length;
      options.context.excludedProposers = [1];
      expect(errorCode(await controller.dispatch({ kind: 'proposal', proposal }))).toBe(
        'consensus-context',
      );
      expect(controller.hasContextFault()).toBe(true);
      expect(await store.load()).toEqual(saved);
      expect(emissions.flat()).toHaveLength(sent);
      controller.dispose();
    },
  );


```

