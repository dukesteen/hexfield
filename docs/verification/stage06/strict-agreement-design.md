# Strict agreement design

Status: reviewed design, implementation in progress. The user chose to pause when safe agreement is unavailable. This document defines the Stage 06 ordering contract. Review findings and resolutions are recorded in `docs/DECISIONS.md`; passing design review does not imply implementation acceptance.

## Fault model and availability

Ordering tolerates one Byzantine human voter in games with two through six human voters. A sole human hosting bots is a single-authority game. Bots never add votes. The hidden-information privacy threshold is a separate guarantee, specified in Stage 07; it does not increase the ordering fault threshold.

For `n` human voters use `q = floor((n + 1) / 2) + 1`, with `q = 1` when `n = 1`. The quorum sizes for one through six humans are 1, 2, 3, 3, 4, 4. Two quorums intersect in more than one voter. With at most one Byzantine voter, the intersection includes an honest voter. This is necessary but not sufficient: the voting and locking rules below must also hold.

Agreement holds during arbitrary delay or partitions. Progress requires enough cooperating voters, eventual timely delivery, a valid available input and a participating proposer. Two- and three-human games can be stalled by one unavailable or uncooperative voter. Four and five humans tolerate one unavailable voter; six tolerate two unavailable voters, with at most one Byzantine voter. Neither connection status nor a local timeout lowers the quorum. More than one Byzantine voter is outside the ordering guarantee.

## Agreed value and signatures

- `GenesisBody` excludes the derived `gameId` and signatures. It includes the protocol/engine versions, complete game config, ordered seats and bot hosts, board seed, a fresh 32-byte ceremony nonce, security mode, cryptographic commitments and creation timestamp. `genesisDigest` is the full SHA-256 digest of the domain-tagged canonical body. `gameId` is its 22-character routing alias. Every human signs the full digest.
- A command signs the full genesis digest, seat, strictly increasing nonce, exact parent sequence and value hash, command and optional proof. A stale command is rejected. Retransmission reuses its signed bytes. A new signature for a new parent requires fresh validation of the user's intent; an expired intent is not silently executed in a later phase.
- The agreed entry value is `{seq, prevHash, payload, stateHash}`. Its hash excludes proposer, round and outer signatures, so the same value can be reproposed in another round. Genesis payload hashing uses its full body digest, excluding consent-signature encodings. Signed commands and proofs remain part of all other payload hashes.
- A proposal signs the entry, height, round, full genesis digest, membership epoch and any prior-round justification. The entry also carries the current proposer's signature. All vote signatures bind the full genesis digest, membership epoch, height, round, vote phase, voter and value hash or explicit nil. A logical committed log consists of values; envelope signatures and certificate rounds may differ between peers without changing those values. Reproposing creates a new signed envelope around the same value. Equivocation compares value hashes, not alternative valid proof encodings.
- `stateHash` covers the public engine state. The full log also determines command nonces, membership, exclusions and cryptographic state. Snapshots include all of those fields, and their metadata is checked by replay against the certified log. An engine-only snapshot is never enough to resume voting.

## Consensus rules

Use the proposal, prevote, precommit and locking rules from [Tendermint Algorithm 1](https://arxiv.org/pdf/1807.04938), with equal voter weights and the quorum above. The published algorithm's usual fault bound supplies progress with a noncooperating voter only for populations above three. Our smaller populations retain agreement and deliberately give up that progress guarantee.

The implementation uses sequence as height and positive integer `term` as the round within that height. It starts at round 1 for each new height. The proposer is deterministic from the agreed eligible seat order and `(height - 1 + round - 1) mod count`; local reachability never selects the proposer. Start increasing proposal timeouts when an applicable input is available, including at the proposer, and reset timeout growth at each height. Idle game state awaiting a human choice does not start repeated empty rounds.

Each voter persists at most one proposal, prevote and precommit for each height and round. Persist the highest entered round before signing; never return to a lower round, including after restart. Lock and valid-value rounds never decrease within a height. A non-nil precommit requires a validated value and a matching quorum of prevotes. Before signing it, persist the lock and supporting proof. Nil votes and timeouts preserve the lock. A proposal that would conflict with a lock needs the prior-round prevote justification required by the algorithm. Keep the latest validated quorum-backed value available for reproposal.

A matching quorum of signed non-nil precommits certifies commitment. Validate the value even when its certificate arrives first, and fetch any missing parent or proposal before applying it. A certificate for an older round can still commit at the current height. An authenticated higher-round hint from two distinct voters can advance the round; one Byzantine voter cannot force jumps alone. Replayed votes are idempotent. Conflicting votes from the same voter are retained as evidence and counted at most once in each value tally. Enter the next height only after persisting the current value and certificate.

Separate deterministic validity from local timing checks. A local deadline can cause a nil prevote for a fresh proposal; it does not invalidate a value already justified by a prevote quorum or committed by a certificate. If a certified value fails deterministic validation, suspend voting and replay from genesis. If fresh replay still fails, remain halted with a diagnostic. Never continue voting against, or skip over, a verified conflicting certificate. Two conflicting commit certificates or proven equivocation by two distinct voters halt the game because the fault assumption has failed.

The UI and private-state driver advance only on committed entries. A selection preview can remain local, but uncommitted engine results do not spend cards, reveal secrets or resolve submission promises. This removes the need to roll back visible game state after a round change.

## Crash and storage requirements

The Stage 06 store is an injected memory implementation whose lifetime outlives a protocol instance. Stage 10 provides its IndexedDB implementation. Store the committed prefix and certificates, current height/round/step, signed votes, proposal, lock, latest justified value, nonce counters, and issued private contributions before sending messages that rely on them. Apply each transition atomically. A failed write stops voting and reports a recoverable storage failure.

Serialize transitions so a message arriving during an asynchronous write cannot cause a second conflicting vote. A crash after persistence and before transmission can retransmit the stored signature. A crash before persistence cannot have transmitted that vote. A restarted process restores these records before joining consensus. Tests must crash at both boundaries.

Use a per-game voting/command key, bound to the device identity during genesis, and store it atomically with the game's safety records. It is independent of escrowed game secrets. Losing that store makes the seat unable to vote; it cannot infer a safe signing point from other peers' committed heads. The device identity alone cannot recreate the voting key. Recovery requires a certified key replacement or bot takeover under the still-active voter set. Without a quorum, play stays paused.

Export/import preserves safety records but does not authorize an imported old key to vote. Move an active seat through a certified replacement to the destination's fresh game key, with readiness signed by that new key. Retire the source key before activating the destination. A stale save can supply history and private data after validation, but cannot reactivate a retired epoch/key. Browser tabs use one exclusive writer per identity/game. Malicious concurrent key copies count as the faulty voter; the UI must not create them through an ordinary transfer.

## Fault evidence and repair

An accusation includes the signed offending object plus enough committed parent and round context to verify it. Invalid command signatures, invalid engine transitions and equivocation are objective evidence once that context is established. Missing parents, stale entries, local deadline expiry and a lone state-hash disagreement are not proof of malicious behaviour.

Evidence is gossiped. Valid evidence allows voting nil and rotating away from the offending proposer. Permanent proposer exclusion must itself be committed as a protocol-control entry; it does not remove the accused human's voting weight. Removing a voter is a separate Stage 10 membership transition. Censorship uses retransmitted broadcast commands and a timeout to change rounds, without labelling an unresponsive peer a proven cheater.

A peer with corrupt derived state stops voting while it replays its certified prefix in a fresh engine instance. If repair succeeds it resumes with its persisted lock and vote records intact. If it cannot reconstruct a valid prefix, it remains halted and exposes a diagnostic. A network snapshot is accepted only after its parent chain, commit certificate and full derived metadata are verified; a peer's assertion that a snapshot is the majority state is insufficient. Snapshot metadata requires replay in this design; it is not an independent shortcut for resuming votes.

## Membership and escrow

Membership stays fixed during each consensus height. A membership entry is committed by the old voter set and takes effect only at the next height. Increment the integer membership epoch on each such transition. Votes bind that epoch and the value hash, which includes the unique certified parent. A joining or replacement key signs readiness over the full genesis digest, parent hash, next epoch and proposed member list, excluding readiness signatures to avoid a recursive digest. It starts fresh voting records only after verifying the membership commit. Command authorization uses the current certified seat key, not the original genesis key. Control entries remain available while gameplay waits for a missing reveal or human input.

Consequently, a four-human game can replace one offline human when its other three consent and satisfy the escrow requirements. It then has three voters and requires all three. Three-human games cannot remove an offline human, and two-human games cannot continue alone. Recovering a secret is not permission to bypass consensus.

Recovery takes two committed entries. First, the old set certifies removal, freezes the departed seat and its hosted bots, and names the recovery host and new bot keys. Only then may honest holders release escrow shares. This is irreversible for privacy. Second, the remaining set certifies the verified recovery result before accepting bot commands, or records a void result if recovered secrets do not match their commitments. A withholding share holder can stall recovery; it cannot manufacture valid secrets or restore privacy.

Games starting with two or three humans do not distribute escrow, because strict quorum requirements prevent absent-seat takeover and two-human escrow would reveal a hand to its opponent immediately. Games starting with at least four humans distribute the Stage 07 threshold shares. Their sealed ciphertexts remain in genesis so a departed holder's recovered encryption key can recover its shares for later takeovers. Recovery still requires every original other holder's share or authorized recovered equivalent, even when the consensus quorum is smaller. Disclose that recoverers can see the bot's hand and that exposing departed keys weakens remaining privacy thresholds. Returning a seat does not restore its secrecy.

## Required adversarial checks

In addition to the nine full-game chaos scenarios, add deterministic traces for:

- A three-voter split with one voter signing conflicting proposals/votes. Neither pair commits.
- A four-voter hidden precommit certificate, followed by a new proposer and a conflicting value. The old value is preserved across all round changes and crashes.
- Reordered nil and non-nil votes, duplicate signers, conflicting votes, cross-game/epoch/height replay and forged prior-round justification.
- Crash immediately before and after vote/lock persistence, including two simultaneous restarts.
- A lost safety store, cloned-identity writer contention, failed storage transaction and imported stale save.
- Conflicting membership changes, an insufficient old quorum, missing escrow authorization, a withholding holder, a second takeover and return after takeover.
- A certified value rejected by corrupt local state, lower-round replay after restart and reactivation of a retired key from an old save.
- Local state corruption without accusing an honest proposer, and rejection of a snapshot with correct engine state but false nonce or voter metadata.

No implementation or acceptance status is implied by this design. The stage remains incomplete until its code, review and required gates pass.
