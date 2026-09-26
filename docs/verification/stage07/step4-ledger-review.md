# Stage 07 Step 4 committed-hand ledger review

I found no high-severity safety defect in the implemented scope. The mandatory hand checks run before policy callbacks on every path I traced. The main concrete problem is liveness: a certified command can leave a verified game permanently stuck.

## Implemented-scope findings

### M1. Monopoly and robber steals are rejected one entry too late, so a verified game gets stuck

**Affected:** `validateCommandForEntry` (`log.ts`), with the REVEAL_COUNT and STEAL_RESULT rejections in `entryInput` and `planHandTransition`.

**Monopoly counterexample:**

1. Seat 0 plays a revealed Monopoly on `brick`, and seat 1 has `max.brick > 0`.
2. The command's only effect is `card-slot-revealed`. It has no hand obligation, so it is admitted and certified.
3. The engine pushes the `monopoly` phase. Its only pending is `REVEAL_COUNT`, which `entryInput` always rejects in verified mode, and `VerifiedSessionDriver.next` returns `null` anyway.
4. `withClaim` still offers `CLAIM_VICTORY`, but only a player at the victory target can use it. For everyone else no legal input can ever be certified.

**Robber counterexample:**

1. The active seat moves the robber to a hex where an opponent holds cards. The resulting `steal` phase only offers `STEAL`, and that command has no effects, so it is certified.
2. `stealResult` creates a `stealIndex` random pending, and `captureCryptoPending` freezes the beacon for it.
3. `STEAL_RESULT` is then rejected, either by `planHandTransition` or by `beacon-pending` once the fixed outcome exists.
4. `cryptoPending()` now blocks every command, so the game is permanently stuck.

The `quietRobberMove` test helper avoids this path, which is why the tests don't hit it. Neither `P2PSession.validate` nor `getLegalCommands` filters these moves, so a UI or bot can pick them. Step 4 acceptance item 4 explicitly plans to run monopoly through a peer segment.

**Correction:**

- In verified mode, after the preview apply in `validateCommandForEntry`, reject any command whose resulting pending set includes:
  - a `reveal` pending with `systemType: 'REVEAL_COUNT'`, or
  - a `STEAL`-only player pending, or
  - a `stealIndex` random request.
- Use the existing codes `hand-count-delivery-pending` and `hand-steal-unavailable`. These checks are deterministic at the parent, so treating them as objective accusation failures is correct.
- Mirror the same filter in `P2PSession.getLegalCommands` and `validate`, so bots and the UI don't retry these moves forever.
- Document the remaining edge case: every legal robber hex may have a victim. If that happens, the game stops at `moveRobber` until Step 5 lands.

### L1. The legacy `deck-reveal-v1` envelope is accepted with no cutoff

**Affected:** `readCommandProofs`.

A reveal-only command can currently be signed in two valid encodings, legacy and `command-proofs-v1`. Only the owner can produce either, and the nonce stops both from committing, so this is not exploitable. However, it keeps a second parser reachable indefinitely, which is the "two competing envelopes" situation the plan wanted to avoid.

**Correction:** once the version gate in C1 exists, accept the legacy envelope only when replaying history certified under the old version. Reject it for new admissions.

### L2. `hand-count-bound` fails every command globally

**Affected:** `planHandTransition`.

The check fires on any seat's `max > 63`, before and after the input, so if it ever triggered, every command would fail. Base-game banks (19, or 24 with 5–6 players) cannot reach it. Record it as a precondition for enabling any module in verified mode, next to the hook-effect contract.

## Checked with no defect found

**Incoming credits cannot finance outgoing trade promises.** Debits are summed gross per seat and resource. The range statement is `C_parent − debit·G`. Proofs are skipped only when the parent `min` or a verified reveal covers the whole debit.

**A zero count needs a real opening.** A count reveal always creates a Schnorr obligation on `C − count·G` with base `H`, including count zero. `planHandTransition` records every revealed seat and resource, not only those with debits. Accounting forces the reveal to come before any movement for that key, credits included.

**Proof contexts bind the full intent and statement.** The context includes:

- genesis digest, epoch and anchor,
- the command body without evidence (nonce, seat, gameId, parent), cross-checked against the input,
- the input, all effects, the obligation index, and the obligation itself (including its commitment).

Seeds are further separated by seat and genesis in `hand-source`. Identical statements reproduce identical proofs, so no Sigma nonce is reused across different challenges.

**Permissive callbacks cannot replace missing evidence.**

- `verifyCommand` runs only after the hand and deck checks succeed.
- Non-command inputs, including `handled` beacon and deck inputs, always go through `planHandTransition` and `verifyHandProofs(plan, [])`.
- `REVEAL_COUNT` and `STEAL_RESULT` are rejected before `verifySystem` runs.

**Envelope composition:**

- An absent envelope passes only when there are no reveals and no obligations.
- The combined envelope needs exact counts for both sections.
- A legacy envelope is rejected whenever there is an obligation.
- Unexpected empty envelopes are rejected.
- Reveal effects must match the requested slots in order, the claimed card, the owner and the ledger slot.

**Replay and private publication.**

- Owned openings are checked against the parent and the result before `privates` is replaced.
- Blindings stay unchanged under public movements.
- A missing `hands` ledger fails in `validateCryptoTransition`.
- Snapshots include `hands`.

**Bounds on untrusted input.** At most 30 hand proofs and 128 deck entries are accepted. Range width is fixed at 6 bits by the verifier, and every schema is strict.

## Compatibility risk before public online release

### C1. `PROTOCOL_VERSION` stays 1 while validity rules changed

Validity changed in several ways:

- mandatory `hands` in crypto state,
- `command-proofs-unexpected` rejections,
- the hand fold on system inputs,
- a different snapshot hash.

`validateGenesis` gates only on `protocolVersion` and `engineVersion`. As a result, an old peer and a new peer accept the same genesis and then disagree about validity. The consequences:

- Votes on entries one side rejects cause halts.
- `SNAPSHOT_RES` repair always fails across versions.
- Old journals may fail restore with a confusing code rather than `version-mismatch`.
- A persisted locked or valid-round value in an old consensus journal can fail validation after upgrade.

**Correction:** before any public verified release, do one of the following:

- bump `PROTOCOL_VERSION`, or
- require a signed genesis commitment such as `commitments.handLedger = 'v1'` and reject verified genesis without it.

In either case, have restore fail early with an explicit incompatibility code.

## Later Stage 07 requirements (not defects now)

- **Blindings persistence.** Blindings live only in driver memory. Replay from zero is correct only while there are no hidden transfers. Step 5 must persist or deterministically re-derive transfer blindings before hidden steals are enabled.
- **Hand source wiring.** The packet doesn't show where `createHandSource` is wired or what supplies its master. I could not confirm that the voting key is not used as the master. This matters as soon as any obligation becomes reachable.
- **Other-owner trade proofs, count-reveal delivery and uncertain-hand timeout discards.** All of these currently fail closed, which is the intended behaviour. The discard timeout would fail with `hand-proof-count`, which only affects liveness.

## Missing high-value regressions (targeted)

1. **Real engine `CONFIRM_TRADE`, both forms:**
   - an active-seat offer accepted by the counterparty, and
   - a counter-offer from the other seat.

   Use synthetic uncertain bounds for both owners. Assert the obligation seats and counts, and that the active driver returns `hand-proof-owner`.

2. **Commitment substitution:** keep the effects identical, change seat 0's parent `brick` commitment, and check that the original proof is rejected.
3. **Two-obligation reorder:** give two seats obligations, swap their proofs, and check rejection. Also submit a `count` proof in place of a `range` proof.
4. **Oversized envelopes:** 31 hand proofs and 129 deck entries should be rejected before any curve work (spy on `verifyRange`).
5. **Accusations:**
   - A signed proposal of a command missing its required hand proof should satisfy `validateObjectiveAccusation`.
   - The same command at a stale parent should be contextual.
6. **System inputs:** a system input whose effects debit above the parent `min`, with a permissive `verifySystem`, should fail in `validateNextEntry`.
7. **M1 regressions:** after the fix, a Monopoly play with a non-empty victim set and a `MOVE_ROBBER` onto a victim hex should both be rejected at admission. The certified state must stay unchanged.
