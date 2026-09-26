# Stage 07 deck ledger: final correction review

**Scope:** only the supplied source. Nothing was run. `beacon-state.ts`, `deck-draw.ts`, `deck-setup.ts`, the engine and `package.json` were not supplied; conclusions that depend on them are marked. Disclosed pending work is not re-listed.

## Verdict

- **R1, R2, R3, L3, M1:** sound as implemented, with the preconditions noted below.
- **L6:** sound for recorded proposals. It does not cover authenticated _invalid_ proposals, which leaves one unstruck amplifier (F1).
- **One new robustness gap:** widening admission to every replica means a thrown engine exception now self-halts every replica (F2).
- **Readiness:** committable as a checkpoint. Fix F2 first if convenient, since it is a few lines. F1 can follow in the next step.

---

## Findings

### F1 (Medium, Byzantine elected proposer). Replays of an authenticated invalid proposal still cost full validation, with no strike

**Where:** `ConsensusController.isRecordedProposalReplay`, and the `PROPOSAL` case in `ReplicatedLog.receive`.

**Precondition:** one Byzantine voter elected for any round at the current height.

**Trace:**

1. The attacker, as elected proposer, signs a proposal that passes the cheap gates (`proposal-signature`, `wrong-term`, `previous-hash`, `sequencer-signature`) and fails later. Examples:
   - a `CARD_DEALT` system entry with bogus unlock evidence, where `completeDeckDeal` runs ledger validation, `freezeDeckDraw` and up to 5 DLEQs;
   - beacon evidence that fails late in `completeBeaconState`;
   - a command with a false `deck-reveal-v1` proof.
2. `receiveProposal` rejects it, so it is never recorded in `proposals` or `hints`. The L6 byte-compare therefore misses it on every replay.
3. The failure codes (`deck-unlock-proof`, `deck-reveal-proof`, beacon codes, …) are not in the strike list.
   - For non-command payloads the adapter returns immediately. There is no accusation and no budget.
   - For command payloads, `admitExpensiveRequest` gates only the accusation, _after_ `dispatch` has already done the full validation.
4. Any voter can replay the same bytes indefinitely at this height. The proposer can also mint fresh variants within its round. Each replay runs ahead of votes on the serialized queue, which gives the same timeout and nil-round effect as the old M2 and R1 amplifiers. It can also slow commitment of the accusation that would exclude the attacker.

**Minimal fix:** add a per-controller, non-persisted negative cache.

- Keep a bounded set of canonical-byte hashes (for example 16 entries) of proposals whose `receiveProposal` reduce failed with a code other than `consensus-restore` or `consensus-context`.
- On an exact match, return the cached failure without reducing. The adapter's accusation path stays cheap, because it is keyed and deduplicated by `this.accusation`.
- The controller is per height, so the cache dies at commit.

Optionally, strike the sender on the second receipt of a cached-rejected proposal. Honest peers only send proposals from `state.proposals` (`sendRequestedProposal`, `resume`), and those were validated.

### F2 (Medium blast radius, conditional on an engine throw). Peer-triggered exceptions in SUBMIT admission halt the replica

**Where:**

- `deriveCandidate` calls `this.context.log.engine.apply(...)` unguarded, then `signEntry`.
- `validateSignedCommand` calls `engine.validate` unguarded on the `receive` path.

**Trace:**

1. A signed command passes `engine.validate`, but `apply` throws, or `validate` itself throws, on some input.
2. The exception escapes `receive`.
3. `enqueue`'s catch reports `replica-transition` and calls `dispose()`.

One message halts every honest replica. Before R3, only the elected proposer's dry run reached `apply`. Every replica now does.

`validateNextEntry` and `validateCommandForEntry` already wrap their engine calls, so this is an inconsistency, not a design choice. An honest sender never sends such a command, because its own local `submit` would throw first. Impact exists only if the engine has a throwing path; the engine was not supplied.

**Minimal fix:** wrap the body of `deriveCandidate` in `try/catch` returning `failure('entry-verification-failed', …)`, and do the same for the `validateSignedCommand` call in the SUBMIT case.

- The SUBMIT failure then maps to `command-proof-invalid`, which is a strike.
- `entryCandidate` drops the command instead of halting the proposer.

---

## R3: preview signer and round dependence

I found no case where validity depends on the preview's signer, round or entry hash:

- **Term and sequencer:** the term/sequencer equality is tautological, because the policy is built from the same values.
- **Human-seat check:** the sequencer human-seat check always passes, because `checkLocalKey` pins `self` to a certified voter.
- **No election or exclusion check:** `deriveCandidate` goes straight to `validateNextEntry`, not `validateEntry`. An excluded or non-elected replica therefore admits the same set of commands. That is correct for admission.
- **Reveal anchor:** `revealDeckCards` and `verifyDeckReveal` anchor to the command's own `headSeq`/`headHash`/`nonce`, never to the entry.
- **`verifyCommand` inputs:** `verifyCommand` receives only `(command, LogContext)`, not the entry.
- **Pending capture:** the only entry-dependent input is the `captureCryptoPending` anchor (`entryHash(preview)`), which feeds `freezeBeaconRequest` and `freezeDeckDraw`. It changes the constructed operation, not success, assuming neither freeze can fail on anchor content alone (`beacon-state.ts` and `deck-draw.ts` were not supplied). Please confirm that.

**Signing hazard (not a defect):** the preview is an Ed25519 `entry` signature by the voting key over attacker-chosen content.

- It grants no authority alone. Equivocation evidence needs the `proposal` signature too, and certificates need precommits.
- Ed25519 is deterministic, so a later real proposal of the same body yields the same bytes.
- Keep it out of `status`, logs and any `onStatus` payload.

**Minor:** the `receive` SUBMIT path does not check `halted`. A halted replica still spends proof work on admission. This is harmless; an early return would make it cheap.

## R1: admission gates

- **Ordering:** dedupe, then cheap gates, then capacity, then the full preview. This matches the claim.
- **No honest strikes:**
  - Honest senders only rebroadcast `pending`, and those items passed the identical deterministic check at the same parent.
  - Receivers behind or ahead fail with `future-head` or `stale-head` and no strike.
  - Crypto-pending parents reject commands identically on both sides (`deck-setup-pending`, `deck-pending`, `beacon-pending`).
- **Relay:** third-party relay cannot strike an honest peer, and cannot fill another seat's queue with anything that seat did not sign.
- **Residual cost:** at most 4 valid proof variants per attacker-controlled seat per height, plus 4 invalid ones before disconnect. Both are bounded.
- **Precondition (deployment, not code):** version skew in `verifyCommand` or the engine between peers would strike honest peers. Genesis binds versions; make sure the app's `verifyCommand` is covered by that version and not configured separately.

## R2: `verifyCommand` purity and objective evidence

**No framing path found.**

- The accusation runs `validateCommandForEntry` with the same parent `LogContext` and the same pre-reveal context passed to `verifyCommand`.
- The replayed `crypto` and the transition-normalized `crypto` are equivalent, because `revealDeckCards` re-runs `validateDeckLedger` on both.
- All call sites pass the replayed parent's `policy`: `objectiveProofParentHash`, `verifyHistoricalAccusation` and `recoverPersistedAccusation`.
- The accusation performs a subset of entry validation. An honest, valid entry therefore can never become proven evidence.

**Two conservative gaps (Low; neither blocks the commit):**

- **Local crypto damage looks objective.** Parent-ledger shape failures (`deck-ledger-*` from `validateDeckLedger` on a locally damaged `crypto`) are classified as objective. The public-state hash guard does not cover `crypto`. Certification still needs a quorum computing the same thing, so this is not exploitable. It is more conservative, though, to validate `context.log.crypto` up front and return `control-parent` on failure, mirroring the state-hash guard.
- **Pending-crypto commands are not accusable.** A command proposed while crypto is pending (`beacon-pending`, `deck-pending`) is rejected by entry validation but is not accusable. This is liveness only, and the proposer rotates.

## L6: recorded-proposal replay

The private-record precondition holds:

- `proposals` and `hints` are only appended after `validateProposal`, in `receiveProposal`, `propose` and `enterRound` from validated hints.
- They are re-validated on `restore`.
- `this.state` is only replaced after persistence.
- The controller is per height, so its context is fixed.

Skipping is transition-equivalent:

- A hint replay leaves the hint set unchanged, so `maybeJump` has nothing new.
- A past-round replay would only re-run `drive`, whose inputs are unchanged.
- The fall-through covers the only case where a recorded proposal can still drive a first prevote. `restoreConsensusState` guarantees that `propose` has no local vote this round, so the condition reduces to "current round, step `propose`".

See F1 for the uncovered invalid-proposal case.

## L3

Sound. `parseCanonical` detaches each item. The hash, map key and retained value all derive from that one copy, and the constructor receives `key.value`.

## M1

Sound. `index.ts` exports neither `signGenesis` nor `signVerifiedGenesis`, and the store contract text matches the review. Please confirm that `package.json` `exports` does not expose deep subpaths (for example `./src/*` or `./dist/*`); otherwise app code can still import `genesis.js` directly.

---

## Readiness

**Ready to commit as a checkpoint**, not as Stage 07 acceptance.

- **F2:** a small guard. Worth including before the commit, because a single-message self-halt of every replica is disproportionate even if the engine is currently total.
- **F1:** the same class as the fixed R1 and M2 amplifiers. It can land with the `DeckInbox` wiring, which needs the same "authenticated then failed ⇒ cache or strike" rule for `deck-unlock-*` codes.
