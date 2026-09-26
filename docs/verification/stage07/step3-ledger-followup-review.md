# Stage 07 ledger corrections: follow-up review

**Scope:** only the source supplied. Nothing was run. `consensus.ts`, `control.ts` (`validateObjectiveAccusation`), `beacon-state.ts` and the engine dispatcher were not supplied, and I note where a conclusion depends on them. Disclosed pending work is not re-listed.

## Verdict

- **H1: sound against framing,** provided `verifyCommand` is deterministic. It opens one new unpenalized CPU amplifier (R1).
- **M1: sound** under a retained store with at least one honest human signer.
- **Proof memo: sound.** The remaining cost sits in ledger and receipt revalidation, not in pass proofs.
- **L1–L6:** accepted, with two small residuals noted below.

---

## H1: residual findings

### R1 (Medium, Byzantine peer). Invalid-proof `SUBMIT`s cost full proof work and earn no strike

**Where:** the `receive` `SUBMIT` case, and the strike filter in `attachTransport`.

**Precondition:** one Byzantine voter, holding its own seat key or hosting a bot.

**Trace:**

1. The attacker signs `PLAY_DEV_CARD` or `CLAIM_VICTORY` for a slot it really owns. The command has the exact current `headSeq`/`headHash`, a fresh nonce and an engine-legal shape. The `deck-reveal-v1` evidence is bogus. Each variant (nonce, proof bytes) produces a new command hash.
2. The dedupe check misses, because only _accepted_ commands enter `this.commands`.
3. `validateCommandForEntry` passes the cheap gates (signature, nonce, parent, `engine.validate`). It then runs:
   - `revealDeckCards` → `validateDeckLedger`, which runs one `freezeDeckDraw` and a full setup revalidation and hash per hidden slot;
   - `verifyDeckReveal` → `verifiedReceipt`, which revalidates the setup, re-freezes the draw, and re-verifies up to 5 unlock signatures and DLEQs before the final DLEQ fails.
4. The resulting error codes do not match `invalid-envelope`, `invalid-encoding`, `message-too-large` or `*-signature`. Examples are `deck-reveal-proof`, `deck-reveal-kind`, `deck-reveal-owner`, `deck-reveal-context`, `deck-reveal-slots`, and failure codes from `verifyCommand`. So there is no strike.
5. The per-peer queue cap (8) limits concurrency, not rate. The attacker refills continuously, and every item runs on the single serialized replica queue ahead of votes. This is the same timeout and nil-round effect as the old M2 amplifier, and it is not covered by `admitExpensiveRequest`.

The failure is objective. The parent hash has already matched, so the receiver evaluates the same certified context. An honest sender never sends such a command: `pulse` only rebroadcasts local `pending` items, and those already passed the same check.

**Minimal correction:**

- Split the result of `validateCommandForEntry` into "cheap-gate failure" and "passed cheap gates, then failed proof/policy".
- Strike the sender on the second kind.
- Also reject a `SUBMIT` whose signing seat is neither the sender's own seat nor a bot hosted by the sender. That check is cheap and removes third-party relaying of hostile commands.
- Optionally, keep a small negative cache of failed command hashes, cleared on commit.

### R2 (precondition; becomes High if violated in Stage 09). `verifyCommand` must be a pure function of (signed command, certified context)

Admission, the proposer dry-run and voter validation now share one function. The framing defence therefore reduces to "every honest peer computes the same verdict".

The case that breaks this is §5 of doc 09. Timed-out seats "submit the command itself when its own local timer expires". Suppose any such local-clock or local-private check is placed in `verifyCommand`:

1. An honest proposer's command passes locally and is proposed.
2. A voter whose clock is slower rejects it. Because `payload.kind === 'command'`, that voter stages `invalid-command` against the proposer.
3. `validateObjectiveAccusation` is evaluated with each voter's own clock, so enough peers may agree for the accusation to certify.
4. An honest proposer is excluded.

Required invariants:

- `verifyCommand` performs no clock, network or private-state checks. Time-based acceptance belongs only to `system` entries, which never trigger an accusation in `receive`.
- `control.ts` must re-validate `invalid-command` evidence through the identical `validateEntry` → `validateNextEntry` path and policy. It must not use a variant without `verifyCommand` or with a different crypto context. This is not supplied; please confirm.

### R3 (Low, liveness). Admission is still weaker than full entry validity

Admission omits three checks that the dry-run performs:

- `engine.apply` success;
- `checkInvariants`;
- `captureCryptoPending` (for example, `ambiguous-random-request` or `deck-request-state` after the command).

A command that fails only these checks is admitted everywhere. Only the elected proposer drops it via `candidate()`. Non-proposers keep it, so `offerAvailableInput` keeps reporting `input-available`, which can drive empty or nil rounds until a commit clears the queue.

- **Impact:** bounded, because commands are per-parent and capped at 4 per seat. No framing is possible, since the honest proposer dry-runs first.
- **Correction:** run the post-apply half of `validateNextEntry` at admission as well. A shared "derive command outcome" helper would let both paths use it.

---

## M1: assessment of `prepareGenesisConsent`

**Sound** for the stated threat. `validateGenesis` requires every human's signature. The deck definition and every pass bind `deckCeremonyId`, which covers versions, config, the full seat list with keys, and the nonce. So a second final genesis for the same ceremony needs a second consent from every human, and one honest human with a retained store refuses it.

A different nonce yields a different definition and different `operationId`s, so old passes cannot be transplanted.

**Async semantics:**

- **Mutation:** `body` is canonical-copied and `transcripts` is fully consumed synchronously, before the first `await`. Later caller mutation has no effect.
- **Retry and crash:** Ed25519 is deterministic, so a retry recomputes the identical `sig` and matches the stored record. A crash after a durable `putIfAbsent` returns the same consent next time. A `putIfAbsent` that throws after writing also converges on retry.
- **Race:** exactly one writer wins. The loser loads the winning record and returns `genesis-outbox-conflict`, which is tested.
- **Order of operations:** signing happens before reservation, but the signature is not released unless the reservation succeeds. The only cost is wasted work.
- **Zeroization:** the local copy is wiped in `finally`. `signVerifiedGenesis` wipes `identityFromSecret(...).secretKey`, which is correct only because that function returns a copy. The equality test against `signVerifiedGenesis(first.secretKey)` would fail otherwise, so this is evidenced.

**Residuals.** Neither is a Byzantine safety failure.

- **Local config mistake:** `signGenesis` and `signVerifiedGenesis` can mint consent without reserving it. If `packages/protocol/src/index.ts` exports them to app code, Stage 09 can bypass M1 by accident. Keep them internal or test-only, or make them non-exported from the package entry.
- **Store contract:** `putIfAbsent` must resolve `true` only after the write is durable, for example after the IndexedDB transaction `complete` event rather than on request success. Otherwise a crash can lose the reservation while the signature is already out. State this in the interface docs for Stage 09.

**Related to L2:** consent does not check that the signer's own `commitments.beaconChains[seat]` tip equals its local `BeaconSecretSource`. A coordinator can substitute a tip. It cannot forge reveals, because reveals are seat-signed, so the effect today is a permanent beacon halt after start, which is liveness only. Once Stage 10 adds takeover or exclusion of a seat that "fails to reveal", re-check that this cannot become a way to remove an honest contributor. Adding a tip self-check to consent is cheap and closes it.

---

## Proof memo (M2): assessment

**Soundness:** the memo is sound.

- The key hashes the canonical-copied, validated predecessor state (definition, points, shuffle keys and lock keys) plus the canonical-copied signed pass.
- Every input to `verifyShuffle` is covered: input points, output, `publicKey`, proof, `operationId`, phase and seat.
- Every input to the lock DLEQs is covered: points, output, `shuffleKeys[i]`, `lockKeys`, proofs and context.
- Entries are inserted only after proof success _and_ a successful result revalidation.
- No state is stored, so callers cannot alias or mutate cached results. Signature, actor, order, `operationId`, dimension and point checks all still run on a hit.

Sharing the memo process-wide across replicas and lobby validation is safe, because it is content-addressed.

**Residuals (performance only):**

- **Eviction:** hostile lobby transcripts can evict entries from the 32-entry LRU. They can only insert passes that verify, so the effect is cold-cache cost.
- **Remaining hot cost:**
  - `validateDeckLedger` calls `checkedOperation` → `freezeDeckDraw` for every hidden slot. That revalidates the same `DeckSetupState` (about `25 × (participants+1)` point decodes) and re-hashes it, and it runs 5–7 times per entry validation.
  - Separately, every reveal re-verifies its receipt's whole unlock chain.

  Both happen at admission, proposer dry-run, proposal, commit and each replay. The minimal fix is to validate each deck's setup once in `validateDeckLedger` and pass it to an internal non-revalidating freeze and compare.

- **Unbudgeted path:** R1 is now the only unbudgeted route that reaches this cost.

`decksReady` reading only replay-derived contexts is correct for every call site shown (`cryptoPending`, `prepareBeacon`, `BeaconInbox.refresh`). Keep it off any wire-facing path.

---

## L-items

- **L1: accepted.**
  - The engine requires non-empty `slotIds`, and `automaticVictoryClaim` returns `null` when `needed <= 0`.
  - `revealDeckCards`'s `minLength(1)` is therefore consistent.
  - Withholding a claim only delays the win; it is not a safety issue.
- **L2: accepted as liveness,** plus the beacon-tip note above. I found no concrete safety failure in scope.
- **L3: accepted.**
  - **Residual (local only):** the constructor rebuilds `deckSetupPasses` by re-reading raw `options.deckSetupPasses`, not the copies `checkLocalKey` parsed. An accessor-backed caller object can make the map key (a committed hash) point at a different pass.
  - **Impact:** the proposer dry-run rejects it, so setup stalls locally.
  - **Fix:** return the parsed items from `checkLocalKey` and build the map from them.
- **L4, L5: accepted.**
- **L6: accepted.**
  - The proposal signature is checked first, and wrong term or sequencer is rejected before crypto.
  - **Please confirm in `consensus.ts`:** an already-recorded proposal should be deduplicated _before_ `validateProposal`. Otherwise any voter can replay the current elected proposer's valid deck-pass proposal to force repeated full validation without a strike.

---

## Note for when `DeckInbox` is wired

`remember` fully verifies a strictly longer prefix. The failure codes `deck-unlock-proof`, `deck-unlock-order` and `deck-unlock-point` do not end in `-signature`, so they would repeat R1's no-strike amplifier. Apply the same "passed cheap gates, then failed proof ⇒ strike" rule there.
