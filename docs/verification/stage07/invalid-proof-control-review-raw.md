# Review: invalid-proof proposer accusations

This review covers only the code in the message. I did not see `validateEntry`/`validateCrypto`, `verifyBeaconReveal`, the runtime `rememberAccusation` path, the proposer's pre-sign path, or `replay.js`. Findings that depend on those files are marked **(verify)**.

## High

### H1. Finding a bad proof does not show the entry was invalid. A Byzantine proposer can use this to exclude an honest one.

The `invalid-proof` branch in `validateObjectiveAccusation` succeeds when *any* extracted candidate classifies as bad. It never checks that normal entry validation rejects the proposal at that parent. Proposer fault only follows if every bad candidate forces the entry to be rejected.

The attack goes like this:

- An honest proposer P₁ at `(N+1, term 1)` includes a surplus or ignored artifact. Examples: an extra reveal in a `beacon-fixed` list, or a duplicate-seat reveal where validation takes the first valid one.
- The round times out, so the entry is not certified. The signed proposal still binds to the certified parent.
- Byzantine P₂ at `(N+1, term 2)` proposes `exclude-proposer(P₁)` using that proposal as evidence.
- Honest voters accept it, because they run the same predicate.

The fault limit then compounds the damage. `excludedProposers.length >= 1` means the one exclusion slot is used up on an honest node, and the real Byzantine proposer can never be excluded.

Fix, in order of preference:

- In the `invalid-proof` branch, also require that the full deterministic entry validation fails at `context.log`. Treat contextual failure codes the same way the command path does.
- Or prove and property-test the invariant "classifier-bad ⇒ entry rejected" for every payload shape. Include surplus items, duplicate seats, and reordered lists.

### H2. `rejectedProofCandidates` is now consensus-critical but is maintained as a capture helper.

Voters and historical replay now depend on exactly which candidates it extracts. The deck-pass wrapper fix in this change is itself a consensus rule change: an `invalid-proof` history item rejected by the old extractor validates under the new one. That produces a replay fork between client versions.

Fix: split out a frozen, consensus-owned extractor for control evidence, or version-gate it. Leave `rejectedProofCandidates` free to evolve for best-effort Stage 07 capture.

## Medium

### M1. Your deck-setup-pending test

Under real timing I don't see a path that accuses an honest **proposer**, provided three things hold:

1. **(verify)** The proposer runs full entry validation on its own proposal before `signProposal`. That validation would return `deck-setup-pending`, so an honest node never signs this entry. If the runtime builds `beacon-fixed` from `beaconContributions` without revalidating at the parent, you have a local-fault path. Examples: a store restored after a crash without re-verification, or reveals verified under a pre-transfer signer. The honest-but-damaged proposer then gets excluded. A pre-sign self-check closes this.
2. The evidence proposal is pinned to `head+1`/`prevHash`, and `frozenAtParent` pins the operation. That makes the classification timing-independent for the proposer.
3. **(verify)** `verifyBeaconReveal` must return `beacon-link` only for an absolute chain mismatch against the committed anchor. It must not return it for an index that is ahead of or behind the recorded position. If the link is checked against a "last recorded value", an honest early or out-of-order reveal would classify as `beacon-link`. That is a false finding against the **contributor**, and anyone who relays that honest reveal inside a proposal can trigger it.

The test only covers index 1 at genesis. Add a case with a valid reveal for index k+1 before k is recorded, and one with a stale valid reveal for index k−1.

The test also proves something broader: accusations succeed when normal validation fails for a reason unrelated to the proof. That is fine only once H1 guarantees the entry is invalid. Document it as intentional.

### M2. The deck-pass `deckId` is parsed and then discarded.

`verifyCheatProof` checks the pass against `decks.find(nextPass < length)`, the first pending deck, not the deck named in the wrapper.

- **No false accusation:** the `operationId`, owner-turn and committed `passHash` checks bind the artifact to that deck.
- **False negatives:** a bad pass for any deck other than the first pending one is never provable.
- **Unbound `deckId`:** an entry with a mismatched `deckId` becomes accusable on proof grounds, even though normal validation probably rejects it for the mismatch. That is acceptable only under H1's rule.

Fix: in the extractor, select the deck by `wrapper.deckId` and drop the candidate unless that deck is the one the classifier will pick. Better, carry `deckId` in the claim and check `deck.id === deckId` in the classifier. Add a test with two pending decks.

A side note: the deck-pass branch skips `frozenAtParent` and the genesis-digest check and uses `owner.publicKey` rather than `currentSigner`. The committed-hash check makes this sound, but it is the one branch that ignores epoch and authority. Leave a comment saying why.

### M3. `invalid-proof` with a `command` payload bypasses `CONTEXTUAL_COMMAND_FAILURES`.

The validator accepts `invalid-proof` for command payloads through `badCommandProof`, which uses an empty policy (`{}`). This is presumably sound, since the gate is `PROOF_FAILURES` and those look parent-objective. However, it contradicts the stated intent ("command keeps invalid-command") and gives an accuser two evidence kinds for one act.

Fix: reject `invalid-proof` unless `entry.payload.kind` is `system` or `crypto`. Add a test for it.

## Low

- **L1. Verification cost.** Each ACCUSE can trigger up to 6 beacon checks or 5 unlock checks, and the unlock prefix is re-verified for every index, which is O(n²) ZK verification. It is bounded, but unauthenticated gossip can repeat it. Cache by `(evidence hash, head hash)` and drop duplicates before verifying.
- **L2. Historical determinism across devices.** `verifyCheatProof` resolves signers through `context.authority` and `crypto.epoch`. **(verify)** that `verifyHistoricalAccusation` replays the authority and epoch as of the parent, including device-transfer rotations. Otherwise, after a key rotation, historical accusations either fail (a fork) or authenticate against the wrong key.
- **L3. Two unvalidated fields.** `prevotes` in the evidence proposal and `input` in system payloads are never validated. That is harmless for attribution, but confirm the wire and control size limits cap the embedded proposal size.

## Checks that look correct

- **Signer/epoch/parent:** `authenticatedProposal` checks digest, epoch, `head+1`, `prevHash`, the elected proposer, `sequencer`, and both the proposal and entry signatures. The offender must be the elected proposer for that `(seq, term)`.
- **Local faults:** the state-hash and invariant gate on the parent, plus the runtime's replay and head-equality check before staging, cover local faults on the accuser side.
- **Stale replays:** an old proposal can't be replayed at a new height.
- **Membership:** exclusion never touches voters or quorum, and the first-offender limit is preserved.
- **Stage-then-broadcast ordering:** the halt on an unrecorded local signature is the right safety response.

## Missing tests

1. A property test for the H1 invariant: for each payload kind, if a candidate classifies as bad then `validateEntry` rejects at the parent. Include surplus and duplicate artifacts.
2. An attack test: a later-term proposer tries exclusion using an honest, non-certified proposal that carries an ignored bad artifact. It must fail.
3. Positive cases for every branch: `beacon-v1`, `deck-draw-v1` (bad unlock at each index), `monopoly-count-v1`, `steal-fixed`, `steal-dispute`, and a bad wrapped `deck-pass`.
4. Contributor and proposer as the same seat: the finding is recorded and the exclusion is applied once.
5. A historical accusation verified across a device-transfer epoch change, rotating both proposer and contributor keys.
6. Runtime local fault: a corrupted or restored contribution store must not lead the local proposer to sign a bad-proof proposal (pre-sign self-check).
7. An ACCUSE received after the head advances or after the exclusion is certified: it is dropped, with no halt and no re-stage.
8. `invalid-proof` wrapping a command payload is rejected (M3).
9. Beacon reveals that are early or out of order are not classified as `beacon-link` (M1.3).
