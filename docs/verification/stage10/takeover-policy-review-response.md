# Review: takeover approval gate, host facade, and policy/presence migration

This review covers only the packet. Behaviour that depends on code outside the excerpts is listed under **Assumptions** rather than inferred.

## Part A: Confirmed issues in current code

### A1. High: losing an approval while locked halts local round progress
**Where:** `replicated-log.ts:2291`, `consensus-controller.ts:205-206`

**Problem.** `admitRecoveryVotes` rejects the whole reducer transition. It does not replace the refused vote with a nil vote. If the refused vote is a re-prevote of a locked or valid value, the round-advancing timeout event is dropped too. That leaves the voter stuck in its old round.

**Sequence (4 humans; target 0; survivors 1, 2, 3; quorum 3):**
1. All three survivors approve and prevote the takeover, forming a polka.
2. Seats 1 and 2 precommit, so they are locked. Seat 3 crashes before precommitting. No certificate forms.
3. The target reconnects. `onPeerChange` calls `clearRecoveryCandidate()`, which clears the approval on every survivor. A restart has the same effect.
4. In the next round, the timeout makes seats 1 and 2 re-prevote the locked value. `beforePersist` returns `recovery-approval-required`, so the timeout transition is never persisted.
5. Seats 1 and 2 cannot advance rounds or vote nil. Only the target and seat 3 can progress, which is below quorum.
6. The only way out is for seats 1 and 2 to click approve again, removing a player who is now present.

The design (`takeover-ui-design.md:13`) says "round timers can move past a declined proposal". The implementation does not do this.

**Smallest sound correction.**
- Pass a local admissibility predicate into the reducer. An unapproved `recovery-authorize` value should be treated like a locally unacceptable value:
  - prevote nil instead of the locked or valid value;
  - precommit nil instead of the polka value;
  - still record the proposal and incoming votes, and still advance the round.
- Prevoting or precommitting nil is always safe under Tendermint-style locking.
- Keep the current `beforePersist` scan as a defence-in-depth assertion.

A related effect of the same design: a rejected transition also drops the peer vote that triggered it. Recovery then depends on retransmission.

### A2. Medium: concurrent requests from two survivors deadlock at a parent
**Where:** `replicated-log.ts:1550`, `:1563-1568`, `:1651-1656`, `:2311`, `p2p-session.ts:888-890`

**Problem.** Several first-wins rules combine badly:
- `rememberRecoveryCandidate` keeps the first candidate it sees (first wins).
- The host's own `approveRecoveryAuthorization` replaces its candidate with its own.
- `RECOVERY_SUBMIT` returns early whenever a `recoveryIntent` exists.
- A proposal for a non-matching statement is discarded.

**Sequence:**
1. Survivors 1 and 2 both click "Request takeover" on the same parent.
2. Each approves only its own statement and holds its own intent.
3. Survivor 3 approves whichever candidate arrived first.
4. No value can reach 3 of 3.
5. Neither host can see or approve the other's candidate. There is no API to withdraw an intent.

The same mechanism lets one malicious survivor pin the candidate slot. Honest voters then never see the legitimate host's candidate. In the current code this does not change who may take over, but it blocks liveness.

**Correction.** Make the initiator deterministic in vote mode as well: the lowest active remaining human seat from certified authority. Enforce it in `requestTakeover` and as an honest-voter rule for candidate admission and approval.
- This adds no new power. In a 4-human game every survivor is already required for quorum.
- Alternative: keep one candidate per `hostSeat` per parent (at most 5), and add an explicit withdraw.

### A3. Medium: `requestTakeover` silently revokes an existing approval, then fails
**Where:** `p2p-session.ts:888-890`, `replicated-log.ts:634-640`, `:579-582`

**Sequence:**
1. Survivor B has approved A's candidate. A's submit has become B's `recoveryIntent`.
2. B clicks request.
3. New keys are reserved durably.
4. `approveRecoveryAuthorization` overwrites `recoveryApproval` with B's statement.
5. `submitRecovery` then fails with `recovery-intent-pending`.

**Result.** B, possibly the elected proposer, still holds A's intent but can no longer vote for it. The gate refuses B's own prevote.

**Correction.**
- Before generating keys, refuse when a conflicting intent or approved candidate exists at this parent.
- Do the approve and submit steps as one queued replica operation, so the check and both steps are atomic.

### A4. Medium-low: target return does not cancel an uncommitted intent, and the clear runs outside the queue
**Where:** `replicated-log.ts:982-989`, `:2320-2325`

**Problem.** `clearRecoveryCandidate` clears the candidate, approval, pending submit and pending proposal. It leaves the following in place:
- `recoveryIntent`,
- its `pendingTimer`,
- the unresolved `submitRecovery` promise.

**Effect.** The host keeps proposing the takeover. Peers are re-prompted by the candidate that `PROPOSAL` re-creates, even though the target is online. This contradicts `takeover-ui-design.md:21` ("clears the local candidate immediately"). A repeated `requestTakeover` restores the host's approval but still returns `recovery-intent-pending`.

The listener also mutates state synchronously outside `enqueue`. An in-flight `approveRecoveryAuthorization` can then report `ok` after its approval has already been cleared.

**Correction.** Enqueue the clear. In the same step:
- drop a `recovery-authorize` intent whose `departedSeat` matches the returning seat;
- clear its timer;
- resolve its promise with `recovery-target-returned`.

### A5. Medium: honest voters can never vote for an amendment
**Where:** `recovery-facade.ts:37-41`, `replicated-log.ts:2289-2290`

**Problem.** `admitRecoveryVotes` runs every `recovery-authorize` value through `previewRecoveryAuthorization`. That function rejects any authorization while one is pending. The public validator does accept amendments (`recovery-membership.ts:268-282`), so the gate refuses every amendment it should admit.

**Effect.**
- The failure code is `recovery-preview-pending`, not `recovery-approval-required`. No candidate reaches the UI.
- While a recovery is pending, gameplay is blocked (`log.ts:150`). If the original host cannot finish (for example, a lost readiness store), the game is stuck.

**Correction.** Pick one:
- Let the preview accept `statement.previous` equal to `pending.entry` and label it as an amendment requiring approval.
- Or document amendments as unsupported, give the gate a named transient code, and drop amendment support from the validator.

### A6. Low
- **Stale reservations are never deleted.** Uncertified readiness records at superseded parents keep their replacement secret keys forever. Delete a slot once the certified head has moved past its parent without certifying it.
- **A reserved bot level cannot be changed.** Once a slot records a bot level, the user cannot pick a different one at that parent (`p2p-session.ts:832-833`). This is fail-closed, but the UI should say why.

## Part B: Answers to the review questions

### Q1. Local approval gate
**Coverage.** Every newly signed non-nil local vote goes through `beforePersist` before `store.save`. This covers proposal receipt, local proposal, timeouts and locked/valid re-entry, provided those paths all go through `dispatch`/`reduce` (see Assumptions). Nil votes and prior durable votes pass. A missing retained proposal fails closed.

**Defect.** Refusals block the whole transition instead of producing a nil vote (A1).

**`RECOVERY_SUBMIT` before approval.** Yes, a different elected proposer can make progress. The submit is kept in `pendingRecoverySubmit`, then promoted and rebroadcast on approval. This matches the regression test, but only for a single uncontested host.

**Overwriting the candidate.** A remote message cannot overwrite the displayed candidate. The first candidate wins, and only a local `approve…(value)` replaces it. The consequences are A2 and A3. `pendingRecoveryProposal` can be replaced only by a proposal for the same statement, which is fine.

### Q2. `requestTakeover` and the readiness loader
**Keys reserved before signatures leave.** Yes. `prepareRecoveryReadiness` writes through `putIfAbsent` before returning, and gossip happens only afterwards. Signatures exist in memory before the write but are not transmitted.

**Loader binding.**

| Property | Where it is bound |
|---|---|
| Parent | slot key includes head seq and hash; `record.slot === slot`; validator checks `statement.parent` |
| Host | certified host key must match the local key |
| Departure | checked explicitly |
| Bot level | checked by the caller, not the loader |
| Replacement keys | each secret must derive its statement public key |
| Signatures | checked by `validateRecoveryTransition` |

**Stale, corrupt or concurrent records.**
- **Stale:** a record for another parent is never found, so it cannot rebase.
- **Corrupt:** fails closed, with no overwrite.
- **Concurrent:** one `putIfAbsent` wins; the loser gets a conflict.
- **Secret handling:** decoded secrets, canonical bytes and derived identities are zeroed. Nothing secret is returned.

**Remaining gaps.** A3 (approval clobbered before the intent check) and A6 (no clean-up).

### Q3. Proposed `takeover` field
**Binding.**
- Adding the field to `LobbyState` means `stateHash` covers it, so every freeze ACK binds it.
- The host edit must add it to `signedConfigSchema` (`lobby.ts:128-135`) and `stateSchema`.
- `configure` already resets ready flags, which is the right behaviour for a policy change. The UI must render the policy before the ACK.
- There is no hash cycle. The agreement comes before genesis, and genesis carries both `body.takeover` and the agreement.
- Add the comparison beside `config` at `genesis-online-start.ts:43`.

**Ordering bug in the plan.** `validateGenesis` parses the strict schema (`genesis.ts:89`) before the version check (`:92`). A v2 save has no `takeover` field. If that field becomes mandatory, the save fails as generically malformed and never reaches `version-mismatch`. The proposed "unsupported game version" message would never appear.
- **Fix:** read `protocolVersion` with a minimal schema first, then parse strictly.
- The lobby's strict `stateSchema` needs the same treatment.

**Version bump.** Bumping to v3 and explicitly rejecting v2 saves is sound. `gameId` and `genesisDigest` both change.

**Canonical encoding.** `{mode:'vote', afterSeconds:'never'}` and `{mode:'auto', afterSeconds:'never'}` mean the same thing but hash differently. Pick one canonical form.

### Q4. Presence entries
**Deterministic validation.** Yes, both entries can be validated from certified context alone.
- `seat-offline`: an active human that is not already marked offline. The 15-second rule stays a local voting rule.
- Honest voters should also never vote `seat-offline` for their own seat.

**`seat-online` proof binding.** The proof binds:
- the parent, which makes it single-use;
- the offline marker ref, so an earlier marker cannot be replayed;
- the generation;
- the key of the current active human controller.

After an authorization, the seat's controller has `kind: 'bot'` (`recovery-membership.ts:347`). The original key therefore cannot announce a return, which matches irreversibility.

**Migration problems to fix.**
1. **Schema variants.**
   - `recovery-membership.ts:248` sends every non-authorize change to `activate()`.
   - `replicated-log.ts:1541` dereferences `change.statement`.
   - `validateRecoveryTransition` requires `decksReady` and applies the history limit, which are wrong preconditions for presence.

   Route presence entries through a separate validator and gossip path.
2. **Presence entries during a pending recovery.** `recoveryCheckDigest` binds the activation parent (`:175-187`). Any presence entry certified between authorization and activation invalidates the collected checks. Forbid presence entries while a recovery is pending.
3. **Document inconsistency.** `takeover-ui-design.md:9` permits taking over a still-online target. `:52` requires the target's offline marker. Reconcile them.

### Q5. Reconnect timing
| Moment of return | Outcome |
|---|---|
| Before `beforePersist` | New positive signatures stop. A4 applies: the intent survives, and the clear runs outside the queue. |
| Between `beforePersist` and save completion | The vote persists and is emitted. It cannot be revoked. This is acceptable because suppression is pointless and restore retransmits it. |
| Vote durable, no certificate | Other approved voters can still certify it. Locked voters hit A1. |
| Certified authorization | Irreversible. The seat is `pending-recovery`, and after migration `seat-online` is invalid. |

**Quorum by game size.**
- **2 humans:** quorum 2, 1 survivor. Rejected. No marker can certify.
- **3 humans:** quorum 3, 2 survivors. Rejected. No marker can certify.
- **4 humans:** quorum 3, and all 3 survivors are required. A missing survivor pauses the game. After one takeover, a second is rejected (covered by the existing test).
- **1 human plus bots:** takeover is impossible.

**Timing.** Restart-conservative timing is sound: the observer starts at zero and a clock moving backward resets it. The certified marker persists across restarts while the local threshold restarts. A deterministic auto-mode initiator costs no liveness, because every survivor is already required for quorum.

## Assumptions (not verifiable from the packet)
- The reducer re-prevotes locked or valid values in later rounds, and `ConsensusController.restore` / `recoverConsensusEffects` only retransmit persisted votes.
- `genesisBody` / `genesisDigest` hash the whole body rather than an explicit field list. If they pick fields, `takeover` must be added there or it is unsigned.
- `freezeHash` in `verifyGameSeatBindings` covers the full frozen `LobbyState`.
- `putIfAbsent` means durable commit, such as a completed IndexedDB transaction.
- `recoveryIntent` promises resolve when a different entry commits.
- The `RECOVERY_SUBMIT` decoder applies `recoveryChangeSchema`.
- The game transport's peer ID equals the certified seat key, which the return detection at `:988` relies on.

## Suggested regression tests
- **A1:** locked survivors after approval loss must still advance rounds with nil votes.
- **A2:** two concurrent requesters must not deadlock.
- **A3:** `requestTakeover` while another intent exists must not replace the existing approval.
- **A4:** target return must cancel the host intent.
- **A5:** amendment admission.
- **Migration:** opening a v2 save must produce the version result, not a malformed-save error.
