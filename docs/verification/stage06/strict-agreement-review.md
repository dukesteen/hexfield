I found no flaw in the core adaptation. The quorum sizes are right, and so is hashing the agreed value without its round or proposer. But the design is not ready to implement yet. Four rules can break safety as written: the lost-store recovery rule, the missing round-monotonicity rule, what to do when a certified value fails local checks, and the joint old/new membership rule. Two-human escrow and takeover also leak hidden cards.

## What holds up

- **Quorum overlap.** For n = 2..6, q = 2, 3, 3, 4, 4, so two quorums always share 2, 3, 2, 3, 2 voters. With one Byzantine voter, every overlap contains an honest voter. That is enough for Tendermint's locking argument.
- **Liveness claims.** Progress needs q honest, cooperating voters, so the game can absorb 0, 0, 1, 1 and 2 non-cooperating voters for n = 2..6. The doc's statements about 2, 3 and 4 humans are correct. Add that 5 humans need 4 cooperating and 6 humans tolerate two non-cooperating voters (at most one Byzantine).
- **Value hashing.** `entryHash` (`packages/protocol/src/genesis.ts:141`) already leaves out the round/term and proposer, and genesis hashes its body digest. That matches line 17 of the design.
- **Evidence vs desync.** Separating objective evidence from local desync, and the rule that a snapshot alone never lets a peer resume voting, are both right.

## Safety: required corrections

**S1. Rounds must never go backwards (missing rule).** Line 27 limits a voter to one vote per phase per round. It does not stop a restarted voter from signing in a round lower than one it already reached. Tendermint's proof relies on each honest voter's rounds only increasing. Suppose a voter locks at round 5, restarts, and resumes at round 3. Seeing enough prevotes at round 3 would make it precommit and replace its lock with an older one. Add these rules:

- Persist the highest round entered at each height before signing anything in it. Never sign at a round below it.
- `lockedRound` and `validRound` never decrease.
- Enter height h+1 only after persisting the value and certificate for height h.

**S2. The lost-store rule (line 39) cannot be computed, and it deadlocks when q = n.**

- A voter that lost its store cannot tell which height it last voted at. The certificate for height h may have existed only on its own lost device, for example if the Byzantine voter sent its precommit only to that voter. It may therefore already have voted at h+1 while every other peer is still at h.
- "Wait for a certificate beyond it" cannot happen for n = 2 or 3, where q = n, because no certificate can form without that voter.
- A lost store also means the `masterSecret` is lost, so the seat cannot make hidden-information moves anyway.

Correction:

- Generate a per-game voting key at lobby time and bind it in genesis, separate from the device identity. Store it in the same atomic record as that game's safety records. Deleting or losing the game then destroys the key.
- Treat store loss as the seat departing. It recovers only by a replacement identity (n ≥ 4) or takeover.
- Delete the "catch up as a nonvoter and resume" path.
- Make export a transfer: it retires the local key in the same transaction that produces the export file.
- Stale-save import and cloned-identity tests then check that the retired key never signs again.
- The code already follows the prerequisite: `identity.ts` does not derive the device key from escrowed material. Keep it that way.

**S3. What to do when a certified value fails local checks.** Line 29 validates certified values but never says what happens on failure. At least q−1 honest voters accepted that value, so the local peer is faulty. If it kept voting, it would be a second fault. Correction:

- Replay the certified prefix from scratch.
- If the value is still invalid, stop voting permanently and export a diagnostic.
- Never vote against a certificate and never skip past it.

**S4. Objective and subjective validity must be separated.** Some checks depend on the local clock or local policy: turn timeouts, the takeover delay, "seat offline long enough". Correction:

- Such checks may only turn a prevote for a fresh proposal (`validRound = -1`) into nil.
- Prevotes for a proposal backed by a prior-round prevote quorum, and acceptance of certificates, use only deterministic validity computed from the certified parent.
- Otherwise a locked honest voter can refuse a legitimately locked value. Without this, a value can be certified that some honest peers consider invalid.

**S5. Breaking the fault assumption must halt the game.** Add these rules:

- If a peer sees two certificates for different values at the same height, or equivocation evidence against two different voters, it halts permanently and shows the evidence.
- A syncing peer never adopts a certificate that conflicts with a commit it has persisted.
- Also clarify line 29: within one tally, count each voter once. An equivocating voter may appear in the tallies for two different values; the one-fault analysis already allows for that.

**S6. Where evidence is checked and when desynced peers stop.**

- Check evidence by replaying from a certified anchor in a fresh engine instance. Line 43 conflates two things: a state-hash mismatch checked against the certified parent is objective evidence, but a mismatch against your own cached state is not.
- A peer with an unresolved desync must stop voting entirely, not just stop proposing. If it could vote, its corrupted state plus the Byzantine voter would make two faults.

## Membership handoff: not precise enough, and the joint rule should go

The requirement at line 51 for certificates from both the old and new voter sets is unnecessary here.

- Consensus decides each height independently, and a committed height is final.
- If height h is decided by the old set alone and the change takes effect at h+1, every honest peer derives the same set for h+1 from the same certified prefix. CometBFT handles validator-set changes this way.
- For removals, the new set is a subset of the old one, so its quorum adds nothing.
- For additions, it is circular. The returning human would have to vote at h under an epoch that exists only once h commits.
- "Which epoch do new voters sign at h?" has no well-defined answer.

Exact rule:

1. **Epoch id.** `epoch(h+1) = H(epoch(h), membershipEntryHash)` if height h is a membership entry, otherwise `epoch(h)`. Every proposal and vote binds `(genesisDigest, epoch, height, round)`. Line 18 currently leaves the epoch out of proposals.
2. **Decision.** A membership entry at height h is decided like any other entry: old set, old quorum. Membership is fixed within a height.
3. **Effect.** The new set, its size n, its quorum q and the proposer order apply from h+1. Late votes that bind the old epoch at h+1 are invalid by construction.
4. **Additions and returns.** The payload carries a readiness statement signed by the joining key. It binds `genesisDigest`, the parent value hash at h, and the new epoch id. This is the precise meaning of "adopting identical prefix and safety context". The joining voter starts fresh safety records for the new epoch. Its old votes all bind old epochs, so they cannot conflict.
5. **Consent.** A voter's prevote and precommit are its consent. No separate signatures are needed.
6. **Control entries.** Membership and control entries must be valid whatever the game is waiting for. Otherwise a missing beacon reveal from the departed seat blocks the entry that would unblock it.
7. **Seat-to-key mapping.** The key allowed to sign a seat's commands comes from the current membership state, not from genesis.

Also document that a takeover in a 4-human game leaves 3 voters with q = 3. The game then has 3-human liveness: any one voter can stall it, and no further takeover is possible.

## Escrow: yes, it needs a separate old-configuration entry

It takes two entries. The recovered secret is an input to the second one, so they cannot be merged.

- **Entry (a), recovery authorization, in the old epoch.** It removes X as a voter from h+1 and freezes X's seat, so X's key is no longer accepted for commands. It covers bots hosted by X as well. It also names the bot host deterministically and records the new bot's takeover key. Shares are released only to peers holding the certificate for (a). Treat (a) as irreversible for privacy: once any share has gone out, "cancel" cannot restore secrecy.
- **Entry (b), recovery result, in the new epoch.** It records an objective result: either "the recovered secret matches the public beacon tip, lock keys and encryption key", or "void", with the evidence. Voters that lack the shares vote nil, which affects liveness only. The bot's commands are accepted only after (b).

## Circular dependencies

- The joint new-set certificate for additions (fixed above).
- Lost-store recovery when q = n (fixed in S2).
- Takeover for n = 2 and 3: entry (a) needs X's own vote. The doc acknowledges this.
- **A second takeover in 5- or 6-human games.** Escrow shares that X held for other seats were sealed to X and sent privately, and they are not in the log. After X leaves, the next seat's secret can never reach its threshold of all other humans. Correction: put the sealed share ciphertexts in the genesis body. X's recovered encryption key then opens X's shares for everyone.
- **Escrow is stricter than the quorum.** In a 6-human game, q = 4 of the remaining 5, but escrow needs all 5 shares. The Byzantine voter can therefore block takeover even when it cannot block consensus. This is liveness only; document it.

## Privacy loss

- **2- and 3-human games: turn escrow off.**
  - With 2 humans, t = 1, so the opponent's share is the secret itself from genesis. A modified client sees your whole hand from the first move.
  - Under strict agreement, takeover is impossible for 2 or 3 humans, so escrow there only adds exposure.
  - Enable escrow only when the game starts with 4 or more humans. Update the 2-player disclosures in docs 07 and 10.
- **Share withholding.** After (a) commits, honest voters release their shares, and a Byzantine voter can keep its own. It then alone learns X's secret while recovery stalls. This can't be fully prevented. Mitigations: send shares only to the designated host, or accept the risk and disclose it.
- **Other seats' secrecy weakens.** Recovering X's encryption key opens everything ever sealed to X. X's deck-lock keys also become known to all remaining humans. So for every other seat, the group that must collude shrinks from "all others" to "all remaining others". For example, after one takeover in a 4-human game, two players colluding can read the third's hand. Disclose this in 07 §7.
- **Returning after takeover does not restore privacy.** The returning human's commitment blindings and deck keys stay known to the others. Short of re-keying (out of scope), keep the note from doc 10 §3.4.
- **The bot's hand is visible to every recoverer, not just its host.** Doc 07 §9 needs a takeover caveat.

## Liveness: required corrections or documentation

- **L1. Idle rounds.** Line 25 makes every round time out and escalate even while a player is simply thinking. Rounds would climb without limit during idle play, and timeouts would grow with them. Correction: a voter starts the propose timer only once it knows an applicable input, or once a certified deadline has passed by its own clock. Reset timeout growth at each new height.
- **L2. Skipping to a higher round.** "Two distinct voters" cannot be met by others alone when n = 2. Jumping to a higher round is always safe, so use a threshold of `min(2, n−1)` other voters.
- **L3. Commands bound to the exact parent.** Every commit makes all other seats' signed commands stale. In phases where several seats act at once (discards, trade responses, reveals), this causes repeated re-signing. Define which intents may be re-signed automatically against a new parent, or bind commands to a phase id. Safety is unaffected either way.

## Precision and implementability

- **Proposer signature in the entry (line 18).** A signature inside the entry contradicts reproposal by a later proposer. Fix:
  - The committed record is `{value, commitCertificate}` and carries no proposer signature.
  - A proposal is a separate signed object: `{genesisDigest, epoch, height, round, valueHash, validRound}`.
  - The prevote justification for `validRound` is attached unsigned; it verifies itself.
  - Equivocation means two proposals at the same (epoch, height, round) with different value hashes. Re-attaching a different set of prevotes is not equivocation.
- **Proposer rotation (line 45).** It must never depend on local evidence. Peers would then disagree about who proposes, which blocks progress. Evidence only allows a nil prevote at the current height. Exclusion takes effect through a committed entry, starting at the next height.
- **Proposer crash.** Persist your own signed proposal for each (height, round) before sending it. A proposer that crashes and proposes a different value in the same round becomes the one fault.
- **A hash for protocol state.** Add `protocolStateHash` to the value, covering nonces, membership, epoch, exclusions and cryptographic state. Otherwise the snapshot check at line 47 needs a full replay, and the snapshot fast path is unimplementable.
- **Code to update:**
  - `EntryBody`/`LogEntry` still carry `term`, `sequencer` and `sig` (`types.ts:81-92`).
  - `validateNextEntry` checks term and sequencer (`log.ts:151`).
  - `validateGenesisEntry` requires term 1 and a first-human signature (`genesis.ts:171-184`); genesis should have no proposer.
  - `validateSignedCommand` looks up keys in `genesis.seats` (`log.ts:59`), which breaks for takeover keys.
  - `AckBody` (`types.ts:95`) is obsolete.

## Optional refinements

- A proposer should revalidate its value against a fresh replay from the certified anchor before signing, so a desync doesn't lead it to incriminate itself.
- Command nonces are redundant once commands bind the exact parent. They are harmless.
- A capped timeout is fine in practice. Tendermint's liveness proof assumes timeouts can grow without limit, so note the gap.
- For n = 2 or 3, where store loss or departure ends the game, you could offer a unanimous "continuation" game. It would have a new genesis whose parent is the highest certificate any signer holds. The lost seat's secret would still have to be revealed through escrow, which conflicts with turning escrow off for these games.
- Add tests for:
  - a round regressing after restart (S1);
  - a certificate that exists only on the voter that later loses its store (S2);
  - a certificate that fails validation locally (S3);
  - a Byzantine voter withholding its share after (a);
  - a second takeover in 5- and 6-human games.
