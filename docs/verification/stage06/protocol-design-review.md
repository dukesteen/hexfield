# Stage 06 protocol design review

This review covers `docs/00-architecture.md`, `docs/06-protocol-event-log.md` and `docs/10-persistence-reconnection.md` (with small parts of 07 and 09). The current design has several real contradictions. I list them first, then answer your six questions, then give a checklist and the decisions only you can make.

## Contradictions not covered by your questions

- **C1. 2‑player takeover can never commit.** `10:88` says a change to the voter set needs a majority of the _old_ set. In a 2‑player game the old set is {A,B}, so the change needs B's ACK, and B is the seat that left. `10:73` promises the opposite. Real Raft commits a single‑server change under the _new_ configuration, which takes effect as soon as the entry is appended. Removing one voter always leaves the old and new quorums overlapping (2→1, 3→2, 4→3, 5→4, 6→5 all check out). **Fix:** use Raft's single‑server rule. Allow one change at a time. A new leader must commit a no‑op in its own term before it proposes a config change (Ongaro's 2015 fix).
- **C2. Scenario 9 conflicts with "no committed entry is ever rolled back".** In `06:159`, two peers are wiped and rebuilt from the others. Example with 4 peers:
  1. E is ACKed by {A,B,C}.
  2. B and C are wiped.
  3. {B,C,D} elect a leader with no copy of E, and E is overwritten.

  No voting rule can prevent this when voters forget what they signed. Stage 06 needs a durable store per peer in memnet; stage 10's IndexedDB comes later.

- **C3. The term‑1 sequencer is not deterministic.** `06:109` picks the "lowest eligible seat at game start", and eligibility depends on each peer's local view of who is online. **Fix:** term 1 = the lowest human seat in genesis. If that seat is offline, move to term 2 through a normal election.
- **C4. Peers can nominate someone else as candidate.** `06:111` has a peer bump the term and name another seat, but that nominee never signs the request or collects the votes. **Fix:** a seat can only stand for itself. Keep "lowest seat first" as a liveness preference by giving lower seats shorter timeouts, not as part of safety.
- **C5. Validation needs state outside `stateHash`.** Entry validation (`06:54`) depends on "the peer's current term", which breaks when a peer syncs or replays older terms. Snapshots are checked only against `stateHash` of _public_ state, but validation also needs `lastNonce[seat]`, the voter set, the accused set and the term. Either put these into the hashed state or add a `protocolStateHash` to every entry.
- **C6. Nonce ordering lets a sequencer drop commands.** The rule is `nonce > lastNonce`. If a seat submits nonces 5 and 6, the sequencer can include 6 first, and 5 then looks invalid rather than censored. The sequencer must sequence each seat's commands in nonce order. Treat a skipped lower nonce as a censorship suspicion.
- **C7. Commands can be replayed out of context.** A command from a discarded branch, or one the sequencer held back, can be sequenced much later, and `headSeq` is only advisory. That needs a decision (D5 below).

## Q1. Non‑recursive `gameId` and validating seq 0

- **Hash body.** `GenesisBody` is everything in the genesis except `gameId` and `signatures`. That matches the draft in `09:76`. It must also include the randomness mode (see Q6) and a lobby/ceremony nonce, so that two fixed‑seed games with the same seats cannot collide.
- **Digest and id.**
  - `genesisDigest = sha256(canonicalEncode(GenesisBody))`, computed under the domain prefix `"cp2p/v1/genesis-body\0"`.
  - `gameId = base64url(genesisDigest)[0..22]`, which is 132 bits.
  - Use `gameId` only for routing and display. Every signature binds the full 32‑byte `genesisDigest`.
- **Signature scope.** Each human seat signs `{ genesisDigest }` with purpose `"genesis"`. Store `signatures` as a list sorted by seat, outside the body.
- **Seq‑0 entry.** Seq 0 is canonical and has no sequencer: `term: 0`, `prevHash: 0³²`, no `sequencer`, no `sig`.
  - Its hash body is `{ seq: 0, term: 0, prevHash, genesisDigest, stateHash }`. It must **exclude** the signatures.
  - Reason: a signer using a randomized nonce can produce several valid signatures for the same body. That would give different seq‑0 hashes, and therefore different `prevHash` values at seq 1.
- **Seq‑0 validation.** Reject the entry unless all of these hold:
  - Decoding is strictly canonical (decode then re‑encode gives the same bytes).
  - Protocol and engine versions are supported.
  - The digest recomputes, `gameId` equals the truncated digest, and it matches the game the peer joined or stored.
  - Seat numbers are unique. Human public keys are unique and distinct from bot keys, so one device cannot hold two votes. Public keys are canonical and not small‑order.
  - There is exactly one valid strict‑Ed25519 signature per human seat and no extras.
  - The randomness mode is allowed by local policy.
  - `stateHash` equals the hash of `genesisState(body)`.

## Q2. Signed statements and transferable certificates

Every statement is signed by the seat's genesis key, uses its own domain prefix, and includes `genesisDigest`.

- **ACK:** `{ term, seq, entryHash, stateHash (+protocolStateHash), seat }`. Because entries are hash‑chained, one ACK covers the whole prefix.
- **QC (quorum certificate):** `{ term, seq, entryHash, stateHash, acks[] }`. The ACKs must come from distinct seats that form a quorum of the voter set in force at that seq, and `entry.term` must equal the ACK term (see Q3). The sequencer counts as a voter by emitting its own ACK.
- **COMMIT:** carries a QC. An unsigned COMMIT is only a hint and is never trusted.
- **VOTE:** `{ term, candidate, voterLastLog: { term, seq, hash }, granted }`. VOTE_REQ carries the candidate's last log position, not `committedSeq`.
- **Election certificate:** a quorum of granted VOTEs for one (term, candidate). The first entry of every term above 1 is a `term-start` no‑op that carries this certificate. That makes "who was sequencer in term t" provable during sync, and it is the no‑op Raft uses to commit earlier entries.
- **HEARTBEAT:** signed and bound to the term, so it can be relayed safely (stage 10 adds mesh relay).
- **Sync:** SYNC_RES returns the entries, the election certificate for every term in the range, and the highest QC. Entries up to the QC's seq count as committed; entries after it are tentative.
- **Snapshots:** SNAPSHOT_RES must be anchored in a QC whose `stateHash`/`protocolStateHash` matches the snapshot. Otherwise the sender can inject its own nonces or voter set.

## Q3. Keeping commits across term changes and restarts

**Counterexample for the current rule.** Voters A, B, C.

1. Term 1, sequencer A. E5 reaches only B. A holds ACK_A and ACK_B, so A has a QC and shows E5 as committed.
2. B never receives ACK_A, so B still believes its committed seq is 4.
3. A crashes. C times out and asks for votes with `committedSeq=4`.
4. Under `06:112`, B grants: 4 ≥ 4.
5. C appends E5′. B rolls back E5, which A had already committed.

**Rules that fix it (Raft):**

1. **Voting:** grant only if the candidate's `(lastLog.term, lastLog.seq)` is at least your own last log position, and that position includes uncommitted entries you ACKed. Any ACK quorum overlaps any vote quorum, so at least one voter holding E5 refuses a candidate that lacks it.
2. **Commit counting:** count QCs only for entries from the current term. Earlier‑term entries commit through the `term-start` no‑op (Raft §5.4.2, Figure 8).
3. **Truncation:** a follower truncates only when a validated entry from a higher term conflicts at that seq and `prevHash` matches. It never truncates at or below a QC it knows; doing so is a bug or evidence of misbehaviour.
4. **Remove "ensures it has the longest committed prefix"** from `06:113`. Rule 1 already guarantees the winner has it.
5. **Persistence:** save `currentTerm`, `votedFor` (the signed VOTE) and the log **before** sending any VOTE or ACK. `10:35` covers ACKs only. After a restart, never sign a conflicting VOTE or ACK for a term at or below the persisted one.
6. **Quorum size:** quorum = majority of the _current voter set_ derived from the log. "Online" affects candidacy only, never quorum size.

## Q4. Byzantine faults: the safety claim has to be restricted

A quorum of size q out of n voters stays safe against f equivocators only if two quorums always share at least f+1 seats, i.e. 2q − n ≥ f+1. For f = 1:

| Human voters | Majority quorum | Safe for f=1? | Quorum needed for f=1 |
| ------------ | --------------- | ------------- | --------------------- |
| 2            | 2               | Yes           | 2                     |
| 3            | 2               | **No**        | 3 (unanimous)         |
| 4            | 3               | Yes           | 3                     |
| 5            | 3               | **No**        | 4                     |
| 6            | 4               | Yes           | 4                     |

Quorum size alone is not enough, though. Raft‑style voting trusts voters to report their logs honestly.

**Counterexample for 3 voters, with B malicious:**

1. Term 1: E5 reaches only B. B ACKs, so A holds a QC and commits E5.
2. A goes offline.
3. B votes for C in term 2 and claims its last log is (t1, 4).
4. C appends E5′ at seq 5 with different dice. B ACKs, so C commits E5′.

A and C now hold conflicting commits. Even the safe sizes (n = 4 or 6) would need a real two‑phase BFT protocol with locking (PBFT or Tendermint style), not Raft‑lite.

**Guarantees that are incompatible with arbitrary Byzantine safety:**

- 3‑human games continuing with 2 players.
- 5‑human games continuing with 3 players.
- Takeover shrinking the voter set to 3 or fewer (in a 2‑player game it shrinks to 1).
- Reconfiguration and snapshot trust based on a simple majority.
- The claim "no committed entry is ever rolled back" once a voter is malicious.

The 4‑peer chaos scenarios 4 and 5 would still work with a quorum of 3.

**Smallest sound option (my recommendation):** state the guarantees in three tiers.

- **Ordering safety** is crash/omission‑fault only, and assumes durable storage.
- **Validity holds under any faults.** An honest peer never applies or ACKs an invalid entry. Scenarios 6 and 7 need only this plus re‑election.
- **Accountability:** because ACKs and VOTEs are signed and VOTEs include `voterLastLog`, conflicting commits should always leave a signed contradiction in the transcripts (for example B's ACK(t1,5) next to B's VOTE(t2, lastLog=(t1,4))). Across several terms, finding it means walking back through the election certificates term by term. That proof chain still needs to be proven or property‑tested; I haven't proven it. Response: halt or void the game with the proof.

Update `00:59-61` and the `00` §6 table to say this explicitly.

## Q5. When an accusation counts as evidence

**Admissible evidence** must let any third party verify it deterministically:

- **Anchor:** a QC‑covered entry (or genesis).
- **Election certificate** for term t showing the accused seat S was the sequencer.
- **Chain:** every entry from the anchor to the bad entry E, all signed by S in term t, with valid `prevHash` links.
- **Proof of invalidity** when E is replayed from the anchor. It must be a deterministic failure: a bad command signature, a wrong gameId, a non‑increasing nonce, an engine `validate` error, or bad system evidence (stage 07).
- **Equivocation:** two different entries signed by S at the same (term, seq), or conflicting ACKs/VOTEs from one seat in one term. These are admissible on their own.

The resulting exclusion must itself be a log entry, so every peer agrees on the accused set.

**Not proof of cheating** (the entry is dropped or parked, and at most you sync or start an election):

- A missing parent or ancestor: sync instead.
- A stale term (below yours), or a higher term you have no certificate for yet.
- A TIMEOUT that looks early on your clock. Clocks are not shared, so the `{pendingSince, deadlineMs}` evidence in `09:91` cannot be judged objectively. Delay your ACK until your own deadline minus a tolerance instead of rejecting.
- Censorship suspicion (`06:115`). Only skip that sequencer for one term; the "rest of the game" exclusion does not apply.
- A command that became invalid before it was sequenced.
- A lone `stateHash` mismatch. Treat it as a desync or local bug unless signed ACKs corroborate the accuser's value.

The current `ACCUSE { evidence: LogEntry | SignedConflict }` (`06:83`) is not enough: it also needs the anchor, the chain and the election certificate.

## Q6. Binding stub mode to genesis

- Put `randomnessMode: 'stub-v0' | 'crypto-v1'` in `GenesisBody`. It is then hashed into `gameId` and signed by every human.
- Validators accept `StubEvidence` only when the mode is `stub-v0`, and real evidence only when it is `crypto-v1`. The mode is never negotiated per entry.
- All signatures bind `genesisDigest`, so stub transcripts cannot be replayed into a secure game.
- Make stub evidence checkable: derive values from `H(genesisSeed ‖ seq ‖ label)`. They are predictable, but every peer can verify them, so scenario 6 can also test a sequencer lying about dice.
- **Enforcing stub‑free secure play:**
  - The stage‑09 lobby never emits `stub-v0` in production builds.
  - The P2P validator rejects a stub genesis unless a dev/test flag is set.
  - Stub games show an "insecure simulation" banner, and production refuses to resume or import them.
  - Add a test that the production validator rejects a stub genesis. Run the stage‑07 chaos rerun in both modes.

## Implementation checklist

**Safe to start now:**

1. Strict canonical encode/decode.
2. Strict Ed25519 with canonical PeerId checks.
3. Domain‑separated `signObject` with a closed list of purposes: genesis, cmd, entry, ack, vote, vote‑req, heartbeat, accuse, contrib, private, chat.
4. `GenesisBody`, `genesisDigest` and `gameId`, plus seq‑0 construction and validation (Q1).
5. Signed ACK/VOTE types, and QC / election‑certificate verification (distinct seats, voter set taken from the log).
6. Memnet with a durable store per peer, where a crash wipes only volatile state.

**After the decisions below:** 7. Log‑up‑to‑date voting, the current‑term QC rule and `term-start` entries. 8. Raft single‑server reconfiguration (C1). 9. Nonce ordering (C6), the admissible‑evidence format and the accusation log entry. 10. Hashed protocol state for snapshots (C5). 11. Rewrite the security claims in `00` and `06` to the three tiers.

## Decisions I need from you

1. **Fault model.** Crash‑fault ordering plus validity plus accountable detection (recommended), or a real BFT protocol? BFT means 3‑ and 5‑player games stall when one player is absent, and takeover stops at 4 voters.
2. **What happens after a proven fork:** void the game, or exclude the equivocator and continue from the last point every honest peer agrees on? Continuing is only sound if no conflicting commit reached an honest peer.
3. **Scenario 9:** redefine it as "volatile state wiped, durable store kept"? If a device genuinely loses its storage, it has also lost its identity key, so it would count as a departure handled by takeover.
4. **Stub mode:** dev/test only, or also a user‑visible "insecure casual" option?
5. **Command freshness (C7):** bind each command to a turn or phase id, or a maximum `headSeq` distance? This stops delayed or replayed commands from executing in a different context.
