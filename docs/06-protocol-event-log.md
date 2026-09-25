# 06 — Protocol & Replicated Event Log

## Goal

Build `@cp2p/protocol`, which lets N peers keep one agreed, validated, hash-chained log of inputs and therefore identical game state. It must be:

- transport-agnostic,
- tested over an in-memory simulated network with delays, drops, duplicates and partitions.

Randomness and hidden information use a `LocalRandomSource` stub here. Stage 07 replaces it with the real cryptographic protocols. WebRTC comes in stage 08.

Stub evidence binds a system input to its game and parent. It does not prove a hidden resource count, a random result or elapsed time. Deliberately false but publicly plausible system inputs can therefore halt a stub simulation when its private-state driver checks them. The stub is confined to tests and development views. Stage 07 must verify those facts before commitment in real games. A committed value is never rolled back to hide a failed private-state check.

The [strict-agreement design](verification/stage06/strict-agreement-design.md) defines the fault model, vote rules and crash requirements. The user chose agreement over availability: three-human games require all three votes, and a two-human game cannot continue alone after a disconnect. Ordering tolerates at most one Byzantine human voter. For one through six human voters the quorum is 1, 2, 3, 3, 4, 4 respectively. Bots do not vote.

## Prerequisites

Stage 04 (engine + sim) is complete. Stage 05 isn't required.

## 1. Identities & signatures (`@cp2p/crypto`, first part)

- **Identity helpers**: Ed25519 keypairs (`@noble/curves/ed25519`), with `PeerId = base64url(publicKey)`. Device identities authenticate the later lobby connection; they are separate from game signing keys.
- **Seat binding**: genesis maps each seat to a fresh per-game public key. That key signs commands and, for human seats, consensus messages. Stage 09 binds it to the device identity during the ceremony. Stage 10 stores the private game key atomically with its safety records. The Stage 06 caller injects the key and journal together.
- Helpers: `sign(bytes, sk)`, `verify(sig, bytes, pk)`, and `signObject(value, sk)` = sign over `canonicalEncode(value)` with a **domain separation prefix** (`"cp2p/v1/<purpose>\0"`), so a signature for one purpose can't be replayed as another.

## 2. Log entries

```ts
interface SignedCommand {
  body: {
    gameId: string;
    genesisDigest: string;
    seat: Seat;
    nonce: number;
    headSeq: number;
    headHash: string; // exact committed parent
    command: Command;
  };
  sig: string; // Ed25519 by seat's key, purpose "cmd"
}

interface LogEntry {
  seq: number; // 0 = genesis
  term: number; // consensus round within this sequence, starting at 1
  prevHash: string; // hex sha256 of previous entry's hash-body
  payload:
    | { kind: 'genesis'; genesis: Genesis }
    | { kind: 'command'; signed: SignedCommand }
    | { kind: 'system'; input: SystemInput; evidence: SystemEvidence } // evidence proves validity (beacon reveals, deck proofs, timer claims)
    | { kind: 'membership'; change: MembershipChange }; // seat online/offline/bot-takeover (stage 10)
  stateHash: string; // hash of public state AFTER applying this entry (computed by sequencer, verified by all)
  sequencer: PeerId;
  sig: string; // sequencer signature over all fields above, purpose "entry"
}
entryHash(e) = sha256(canonicalEncode({ seq, prevHash, payload, stateHash }));
```

- `GenesisBody` contains `protocolVersion`, `engineVersion`, `config`, ordered seats and bot hosts, `genesisSeed`, a fresh `ceremonyNonce`, `security: 'stub' | 'verified'`, cryptographic commitments and `createdAt`. It excludes `gameId` and signatures.
- `genesisDigest = base64url(hashValue({domain: 'cp2p/v1/genesis-body', body: GenesisBody}))`; `gameId` is its first 22 characters, for routing only. Every human signs the full digest under purpose `genesis`. Keys and seat numbers must be unique; human signatures are stored in seat order.
- Entry zero uses term 1, an all-zero previous hash, the derived genesis state hash and the first human's outer signature. Its value hash normalizes the payload to `{kind: 'genesis', genesisDigest}` so alternate valid consent signatures cannot create different log anchors.
- Entry value hashes exclude outer signatures, round and proposer so a locked value can be reproposed unchanged. Proposal signatures still cover these fields and their prior-round justification.

## 3. Validation of an entry (every peer, every entry)

1. `seq == head.seq + 1` and `prevHash == entryHash(head)`.
2. Verify the proposer for the entry's height and round using the certified membership and exclusion state. Historical sync uses that historical context, not the receiver's latest local round. Verify the proposer signature.
3. Per payload:
   - `command`: verify the seat's signature, full genesis digest and exact parent; require `nonce > lastNonce[seat]`; validate the engine input and any per-move proof. A stale command requires renewed intent validation before signing against another parent.
   - `system`: verify the evidence before engine application. Stub evidence is bound to its input and parent and accepted only with an explicitly opted-in stub genesis. Production refuses stub games. Stage 07 supplies real proofs.
   - `membership`: validate against membership rules (stage 10).
4. Derive the next state without publishing it, check engine invariants and compare its hash with `stateHash`. Preserve nonce and protocol metadata with the derived result. A local mismatch requires replay and diagnosis before accusing another peer.

An objectively invalid signed proposal can supply misbehaviour evidence once its committed parent and proposer context are established. Stale entries, missing parents, clock disagreements and a lone state-hash mismatch are not such evidence. Permanent proposer exclusion must itself be a certified protocol-control entry. It never silently removes the offender's voting weight.

## 4. Messages

All wire messages are validated on receipt with Valibot schemas (`v.safeParse`). Use `v.variant("t", [...])` for the message union and `v.strictObject` so unknown fields are rejected. Oversized (> 256 KB after reassembly), malformed or unknown messages are dropped and counted against the sender's reputation (disconnect after a threshold).

The wire schema validates the surrounding message; the engine validates registered command and system-input keys. Signatures, reveal proofs, and timer evidence stay in their log-entry fields. The P2P adapter must reject a local-mode `CARD_DEALT.card` value and deliver that identity privately instead.

```ts
type Msg =
  | { t: 'HELLO'; peerId; gameId?; protocolVersion; appVersion; head?: { seq; hash; term }; sig }
  | { t: 'SUBMIT'; cmd: SignedCommand } // author → ALL peers (broadcast, not just sequencer)
  | { t: 'PROPOSAL'; entry: LogEntry; validRound; prevotes; sig }
  | { t: 'VOTE'; vote: SignedVote } // signed prevote or precommit, including nil
  | { t: 'COMMIT'; entry: LogEntry; certificate: SignedVote[] }
  | { t: 'SYNC_REQ'; fromSeq; toSeq? }
  | { t: 'SYNC_RES'; entries: CertifiedEntry[]; more: boolean }
  | { t: 'SNAPSHOT_REQ'; atSeq? }
  | { t: 'SNAPSHOT_RES'; seq; state; protocolState; certificate } // chunked, replay checked
  | { t: 'HEARTBEAT'; genesisDigest; epoch; seat; term; head: { seq; hash }; sig }
  | { t: 'ACCUSE'; evidence: MisbehaviourEvidence }
  | { t: 'SYS_CONTRIB'; round: string; data: unknown; sig } // stage 07 beacon/deck contributions
  | { t: 'PRIVATE'; to: PeerId; payload: unknown; sig } // sent only on the direct channel to recipient
  | { t: 'CHAT'; text; ts; sig }
  | { t: 'PING'; n }
  | { t: 'PONG'; n };
```

Transport interface (implemented in-memory here and by WebRTC in stage 08):

```ts
interface Transport {
  self: PeerId;
  peers(): PeerId[]; // currently connected
  send(to: PeerId, msg: Uint8Array): void; // reliable-ordered per link while connected
  broadcast(msg: Uint8Array): void;
  onMessage(cb: (from: PeerId, msg: Uint8Array) => void): Unsubscribe;
  onPeerChange(cb: (peer: PeerId, up: boolean) => void): Unsubscribe;
}
```

Messages are encoded as canonical JSON bytes. (Consider a binary encoding later; not needed now.) Links can drop and reconnect, and messages in flight during a drop are lost. **Every protocol step must be idempotent and retry-safe.**

`SignedVote` binds the full genesis digest, membership epoch, seat, sequence, round, phase and value hash or explicit nil. Certificates require distinct, sorted voter signatures from the certified voter set. An unsigned commit notification has no authority.

## 5. Proposers, voting rounds and locks

- Use the two-phase locking algorithm and quorum requirements in the strict-agreement design. Proposal, prevote and precommit transitions are serialized and persisted before sending their messages.
- The proposer rotates deterministically through the agreed eligible humans by height and round. It never depends on a local online list. Round 1 at height 1 starts with the first human seat.
- Each voter signs at most one prevote and one precommit per height/round. A non-nil precommit needs a matching prevote quorum and a persisted lock. Nil votes and timeouts do not erase locks. Reproposals carry verifiable prior-round justification.
- Increasing round timeouts allow recovery after network delays. Two distinct authenticated voters can justify catching up to a higher round. No timeout reduces quorum size.
- Broadcast and retry submitted commands. A proposer withholding a still-applicable command triggers round advancement; delay alone is not proof of cheating. Idle game state awaiting a human choice is not censorship.
- Bot seats have separate signing keys held by their designated human host. They remain nonvoters.

## 6. Commitment and repair

- A matching quorum of signed non-nil precommits certifies a validated value. Persist the certificate and resulting state before announcing commitment. Keep the committed prefix permanently.
- Publish engine effects, private updates and successful submission results only after commitment. Board selection previews remain local. A round change never rolls back committed state.
- Persist votes, locks, current round, justified values and committed certificates in an injected safety store. The Stage 06 memory store survives protocol-instance crashes; Stage 10 supplies IndexedDB. Tests cover crashes immediately before and after writes.
- A peer that loses its safety store cannot simply rejoin under the same key and vote. It must recover a provably safe state or undergo the agreed identity-replacement procedure.
- The injected raw-key API has a caller precondition: `create` is only the first activation of a fresh game key; subsequent openings use `restore`, which refuses missing records. A caller that copies the raw key into a replacement empty journal can violate that precondition. Stage 10 must own key creation/loading together with durable safety storage and forbid that fallback. The simulation's deterministic keys are test fixtures, not device identities for production.
- **Desync**: retain a diagnostic, replay the certified prefix and verify full protocol metadata. Repair preserves prior vote/lock records. Stop voting if replay cannot establish valid state; do not trust an unverified snapshot from a claimed majority.

## 7. Snapshots & sync

- Every peer keeps the full log in memory (and in IndexedDB later). Logs are small: a base game is ~1–3k entries.
- `SYNC_REQ` returns up to 200 certified entries per batch, staying within the byte limit. Snapshots contain engine state, nonces, membership/exclusions and crypto metadata. Verify the certified chain and replay-derived metadata before using them for voting. The engine state hash alone cannot authenticate nonce or voter metadata.

## 8. Session layer

`P2PSession implements GameSession` (from stage 05) composes: transport + log + sequencer state machine + engine + randomness driver + private state. The UI is unchanged. Command submission flow:

1. The UI calls `submit(command)`.
2. Local pre-validation against the public engine **and** the private hand (the owner knows exact values).
3. Sign and broadcast `SUBMIT`.
4. Resolve only when the entry commits. After 10 s, expose pending/retry status without claiming that a submitted intent was cancelled. Retry the same signed bytes; stale intents require renewed validation against the current parent.

**System-input driver**: when `getPending` contains `random`/`reveal`/timeout items, the driver runs the corresponding sub-protocol (stubbed now, real in stage 07). The sequencer puts the resulting `system` entry (with evidence) into the log.

## 9. In-memory network & chaos harness

`packages/protocol/test-utils/memnet.ts`:

- A network of N transports. Per-link configurable latency (distribution), jitter, drop probability, duplicate probability, and scheduled partitions/heals. Drive it with a **deterministic virtual clock**: a fake-timers scheduler owned by the harness, so tests are reproducible and fast.
- Reordering: happens only across reconnects (WebRTC channels are ordered while up). Also add a "reorder" mode to prove idempotency.

Chaos scenarios, with RandomBots playing full games through `P2PSession`: five seeds per scenario on each push/PR, twenty nightly seeds per scenario with date-rotated game indices, and an initial acceptance run of twenty seeds per scenario. Manual workflow dispatch supports up to 1,000 seeds per scenario in distinct forty-game shards.

1. Clean network, 4 peers.
2. 5–15% duplicates, 50–400 ms latency.
3. Sequencer crashes mid-turn and comes back 20 s later.
4. Partition 2|2 for 30 s, then heal. Neither side has the required 3-of-4 quorum, so both pause. Assert no divergent commits, and that play resumes after the heal.
5. Partition 3|1: the three cooperative peers continue where pending inputs permit, and the fourth catches up after heal.
6. Byzantine sequencer: it includes an invalid command → it gets accused and replaced, and the game continues. Its normal session halts on evidence implicating its own key. The fault injector then acts as an explicitly malicious command-only client for that seat, signing legal game inputs without voting or proposing. Three honest sessions must finish with a certified exclusion and identical histories.
7. Byzantine sequencer: it censors one seat's commands → it gets replaced.
8. A peer desync injected artificially (a corrupted local state) → it's repaired via snapshot.
9. Two peers restarting at the same time. Volatile state is wiped; persisted vote/lock records and certified entries remain and missing committed entries are fetched from peers.

**Invariant at the end of every scenario**: all honest peers have identical committed logs and identical final state hashes. No honest peer rolls back a committed entry. Scenario 6 does not require the deliberately faulty client to maintain an honest history.

Also run the adversarial traces in the strict-agreement design, including equivocation, hidden certificates, forged round proofs and two-/three-human quorum loss. The last cases must pause safely and resume after the required voters return.

## Steps

1. Crypto identity helpers + signing with domain separation.
2. Log entry types, hashing, and validation (unit tests with hand-made logs, including every rejection path).
3. Valibot message schemas, encode/decode, and size limits.
4. Memnet with a virtual clock.
5. Happy path: submit → proposal → prevote → precommit → certified commit.
6. Round changes, persistent locks and crash recovery.
7. Censorship detection, accusation, exclusion.
8. Sync and snapshot.
9. `P2PSession` + system-input driver with stub randomness.
10. Chaos suite + `pnpm sim net --scenario <n> --seeds 20` for initial acceptance; larger manual runs remain available through workflow dispatch.

## Acceptance criteria

- [ ] All 9 chaos scenarios pass on 20 seeds each with zero divergence for initial acceptance.
- [x] Forged signatures, replayed nonces, wrong prevHash and invalid commands are all rejected (unit tests).
- [ ] A Byzantine sequencer is detected and replaced in scenarios 6 and 7.
- [x] Adversarial vote, lock, persistence and small-population pause tests pass. No unavailable voter is removed without the required certificates.
- [x] The web app can run a "simulated P2P" dev mode: 4 `P2PSession`s over memnet in one tab, with 4 small game views. Useful for debugging.
