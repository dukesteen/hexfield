# Stage 07 cheat-proof integration review

I did not execute any code; everything below comes from reading the attached source.

## Verdict

The current-head path is mostly sound. It authenticates the signer before doing expensive work, the log transition preserves state, and a cheat entry cannot change quorum. The historical path is not ready.

- **Blocking:** D1 and D2. Resolving historical `at` parents can grow exponentially, and whether a peer accepts a historical cheat entry depends on how that peer built its local context.
- **False negatives:** Two variants (lock-phase deck pass, malformed steal `ephemeralProof`) can never produce a finding.
- **False attribution:** `command-proof` can attribute in cases the design says it must not.

## Demonstrated defects

### D1 — High: historical cheat resolution costs grow exponentially

**Location:** `replay.ts` `verifyHistoricalCheat`

**Trace:**

1. Each historical claim calls `replayCertifiedPrefix(genesisEntry, certified.slice(0, atSeq), …)`.
2. That inner replay builds a fresh closure with empty `cheatHistorical` and `historical` caches.
3. Every historical cheat entry inside the inner prefix therefore triggers its own nested replay.
4. Suppose cheat entries C₁…Cₖ are placed so that each Cᵢ's `at` lies after Cᵢ₋₁. For example, Cᵢ sits at seq sᵢ with `at = sᵢ₋₁`, and any entry sits between them so that `at` is never the head.
5. The cost is then T(i) = 1 + Σⱼ<ᵢ T(j) = 2^(i−1) full replays.
6. The outer 16-entry cache only helps when two outer claims share an `atSeq`.

**Who can trigger it:** Findings must be valid, but a player can incriminate themselves.

- One seat can plausibly reach about 7 kinds: command, beacon, unlock, count, steal-contribution, delivery, dispute.
- Two colluding seats reach about 14 entries, which is about 8k full replays with certificate checks, run by every late joiner and every replaying peer.
- Six seats reach 2^47.

**Pre-authentication is also missing on this path.** `log.ts` `validateNextEntry` calls `policy.verifyHistoricalCheat(claim)` before anything about the artifact is checked. An elected proposer can put a bogus artifact at a different `atSeq` in each proposal. Every voter then pays one O(n) replay from genesis, including deck-ceremony proofs beyond the 32-entry memo, per proposal.

**Fix:**

- Before any replay, cheaply verify `artifact.sig` against the genesis key for `claim.seat` under the domain for that kind. This holds if every operation key is the genesis key; see the attachments list.
- Resolve parents from checkpoints retained during the single forward replay, or share one memo keyed by `entryHash → finding` across nested replays. Either makes the cost O(c·n).

### D2 — High, impact conditional on the session: validity differs between peers

**Location:** `replay.ts`, `proposal.ts`

**Trace:**

1. `initialProposalContext` sets no `verifyHistoricalCheat`, so a peer that started from genesis rejects every historical claim with `cheat-history`.
2. A peer that loaded through `replayCertifiedPrefix` gets a closure over that replay's local `certified` array.
3. `advanceContext` spreads the context forward, but `certified` never grows after the replay returns.
4. That peer accepts claims with `at ≤ replayed length` and rejects anything later.
5. `payloadSchema` already admits `cheat-proof`, so an elected proposer can propose a valid historical claim today, with no gossip needed.
6. Peers with a resolver prevote; peers without one refuse. If quorum forms, `validateCertifiedEntry` fails permanently on the refusing peers and they stall.

**Impact:** Validity is no longer a deterministic function of the certified prefix. The Stage 06 `verifyHistoricalAccusation` has the same pattern, but it was capped by the single-exclusion limit.

**Minimal fix, choose one:**

- Carry a protocol-constant window of K recent parent contexts inside `ProposalContext`, maintained by `advanceContext`. Reject `at` outside that window deterministically. This also fixes D1.
- Or reject `at ≠ head` in `validateNextEntry` until the resolver is integrated.

### D3 — Medium, false negative: a bad lock pass is never provable

**Location:** `cheat-proof.ts`, deck-pass branch

**Trace:** The branch checks `owner.seat === deck.setup.definition.participants[deck.nextPass]?.seat`. Passes run shuffle 0…n−1 and then lock 0…n−1. For any lock pass, `nextPass ≥ n`, so the lookup is `undefined` and the `'deck-lock-proof'` branch cannot be reached.

**Fix:** Use `participants[nextPass % n]`, or let `applyDeckPass` enforce order and treat `deck-order` as unproven.

### D4 — Medium, false negative: malformed `ephemeralProof` is not attributed

**Location:** `steal-delivery.ts` `verifyStealContribution`

**Trace:** It calls `checked(parseCanonical(...))` inside its `try`. A schema failure throws, is caught, and becomes `'steal-contribution'`. So `'invalid-envelope'` in the cheat allowlist is dead code.

A signed contribution whose `ephemeralProof` is malformed, with every non-proof field intact, returns `cheat-unproven`, which contradicts the design. The test only corrupts `proof`, which the schema types as `v.unknown()`, so it passes.

**Fix:** After authenticating and checking the route with `stealBodyRouteSchema`, attribute a strict-schema failure directly in `cheat-proof.ts`. Alternatively, have `verifyStealContribution` return `invalid-envelope` for parse failures.

### D5 — Low/Medium: `command-proof` attributes before non-proof checks, against the design

**Location:** `cheat-proof.ts` `badCommandProof`

**Trace:** When `readCommandProofs` fails with a code in `PROOF_FAILURES`, the function returns `success(seat)` before several checks that `validateCommandForEntry` performs first:

- `checkInvariants(applied.state)`. A command applied to a state that violates invariants and missing a proof is therefore attributed. The design says a state-invariant failure does not qualify.
- The `deck-reveal-effect` consistency checks. If the engine and command disagree on the number of reveals, `command-proofs-count` blames the player for a policy mismatch.
- `signedCommandSchema`. `commandRouteSchema` is looser: `gameId` is any `v.string()`, the command type has no `label` bound, and `evidence` is `unknown`.

**Fix:** Split `validateCommandForEntry` into two phases:

1. A statement phase: schema with `evidence: unknown`, signature, head/nonce, engine validate and apply, invariants, plan, and reveal-effect consistency.
2. A proof phase: `readCommandProofs`, hand proofs, deck reveal.

Attribute only failures from phase 2, and only after phase 1 has fully succeeded.

### D6 — Low, conditional: a finding can be accepted without being recorded

**Location:** `log.ts` cheat branch

**Trace:** `firstCheatFindings` silently returns `findings` unchanged when `!seats.includes(next.seat)`, or when it hits the cap. The entry is still accepted, and because nothing was recorded, the duplicate check will never stop the same evidence from being committed again, without limit.

The cap cannot bind before a duplicate would. So this depends on whether genesis guarantees that `config.seats` matches `genesis.seats[].seat`; `genesis.ts` is needed to confirm.

**Fix:** In `log.ts`, fail if the returned array has the same length as the input.

### D7 — Low, liveness only

Every cheat entry advances `head`. That makes all in-flight signed commands stale (`headSeq`/`headHash`) and invalidates the anchors their hand proofs are bound to. The cost is bounded at 48 entries per game and can be chosen by a self-incriminating proposer. Note it for slice 2 scheduling.

## Conditional concerns

1. **Count bounds:** `countBodyRouteSchema` hard-codes `maxValue(63)`, while `verifyCountContribution` uses `MAX_HAND_RESOURCE_COUNT`. If that constant is below 63, an out-of-range count (a non-proof field) produces `invalid-envelope` and is attributed. Use the constant.
2. **Malformed nested proofs that throw:** `verifyShuffle`, `verifySchnorr` and `verifyDleq` may throw on well-shaped but invalid points. Those cases fall into catch-alls (`deck-pass` escapes to the outer catch; count gives `count-contribution`) and become unproven. That is conservative, but it contradicts the stated attribution rule.
3. **Deck reveal codes:** Whether `'deck-reveal-kind'` and `'deck-reveal-proof'` from `revealDeckCards` can arise from ledger or local state, rather than the signer's own proof, cannot be checked without `deck-ledger.ts`.
4. **Beacon fixed state:** `getBeaconOperation` behaviour when `beacon.fixed` is set is unknown; a reveal against a fixed operation should not reach `beacon-link`.
5. **Pure verifier trusts its context:** `verifyCheatProof` never validates `context.crypto`, which the tests pass as a partial object cast to `CryptoContext`. This is safe only because the direct path runs `validateCryptoTransition` first and the historical path replays. It does not provide the defense in depth the design prose implies.

## Per-variant status

| Kind                | Real verifier reached in tests?                                                      | Issues                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| command-proof       | Partly. Only the missing-proof path and the honest path, both with a stubbed engine. | D5. No test for an invalid-but-well-formed hand proof, wrong count, malformed evidence, or deck reveal failure. The "wrong signer" test sets `sig` to a 43-char `peerId`, so it fails at `signature64Schema` and never reaches `authenticated`. The "stale" test only changes `at`; it never signs a stale `headSeq` or nonce. |
| beacon-reveal       | Yes (`beacon-link`)                                                                  | Its forged-signature test also fails at the schema. Wrong index and wrong seat are untested.                                                                                                                                                                                                                                   |
| deck-pass           | Shuffle only, with a hand-crafted commitment                                         | D3. Only `nextPass = 0` is tested.                                                                                                                                                                                                                                                                                             |
| deck-unlock         | Yes, with an empty prefix                                                            | A non-empty, invalid or step-mismatched prefix is untested.                                                                                                                                                                                                                                                                    |
| count-proof         | Yes: bad, malformed and forged                                                       | Non-remaining seat, wrong operation, and count bound are untested.                                                                                                                                                                                                                                                             |
| steal-contribution  | Transfer proof only                                                                  | D4. Malformed `ephemeralProof` is untested and would fail the test.                                                                                                                                                                                                                                                            |
| bad-steal-delivery  | Yes                                                                                  | Missing negatives: no dispute present, and a dispute present but hash mismatch.                                                                                                                                                                                                                                                |
| false-steal-dispute | Yes                                                                                  | Missing negative: `pending.dispute` already set.                                                                                                                                                                                                                                                                               |

**Cross-cutting test gaps:**

- Every test uses `at = head` at seq 0, so the historical path, D1 and D2 are never exercised.
- No attached test runs `validateNextEntry`, replay or snapshot: state and nonce preservation, duplicate rejection at the log level, and `cheats` in the snapshot hash are all untested here.
- A passing test count does not cover any of the demonstrated defects above.

## Attachments needed

- `cheat-log.test.ts`: the six log-level tests I cannot see.
- `p2p-session.ts` / `replicated-log.ts`: how live `ProposalContext`s are built (D2 impact).
- `genesis.ts`: the `config.seats` ⇔ `seats` invariant (D6), whether verified genesis replays deck passes, and whether operation keys are genesis keys (the D1 pre-auth fix).
- `beacon-state.ts`, `deck-ledger.ts` (`nextPass`, `revealDeckCards` codes), `steal-state.ts` (dispute lifetime, `disputeStealContribution`), `steal-proof-cache.ts`, `hand-commitments.ts` (`MAX_HAND_RESOURCE_COUNT`).
- `@cp2p/crypto` verifier throw-versus-false behaviour.
