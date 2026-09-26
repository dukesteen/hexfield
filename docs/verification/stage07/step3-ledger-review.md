# Stage 07 deck ledger / genesis integration: security review

**Scope:** the supplied source only. Nothing was run. `ConsensusController`, `control.ts` (`validateObjectiveAccusation`), `beacon-state.ts` and the engine's command validators were not supplied. Where a finding depends on them, I say so.

The disclosed pending items are not reported as bugs: live unlock gossip, owner decoding/reveal production, resource commitments, recovery and persistence. One consequence is expected for this checkpoint: `systemCandidate()` is suppressed while `decks.active`, so no local path yet proposes `CARD_DEALT`.

---

## High

### H1. Command admission is weaker than entry validity, so a seat can frame or stall honest proposers

**Where:** `ReplicatedLog.submit` and the `receive` `SUBMIT` case (both call only `validateSignedCommand`), `ReplicatedLog.candidate`, and `log.ts` `entryInput`, which additionally runs `revealDeckCards` and `policy.verifyCommand`.

**Precondition:** a Byzantine human controls a seat, or hosts a bot seat.

**Trace:**

1. The attacker signs a `PLAY_DEV_CARD` for a slot they own. It has a correct nonce, parent and engine-legal shape, but the `deck-reveal-v1` evidence is garbage, or proves a different card kind. It costs nothing to produce.
2. `SUBMIT` passes `validateSignedCommand`, since that function checks only the signature, nonce, head and `engine.validate`. `rememberCommand` stores it and every replica now has it at `commands[0]`.
3. An honest proposer's `candidate()` picks `commands[0]` and checks it only with `engine.apply`, then signs the entry.
4. At every other voter, `validateEntry` → `entryInput` → `revealDeckCards` fails.
5. What happens next depends on `ConsensusController`, which was not supplied:
   - **If the controller proposes the candidate without full self-validation:** voters take the `PROPOSAL` failure branch, where `payload.kind === 'command'`. They stage `exclude-proposer` with `invalid-command` evidence against the honest proposer. The proposal really is objectively invalid at that parent, so the accusation should validate. The result is that an honest proposer is framed and excluded.
   - **If the controller does self-validate:** the proposal is refused. `commands[0]` is only cleared on commit, so every honest proposer keeps choosing the same invalid command every round. Nothing commits and the game halts. The attacker's nonce is never consumed, so the attack is free to repeat.

**Impact:** either exclusion of an honest proposer through the fault budget (the limit is 1), or a permanent liveness halt. This predates Stage 07 for `verifyCommand`, but the reveal check makes it trivially reachable.

**Minimal correction:**

- Factor the command half of `entryInput` into one function: signature, nonce and parent checks, `revealDeckCards` against `context.log.crypto`, and `verifyCommand`. Use it at admission in both `submit` and `SUBMIT`, after the dedupe check so repeats stay cheap.
- In `candidate()`, dry-run the full `validateNextEntry` against the current context. On failure, drop that command and try the next one instead of proposing.

---

## Medium

### M1. Reusing a ceremony yields the same locked deck, leaking hidden cards across games

**Where:** `deckCeremonyId` excludes `genesisSeed`, `createdAt`, `security` and `commitments`. `createDeckSecretSource` derives shuffle, permutation and locks deterministically from `(master, definition, seat)`. `signVerifiedGenesis` keeps no record of which ceremonies were consumed.

**Precondition:** two fully signed verified geneses share `ceremonyNonce`, config and seats, and differ only in seed or time. Examples are a "restart/rematch" flow, or a coordinator re-drafting after an abort that happened after some play. Honest participants use a long-lived master.

**Trace:**

1. The definition is identical in both geneses, so the honest participants' deck secrets are identical.
2. The pass transcripts, locked points and per-position lock keys are therefore identical.
3. Any position revealed in game A (for example, position 3 = `knight#2`) is the same card in game B.
4. Receipts differ only by `genesisDigest` and anchor, which does not protect the card identity.

`prepareDeckUnlock`'s reservation (keyed by `setupId/position/seat`) incidentally blocks game B only when the same store is reused.

**Impact:** hidden dev cards and VP cards become predictable to anyone who saw game A.

**Minimal correction:** make ceremony freshness an honest-signer invariant. Either:

- keep a durable consumed-`ceremonyId` set that is checked in `signVerifiedGenesis` and before generating passes, or
- require `ceremonyNonce` to include a fresh contribution from each human, which each human verifies before producing passes.

### M2. Repeated expensive verification on replay paths, with a concrete DoS amplifier

**Where:**

- `applyDeckPass` re-verifies each committed shuffle proof and 25 DLEQs every time a deck-pass entry is validated: at proposal, at commit (`persistCommit` → `validateCertifiedEntry`), and in every `replayCertifiedPrefix`.
- Replays are triggered by `SNAPSHOT_REQ` (3 distinct `atSeq` per peer per 10 s), `rememberAccusation` (full replay on every accusation), `recoverPersistedAccusation`, `repairNow`, the old-commit conflict path, and historical accusation resolution.
- `validateDeckLedger` is expensive on every call:
  - `initDeckSetup` runs 25 `hashToPoint` calls.
  - `validateDeckSetupState` does about `cards × (participants+1)` point decodes.
  - For each hidden slot, `checkedOperation` → `freezeDeckDraw` does another full setup validation plus a setup hash.
- `validateDeckLedger` runs 5–7 times per entry validation (transition, `decksReady`, the operation, the final revalidation, `captureDeckPending` and its internal `decksReady`).
- It also runs several times per `offerAvailableInput`: `cryptoPending()` ×2–3, `prepareBeacon`, `BeaconInbox.refresh`, and `prepareBeaconContribution`.

**Precondition:** one Byzantine voter.

**Attack:**

- The attacker sends `SNAPSHOT_REQ` with 3 new `atSeq` values every window.
- Each request forces a full-prefix replay, including all 12 pass proofs and per-entry ledger revalidation.
- Duplicate `SUBMIT`s of one valid command each re-run `offerAvailableInput`, without earning a strike.

The replica queue is serialized, so this delays votes and causes timeouts.

**Minimal correction:**

- Memoize `applyDeckPass` by `(operationId, deckPassHash)` → resulting state. This is sound because the function is pure and the passes are fixed by genesis.
- Treat the replay-derived ledger as trusted internally. Run `validateDeckLedger` only at trust boundaries, and make `decksReady` a cheap cursor check on a trusted value.
- In `validateDeckLedger`, compute `setupHash` once per deck instead of per slot.
- Serve `SNAPSHOT_REQ` at `atSeq === head` from `this.context` without replaying.

---

## Low / robustness

- **L1. `CLAIM_VICTORY` without hidden cards is impossible in verified mode.** `revealDeckCards` rejects `requested.length === 0`, and `revealEvidenceSchema` has `minLength(1)`. If the engine accepts `CLAIM_VICTORY` with `slotIds: []` for a win on public points only, a verified game can never end that way.
  - Needs confirmation against the engine.
  - If confirmed, the fix is to accept empty `slotIds` with absent evidence and no ledger change.

- **L2. `signVerifiedGenesis` can consent to an unplayable genesis.** It checks only the schema, `security` and the deck ceremony. It does not run the checks from `validateGenesis` that are available before signing: versions, seat order, bot hosts, and `createGame` deck matching. It also does not check `initializeDeckLedger` viability; note that `validateDeckLedger` requires deckIds in ascending order but `validateDeckGenesisCommitments` does not. Finally, it does not confirm that the signer can later unlock: that the passes for its own seat and hosted bots are reproducible from its local deck secret source.
  - Impact is liveness only.
  - Adding these checks keeps consent from being given to a game the signer cannot complete.

- **L3. `checkLocalKey` under-validates the local deck transcript.** In verified sessions it does not require `deckSetupPasses` to be complete. It also does not parse items with `passEvidenceSchema`: an item with an extra field passes, then yields a self-invalid `deck-pass` proposal.
  - Impact is liveness only.
  - Fix: require exactly one pass per committed hash, and parse items strictly.

- **L4. `validateDeckCeremony` hashes and applies separate reads of the raw pass.** It reads the caller-supplied `pass` twice: once for `hashPass` and once inside `applyDeckPass`, with nothing detached below the top-level array. This is only exploitable if the caller passes non-plain objects, such as accessors.
  - Fix: `parseCanonical` once, then hash and apply the copy.
  - `applyDeckSetupEntry` already does this correctly.

- **L5. The size margin ignores nested evidence.** `MAX_MESSAGE_BYTES - 4096` covers a proposal or commit with 6 votes. It does not cover `proposal-equivocation` evidence, which embeds two proposals, one of which could be a near-limit deck-pass entry. Such evidence may be unencodable.
  - Separately, `sendCertifiedBatch` returns success silently when a single entry does not fit.
  - Whether this is reachable depends on the actual shuffle-proof size for 25 cards and 6 seats. Bound it explicitly.

- **L6. Expensive verification runs before the proposal signature check.** `validateProposal` runs `validateEntry`, which includes deck-proof verification, before verifying the proposal signature. The entry signature is checked first, so only replayed signed entries can trigger this.
  - Fix: verify the proposal signature first.

---

## Checked and found sound

- **Genesis binding:** the catalogue, full roster (bots included), seat order, base-version gate, exact deck set and full counts are all bound at genesis. A permissive `verifyCommitments` cannot bypass `validateDeckGenesisCommitments` or the engine-deck crosscheck.
- **Proof verification before play:** proofs are verified before consent (`validateDeckCeremony`) and replayed through certified `deck-pass` entries before any non-control entry (`decksReady` gate). The commitment hash is checked before the costly proof.
- **Handled `CARD_DEALT` path:** the input and evidence are strict schemas, so a `card` field cannot leak even though the `Object.hasOwn` guard is skipped for handled inputs.
- **Deals:** they bind to the frozen request, cursor, anchor and `deal.seq > anchor.seq`, and consume the active draw exactly once.
- **Reveals:**
  - Owner, deck and public-slot checks are sound.
  - Reveals are ordered to match the command.
  - The DLEQ context binds draw op id, identity, genesis, epoch, head, seat, nonce and the entire command.
  - Kind checks happen after the signature, nonce and parent checks.
- **Controls** interleave at any time without touching crypto state or recapturing anchors.
- **Beacon ordering:** the beacon is frozen at genesis but inert until decks are ready, and no beacon input is accepted during setup.
- **Rejection paths:** they return new values and leave `context.crypto` unchanged.
