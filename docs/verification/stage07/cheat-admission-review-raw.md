Five findings. Two items hold: the steal attribution is correct (finding against the victim, no `control` entry, recipient only disputes), and the steal ordering is enforced by `steal-state.ts:236`.

**1. The overspend proof proves the wrong statement; it uses no false witness against the shifted commitment.**
`cheat-admission.test.ts:139,145–147` · doc `:31`

- **What the test does:** Wool is committed as `pedersenCommit(0n, 0n)`, with every blinding set to zero. That is the group identity, and its value is publicly known. The substituted proof is an honest proof that this commitment's value 0 lies in [0, 2⁶). The witness (0, 0) truly opens the commitment.
- **Why that differs from overspend:** The obligation is a range proof over `C_wool − 1·G`. A literal overspend would try to prove that shifted commitment with the wrapped value −1 or a mismatched blinding. The test never does this.
- **Why it is partly vacuous:** `hand-proof-invalid` at `:156` is a generic code. It does not show the rejection came from the statement mismatch rather than the identity point or the `bits: 6` shape. Lines 131 and 162 are real checks.
- **Smallest fix:**
  - Use a nonzero wool blinding.
  - Add one assertion: `proveRange({ commitment: C_wool − G, bits }, q−1 or 63, wrongBlinding, …)` either throws or fails `verifyRange` against the plan's own statement.
  - Change the doc wording to "a valid proof of the unshifted statement."

**2. The "certified ancestry" wording overstates the parent. It is synthetic, not a pinned legal history.**
`cheat-admission.test.ts:65–76, 89–98, 99–112` · doc `:31`

- **Sequence:**
  1. The engine applies the setup and dice steps.
  2. The test then hand-edits the bank and replaces the actor's bounds with `uncertain`.
  3. It swaps the actor's commitments for brick, wool, grain and ore.
  4. The actor alone signs a head. Its `seq` jumps by `history.length`, and its `prevHash` points straight at the old head, so there are no intermediate entries at all.
- **Why the wording is wrong:** Both the doc ("after legal setup and dice steps… does not independently certify those intermediate entries") and the comment at `:87` imply a legal, pinned history. `:80` only shows the edited state passes invariants.
- **Classification:** This is a missing broader trace, not a vacuous assertion.
- **Smallest fix:** Reword the doc and comment to say "an actor-signed, uncertified, seq-skipping parent over an invariant-clean but hand-edited bank, bounds and commitments state."

**3. "Distinct owner and proposer evidence" is never tested with distinct seats.**
`cheat-admission.test.ts:183, 219–225` · doc `:31`

- **What is checked:** `verifyCheatProof` attributes `actor.seat` (`:180`), and the `exclude-proposer` control targets `elected.seat`.
- **Gap:** `proposerFor(head.seq + 1, 1, …)` can elect the actor. If it does, owner and proposer attribution collapse into one seat, and the test still passes.
- **Smallest fix:** Add `expect(elected.seat).not.toBe(actor.seat)`, or pick the term so another seat is elected.

**4. The public proof does pass before the recipient session sees the delivery, but the certified `steal-fixed` is not tied to the delivery that was checked.**
`steal-replica.test.ts:503–511, 530, 541`

- **What holds:** The gate holds both `STEAL_CONTRIB` and the `steal-fixed` proposal. `:505` verifies the public proof and `:511` shows the opening mismatch while the gate is held. So the ordering is sound.
- **Harness caveat:** The mismatch at `:510` is detected by the test code using the thief's secret, not by the recipient session. The session only detects it after `gate.held = false`.
- **Gap:** `fixed` having length 1 does not prove the fixed contribution is `delivery.contribution`.
- **Smallest fix:** Assert `hashValue(fixed[0].entry.payload…contribution)` equals `hashValue(delivery.contribution)`.

**5. The "no `STEAL_RESULT`" assertion is vacuous as proof that a result is blocked. The hand-change checks are real.**
`steal-replica.test.ts:516–528, 549–554` · `steal-state.ts:248` · `steal-delivery.ts:592–613`

- **Why it is vacuous:**
  - The loop breaks as soon as the finding certifies, and the test advances no further ticks afterward.
  - No honest party can produce a receipt, because `createStealReceipt` opens the delivery first and fails on the mismatch.
  - So "no `STEAL_RESULT`" only shows that nobody attempted one.
- **Why it matters:** `verifyStealReceipt` checks only the binding and signature, not the opening. A thief-signed receipt for the bad delivery is therefore well-formed. The dispute check at `steal-state.ts:248` is the only thing that blocks it, and nothing exercises that check.
- **What is real:** The `publicBefore` and `privateBefore` comparisons at `:555–559` are meaningful, since the honest test shows those values do change on a completed steal.
- **Smallest fix:**
  1. After the finding, advance a few more ticks and re-assert.
  2. Build `{ body: stealReceiptBinding(fixed), sig: signObject('steal-receipt', …, thiefKey) }` and call `verifyStealResult` on the replayed disputed state. Expect `steal-result-state`.
