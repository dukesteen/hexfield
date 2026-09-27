# Stage 07 Step 6 follow-up review

I did not run any code or tests. Everything below comes from reading the attached source.

## Verdict

- **D1–D6:** each is fixed for the trace given in the first review.
- **Replay resolver:** it is not stale. `ReplicatedLog` shares the replay's `entries` array by reference, so live and restored peers resolve against the same certified ancestry.
- **Cache:** its provenance is sound. It is keyed by the whole claim, filled only from certified entries, and capped at first findings.

Remaining issues:

- **One false negative (N1):** it lets a cheater avoid every `command-proof` finding.
- **Two low-severity gaps in the historical resolver:**
  - N2: a missing cheap hash check, and no work budget on historical cheat proposals.
  - N3: resolver closures bound to the live array can be reached from stale detached contexts.
- **Regression tests:** the D1 test and the live half of the D2 test would still pass against the old, broken code.

## Fix verification

| ID                            | Status                | Notes                                                                                                                                                                                                                       |
| ----------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 amplification              | **Fixed**             | Cost is now O(k·n) with k ≤ 48. See N2 for the remaining per-proposal cost.                                                                                                                                                 |
| D2 live/restore parity        | **Fixed in the code** | The test does not exercise it (T2). See N3 for stale contexts.                                                                                                                                                              |
| D3 lock-pass actor            | **Fixed**             | `participants[nextPass % n]` is correct for passes 0…2n−1, and `cheat-proof.test.ts` covers lock pass `nextPass = 2`.                                                                                                       |
| D4 malformed `ephemeralProof` | **Fixed**             | Minor consistency note below.                                                                                                                                                                                               |
| D5 statement before blame     | **Fixed**             | `validateCommandStatement` runs the strict schema, signature, head, engine validate/apply, invariants, plan and reveal-effect checks before `readCommandProofs`. The `brokenState` and `mismatchedReveal` tests cover this. |
| D6 silent summary drop        | **Fixed**             | `log.ts` rejects unless the summary grows by exactly one. `validateGenesis` enforces `seats[i].seat === i === config.seats[i]`, and the offender always comes from a genesis role, so the guard is purely defensive.        |

### D1: cost trace with the shared cache

Take cheat entries Cᵢ at sequence sᵢ, each citing the previous one: `at = sᵢ₋₁`.

1. When the outer replay reaches Cᵢ, the resolver misses the cache, because a claim is cached only after its own entry validates.
2. It replays `certified.slice(0, sᵢ₋₁)`, sharing `verifiedFindings`.
3. Inside that nested replay, C₁…Cᵢ₋₁ were already cached by the outer loop at `replay.ts` (`verifiedFindings.set` after `validateCertifiedEntry`). They all hit the cache, so the nested replay does no further nesting.
4. Total cost is 1 + (number of historical claims) replays, which is at most 49.

The live path never caches its own committed claim, because only replay loops do. When the next historical claim is validated, its nested replay meets the most recent live-committed claim uncached and pays one extra nested replay. Everything earlier is already in the shared map. That is about two replays per live claim, still linear.

**Cache provenance:**

- `set` happens only after `validateCertifiedEntry` succeeds on a prefix of the same certified array.
- Nested replays only ever replay prefixes (`slice`) of that array.
- The key hashes `at.seq` and `at.hash`, so a cached finding is a pure function of the claim and its certified parent.
- The upper-bound check (`atSeq > certified.length`) and the signer pre-auth both run before the cache lookup.
- Duplicate `(seat, kind)` rejection still runs in `log.ts` after a cache hit.
- A claim from a later entry cannot poison an earlier prefix. Two identical claims would share `(seat, kind)`, so the second would already have been rejected as `cheat-duplicate`.

A minor ordering nit: `set` runs before `advanceContext` and `onEntry`. It is harmless because a failure there aborts the whole replay. Moving the `set` after them makes the invariant obvious.

### D2: shared array trace

1. `create` calls `journal.initialize`, then `restore`.
2. `restore` calls `replayCertifiedPrefix(record.genesis, [], …)`. That returns `entries`, which is the closure's `certified` array.
3. `new ReplicatedLog(…, replayed.value.entries, …)` stores that same array.
4. `persistCommit` validates against `previous` while the array length equals `previous.head.seq`, then calls `this.entries.push(…)`.
5. `repairNow` swaps in a new `context` and new `entries` taken from the same fresh replay, so the two stay paired.
6. `initialProposalContext` is used only for key checks and `createConsensusState`. It is never installed as `this.context`.

## New and remaining findings

### N1: Medium false negative. Skipping a nonce avoids every `command-proof` finding

**Location:** `cheat-proof.ts` `badCommandProof`, the line `body.nonce !== last + 1`.

**Trace:**

1. `validateSignedCommand` accepts any `nonce > last`, so gaps are admitted.
2. Gaps also happen honestly. A client signs k+1 and k+2 at the same head, k+1 commits and k+2 goes stale, so the next command uses k+3.
3. A cheater signs a missing or invalid-proof command with `nonce = last + 2`.
4. The `SUBMIT` preview (`deriveCandidate`) rejects it, as it should.
5. The classifier then returns `cheat-unproven` because the nonce is not exactly +1.

**Impact:** A cheater who always skips a nonce can never be flagged for a command proof.

The exact-nonce check adds nothing to objectivity. The command is already bound to the exact head, the proof binding includes the nonce, and `(seat, kind)` deduplication prevents a second record.

**Fix:** Delete the line. `validateCommandStatement` already rejects `nonce ≤ last`. Also update the design's "next nonce" wording to "an unapplied nonce".

**Regression test:** With `lastNonces = {0: 0}`, a missing-proof `END_TURN` signed with `nonce: 2` should produce a finding for seat 0. A `nonce: 0` replay should stay unproven.

### N2: Low. The historical resolver has no cheap parent check and no work budget

**Trace:**

1. The resolver checks only `atSeq ≤ certified.length` and the signer.
2. The pre-auth check is weak in practice. Authentic signed artifacts are public in the log, such as every committed signed command and beacon reveal.
3. An elected proposer wraps one in a claim and varies `at` across more than 16 sequence numbers, or uses a made-up `at.hash`.
4. Each proposal therefore costs every voter one O(n) replay from genesis before `verifyCheatProof` rejects it. The special case `at.seq === head.seq` with a wrong hash also takes the resolver path and replays everything.
5. `ReplicatedLog.receive` applies `admitExpensiveRequest` only to historical `control` proposals, not to `cheat-proof` ones.

**Impact:** This is bounded. `proposalEntryRejected` strikes the sender once per distinct proposal and blocks it at 5 strikes, so each malicious peer gets about 5–8 replays. A valid finding whose operation stays frozen across several parents can be re-cited at each of them without a strike, but that set is small. This is a cost issue, not a safety issue.

**Minimal fix:**

- In the resolver, before the cache or any replay, reject `at.hash !== (atSeq === 0 ? entryHash(genesisEntry) : entryHash(certified[atSeq - 1].entry))`.
- In `receive` → `PROPOSAL`, handle `cheat-proof` with `at.seq < head.seq` the same way as a historical control proposal: call `authenticateSignedProposal` and then `admitExpensiveRequest(from, 'historical-cheat/' + hash)`.
- Optional: a replay helper that continues forward from the nearest cached parent below `atSeq`, which removes the remaining factor of 48 from restore, snapshot and accusation replays.

**Regression tests:**

- A claim at `{seq: 0, hash: 'f'.repeat(64)}` fails with `replayCreates` unchanged.
- A second distinct historical cheat proposal from the same peer inside the window is not validated.

### N3: Low, latent. Stale detached contexts share the live resolver

`detachedContext` spreads `verifyHistoricalCheat`, so every `getContext()` result keeps a closure over the growing `this.entries`. So does the `previous` context passed to `onCommit`, which is created after the push.

**Trace:**

1. Take `ctx = live.getContext()` at head 1.
2. Entry 2 commits, and the array length becomes 2.
3. Call `validateNextEntry` on `ctx` with a seq-2 cheat entry whose `at = {2, hash(entry2)}`.
4. The resolver passes (2 ≤ 2), replays to 2, and `verifyCheatProof` succeeds. `ctx` accepts an entry at seq 2 that cites its own position as evidence.

`ReplicatedLog`'s internal validation always runs with `array.length === context.head.seq`, so there is no exploit in this repo. `p2p-session` code that validates against an older context would hit it.

**Fix:** Make validity a function of the context. In `log.ts`, reject `claim.evidence.at.seq >= context.head.seq` before calling the resolver, since `at === head` is already handled directly. `verifyHistoricalAccusation` has the same pattern from before this change.

**Regression test:** The trace above should return `cheat-history`.

### Consistency notes (not bugs)

- **D4 check order:** Attribution for a malformed `ephemeralProof` now happens before `decodePoint(sealed.ephemeral)`. A contribution with an undecodable `sealed.ephemeral` is therefore attributed when `ephemeralProof` is malformed, but unproven when `ephemeralProof` is well-shaped. Both are self-signed garbage, so no honest seat can be framed. If you want the stated rule applied literally, decode `sealed.ephemeral` and the transfer points before the strict-schema check.
- **Well-shaped but invalid points:** Nested proofs whose points are the right shape but not valid curve points still depend on whether `verifySchnorr`, `verifyDleq` or `verifySealedEphemeralProof` throw or return false. Throwing gives `count-contribution` / `steal-contribution` (unproven), while `{bad: true}` is attributed. This is the prior conditional #2 and is still open.
- **Count bound:** `max = 63` matches the six-bit hand range. Import `MAX_HAND_RESOURCE_COUNT` instead of the literal to avoid drift.
- **Beacon when fixed:** `getBeaconOperation` requires `active`, so a reveal against a fixed beacon is unproven. This closes prior conditional #4.
- **Pre-auth signer keys:** `authenticatedCheatSigner` assumes deck and count participant keys are the genesis seat keys. If a deck definition ever used different keys, a historical deck claim would fail pre-auth while the same claim at the head passes. That is still deterministic, but it would be a false negative.

## Test review (`cheat-log.test.ts`)

- **T1: the D1 chain test does not assert cost.** The C₃→C₁ and C₄→C₂ chain is replayed, but `replayCreates` is never checked.
  - With current code the four-entry replay makes exactly 4 `createGame` calls: 1 top-level plus one nested replay each for C₂, C₃ and C₄.
  - The pre-fix code makes 5.
  - Assert the exact delta. Better still, build a chain of 6 or more and assert `1 + historicalClaims`.
- **T2: the live/restore test does not exercise the shared array.** `secondClaim` cites genesis (`atSeq 0`), which passes `atSeq ≤ certified.length` even if the array never grew. This means the design doc's statement that "a focused live/restore test verifies this path" is not accurate.
  - After the live `COMMIT` of `firstEntry`, validate a claim with `at = firstEntry` (seq 1) on `live.getContext()`. This is the `thirdClaim` shape.
  - Add the negative: on a fresh replica before that commit, the same claim fails with `cheat-history`.
- **T3: the forged-signature case depends on the fixture.** It signs with `identities.get(1)`. If `voters[0].seat` were 1, the "forged" claim would equal `firstClaim`, hit the cache, and succeed. Choose a signer explicitly different from `firstClaim.seat`.
- **Missing cases:**
  - Gapped nonce (N1).
  - A well-formed but invalid hand proof, e.g. tampered `response`, which should produce a finding. Only the missing-proof path is tested today.
  - `command-proofs-invalid` from malformed evidence.
  - A bogus `at.hash` with no replay (N2).
  - The stale-context case (N3).
  - A budget test for historical cheat proposals.

## Not defects: planned integration

The following are known gaps from `step6-continuation-plan.md`, not demonstrated bugs:

- `CHEAT_CLAIM` gossip and a durable candidate store.
- `offerAvailableInput` priority for cheat candidates and the `candidate()` payload for `cheat-proof`.
- The `invalid-crypto` proposer accusation.
- Session and UI exposure of findings.
- Membership-epoch-aware historical voter sets. `precheckCertifiedEnvelope` notes this too.

Two related items are also planned:

- **D7 (liveness):** a cheat entry changes the head, so in-flight commands must be renewed. This is handled by the plan's re-sign flow.
- **The `deck-pass` kind:** it is unreachable under a verified genesis ceremony, as the design states.
