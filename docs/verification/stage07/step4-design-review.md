# Stage 07 Step 4 design review: committed hands integration

This review is static and uses only the pasted plan and source. The prompt disables tools, so I ran nothing. Where I refer to code that was not pasted (`ReplicatedLog`, snapshot checks, `LocalGame`), the claim is conditional.

## Required corrections

### R1. `advance()` discards any effect sidecar

In `packages/engine/src/core/pipeline/engine.ts`, `advance()` rebuilds the transition as `{ state, events }`. The `SEAT_STATUS` branch also builds `{ state, events: [] }` directly.

**Trace:** a handler returns `effects: [debit…]`. `Engine.apply` passes it through `advance()` and the effects are dropped. The protocol then sees an empty effect list, applies no ledger change, and the commitments drift from the engine bounds.

**Fix:**

- Make `effects` a **required** field of `Transition`. The compiler will then flag every construction site: `advance`, `SEAT_STATUS`, the timeout trade-decline branch, `skipRoadBuilding`, and module and test doubles.
- Put resource movement through effect-returning helpers (`exchangeBank`, `movedBounds`, the monopoly `updateSeat` calls), so bounds cannot change without an effect being emitted beside them.

### R2. Nothing detects a missed emission at runtime

The plan relies on tests and the rule "don't enable other modules". State-only hooks (`afterBuild`, `afterDiceRolled`, `onTurnStart`, `onTurnEnd`) and any handler that forgets to emit can still change `bank` or `resources` silently.

**Fix:** add a cheap fail-closed **conservation check** after every prospective apply. It checks consistency; it does not infer effects.

- For each seat, the change in `resources.total` must equal the net of that seat's effects.
- For each resource, the change in `bank[r]` must equal the negated net of the bank-side effects.
- For seats whose bounds are exact at both parent and child, the per-resource change must match.

This requires each debit or credit effect to name its counterparty (`bank` or a seat). The plan's vocabulary does not include one yet.

**Trace:** a future Seafarers `afterBuild` grants a resource from the bank. The check fails the entry before any vote, instead of certifying a ledger/bounds split.

### R3. The ledger fold must run after `engine.apply` for every input, including "handled" ones

Effects exist only after the pure apply. In `validateNextEntry`, `DICE_RESULT`, `START_SEAT` and `CARD_DEALT` take the `transition.value.handled` shortcut and never reach `entryInput`. Production happens on `DICE_RESULT`.

If the hand check is attached to `validateCommandForEntry` or `validateCryptoTransition`, which run before apply, then production credits are never folded.

**Required order in `validateNextEntry`:**

1. Parse the entry, then check sequencer, term and parent.
2. Run `validateCryptoTransition` (beacon/deck gating, no hand work).
3. For commands, check signature, genesis, nonce, parent and `engine.validate`.
4. Run the prospective `engine.apply` to get state and effects, followed by R2 and `checkInvariants`.
5. Derive the obligations from the effects.
6. Check the envelope sections against the exact expected set: no missing, extra or duplicate sections, plus owner signatures and fixed widths.
7. Verify the proofs (deck DLEQs, ranges, Schnorr).
8. Fold the deck and hand ledgers.
9. Check `stateHash` and run `captureCryptoPending`.
10. Run the generic `verifyCommand` / `verifySystem` policy. It can only reject.

### R4. Admission, entry validation and accusation must share one verdict

`validateCommandForEntry` is documented as the shared admission and entry check. `EntryPolicy.verifyCommand` must give the same verdict for "admission, votes and objective accusations".

If hand obligations are checked only in the post-apply entry path, a command can be admitted, proposed, and then rejected at prevote.

**Trace:** an honest sequencer proposes an admitted command whose range proof fails. Depending on which function `invalid-command` evidence replays, peers either cannot accuse the sequencer or accuse it for following the admission verdict.

**Fix:** move the apply → effects → obligations → proofs pipeline into one function. Call it from admission, `validateNextEntry` and the `invalid-command` evidence verifier. I could not see `ReplicatedLog`; confirm its admission call site.

### R5. The public-minimum skip conflicts with count reveals in the same entry

The plan says to omit the range proof only when "the parent minimum covers the entire required debit", and also that "the count proof must precede commitment changes."

**Trace:** in `REVEAL_COUNT`, the victim has `min[ore]=0, max[ore]=3` at the parent and reveals 2. The effects are `reveal(victim, ore, 2)`, `debit(victim, ore, 2)`, `credit(monopolist, ore, 2)`. The parent minimum (0) does not cover the debit (2), so the literal rule demands a range proof on `C − 2G`, which is redundant after the opening. The only other reading, where the reveal is ignored, is also inconsistent.

**Fix:** define a single ordered rule.

- Reveals must precede any debit or credit of the same seat and resource in the entry.
- Reveal statements use the parent commitment.
- Each owner's known lower bound is `max(parent min, revealed exact value)`. Credits never raise it.
- A range proof on `C_parent − D·G` is required iff the aggregate gross debit `D` exceeds that known lower bound.

### R6. Verified mode must reject every `STEAL_RESULT`, not only `resource: 'hidden'`

In `log.ts`, a non-handled system input goes to `policy.verifySystem`, which is the stub. The driver's hidden-steal guard only fires when this peer owns the thief or victim.

**Trace:**

1. The sequencer proposes `STEAL_RESULT { resource: 'ore' }`.
2. Step 4 keeps bounds exact, so the engine accepts it if the victim holds ore.
3. The stub policy approves.
4. The sequencer has picked the stolen type rather than the beacon, and the ledger folds it as a public transfer.

**Fix:** make `STEAL_RESULT` fail in the built-in verified path, in any form, until Step 5 evidence exists. In the fold, treat an opaque transfer effect as an unconditional failure.

For the same reason, `REVEAL_COUNT` must become a built-in handled input with its own evidence. It must never be routed to `verifySystem`.

### R7. Deck reveal verification uses a second command-name switch

Both `validateCommandForEntry` and `VerifiedSessionDriver.prepareCommand` gate deck reveals on `PLAY_DEV_CARD` / `CLAIM_VICTORY`. The plan says obligations come from engine effects. If slot-reveal effects are added but the deck check stays keyed on command names, the two can disagree.

**Trace:** a module command reveals a slot. The engine marks it revealed, `revealDeckCards` never runs, and the deck ledger keeps the slot hidden while the public state shows it revealed.

**Fix:** derive the required deck reveals from the slot-reveal effects and verify them in step 7 of R3. Keep the command-type check only as an assertion that the two sets are equal.

### R8. The evidence envelope needs an exact-set rule and a migration

`revealDeckCards` strictly parses `{ protocol: 'deck-reveal-v1', data }`. For every other command in verified mode, any `evidence` value currently reaches only the stub `verifyCommand`.

**Fix:**

- Define one versioned envelope, for example `command-evidence-v1` with `{ deckReveals?, resources?, ownerResponses? }`, each section bounded.
- Evidence must be absent iff the derived obligations are empty. Any section not demanded by the effects must be rejected.
- Retire top-level `deck-reveal-v1` for new games, or accept exactly one of the two forms. Never accept both, and never allow a deck-only form where resource obligations exist.

### R9. Genesis hands must be checked, not assumed empty

`initializeCryptoContext` should reject a genesis `GameState` with any nonzero resource bound. Otherwise a module's `initializeState` that grants starting cards gives a zero-commitment ledger and a non-empty public hand from sequence 0.

Also, `validateCryptoTransition` rebuilds `{ epoch, beacon, decks }` explicitly. The `hands` field must be required on `CryptoContext`, or this line silently drops it.

### R10. Count-reveal contributions should bind a frozen operation, not the current parent

The design doc says long-lived contributions bind a fixed certified anchor, while commands bind the current parent. The plan binds reveals to the current parent.

**Trace:**

1. Monopoly has victims B, C and D. All three sign at parent P.
2. B's `REVEAL_COUNT` commits, making P′.
3. C's and D's contributions are now stale and must be re-signed. The reveals become sequential round trips, and a brief disconnect by C stalls the phase.
4. An `exclude-proposer` control entry also invalidates every outstanding reveal.

**Fix:** when the monopoly phase is pushed, capture a frozen reveal operation in `CryptoContext`, similar to `captureDeckPending`. It holds the anchor, monopolist, resource, victim set and each victim's commitment at the anchor. The base monopoly phase allows only `REVEAL_COUNT` and `CLAIM_VICTORY`, so a victim's commitment cannot change before their reveal. At inclusion, assert that the current commitment equals the frozen one.

Deliver contributions to all peers, not only the current sequencer, so that a term change does not lose them. Reuse the beacon's one-per-seat delivery cache.

### R11. Asynchronous `submit` needs a reservation and post-await rechecks

In `P2PSession.submit`, `inflight.add` happens only after `prepareSubmission` returns. That is safe today only because preparation is synchronous.

**Traces for an async version:**

- A double click starts two preparations for one seat and nonce.
- `applyCommit` replaces `this.context` mid-await, and the old body gets signed at a stale parent.
- `dispose()` runs `key.fill(0)` mid-await, and the command is signed with a zeroed key.

**Fix:**

1. Reserve the seat (`preparing`) before the first await.
2. Copy the body.
3. After each await, recheck: `status === 'running'`, the head hash is unchanged, the nonce equals `lastNonces + 1`, `expectedRevision` still matches, `validate` still passes, and the key is present.
4. Release the reservation in `finally`.
5. Expose `cancelPending(seat)`.

`P2PSessionOptions` also has no authenticated peer-message channel for trade-proof requests and responses. It needs a bounded side channel through the replica's transport, which the plan does not specify.

### R12. The trade-proof authorization model misses counter-offers

The plan requires the owner to check "the current certified offer, acceptance". In `confirmTrade`, when a non-active seat X proposed through `PROPOSE_TRADE`, there is no acceptance: X's certified proposal is the consent. X's debit is `offer.give`, whereas in the active-proposer case the counterparty's debit is `offer.want`.

**Fix:** specify both shapes explicitly:

- Consent is `acceptedBy ∋ owner` when the active seat proposed, or `proposer === owner && to ∋ active` otherwise.
- The owner recomputes the debit from `counterparty()` semantics and the command's `withSeat`, never from the request.
- Only the active seat, which holds `CONFIRM_TRADE`, may request.

## Unresolved design decisions

**D1. Most Step 4 proof paths are unreachable in legal games.** Bounds become inexact only through hidden steals, which Step 4 rejects. In every legal Step 4 game, `min === max`, so no range proof or other-owner trade proof is ever required, and every blinding stays zero.

Checkpoint 3 ("exercise both owners with real signed messages") therefore needs a synthetic inexact-bounds ledger injected below the engine.

**Recommendation:** in Step 4, ship the verifier and fail-closed obligations, plus pure prove/verify fixtures. Defer the network trade-proof protocol (request, response, persistence) to Step 5, where it becomes reachable and testable end to end. Until then, reject any command that needs another owner's proof with a distinct code. Do not wire untested async consensus code.

**D2. Checkpoint 4 hits a robber quickly.** Unbiased beacon dice produce a 7, then `moveRobber` and `steal`, which Step 4 must reject, so the game stalls. You need to choose between:

- a scripted segment that ends before the first 7 or knight, or
- a test-only shared `randomDerivations` registry. This is consensus-relevant, so all peers need the identical registry, and it must be refused for production genesis.

**D3. Credit-before-debit in one entry.** The parent-only rule is correct for base, because `validatedSides` forbids give/want overlap, so a trade can never both debit and credit one resource. It will reject a future module effect whose legitimate debit depends on an earlier credit in the same input. Record this as a deliberate restriction; changing it later requires a prefix-balance rule.

**D4. Request rate limits.** "One response per (parent, author)" blocks a legitimate second attempt at the same parent, for example a different `offerId` the owner also accepted. Key by `(parent, finalizer, command body hash)` with a small cap per parent instead.

## Answers to the review questions

- **Effects vs. saves and hashes:** this works if effects stay out of `GameState` and events (R1). If `LocalGame` goldens serialize whole transitions, an alternative is `engine.applyWithEffects` that leaves `apply` byte-identical.
- **Escapes from accounting:**
  - Timeouts delegate to real handler `apply` calls, so they inherit effects.
  - The trade-decline timeout moves nothing.
  - An uncertain-bounds discard still fails in `deterministicDiscard`, as intended.
  - Setup grants, Year of Plenty (`plentyReceipt`) and production shortages are computed once in the handlers, so emitting there is correct.
  - Monopoly skips seats whose public `max` is 0, so those seats produce no reveal effect. This is a sound public-bound skip. The plan's "including zero" should say it applies to seats that are actually asked.
  - Hooks remain the only real gap (R2).
- **Nonce reuse:** `proofNonce` already hashes the seed, context and statement, and verifiers hash the same context. The invariant to state is that **everything in the Fiat–Shamir context must also be in nonce derivation**. Never pass request metadata (ids, timestamps) into only one side. With that rule, retries are byte-identical and distinct statements get distinct nonces. Other-owner proofs bind the finalizer's full body (nonce, parent, seats, `withSeat`), so they cannot be reused at a new parent or for another command.
- **Information leakage:** the range proofs are zero-knowledge. A response or a refusal reveals only affordability, which the owner already asserted by accepting or proposing. The owner must compute the statement itself, never accept a commitment from the requester.

## Optional alternatives

- **Persistence of outgoing responses and reveals.** Ed25519 and the seeded proofs are deterministic, so the owner can reconstruct them from the master. Persisting them helps only for byte-for-byte resend after a code-version change. If you keep persistence, key it by genesis and seat and prune it on parent advance.
- **Owner signature on the trade response.** The range proof's soundness already limits production to someone holding the opening. The signature is mainly for attribution when Step 6 blames a bad proof. Otherwise the finalizer, who must verify before including, is at fault.
- **Driver consistency check.** `validOwnedState` could also assert `C_r == n_r·G + s_r·H` after each commit. That gives R2 a private-side twin at no network cost.
