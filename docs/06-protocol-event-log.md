# 06 — Protocol & Replicated Event Log

## Goal

Build `@cp2p/protocol`, which lets N peers keep one agreed, validated, hash-chained log of inputs and therefore identical game state. It must be:

- transport-agnostic,
- tested over an in-memory simulated network with delays, drops, duplicates and partitions.

Randomness and hidden information use a `LocalRandomSource` stub here. Stage 07 replaces it with the real cryptographic protocols. WebRTC comes in stage 08.

## Prerequisites

Stage 04 (engine + sim) is complete. Stage 05 isn't required.

## 1. Identities & signatures (`@cp2p/crypto`, first part)

- **Device identity**: Ed25519 keypair (`@noble/curves/ed25519`), generated once per device and stored later in IndexedDB (stage 10). `PeerId = base64url(publicKey)`.
- **Seat binding**: genesis maps `seat → peerPublicKey`. Commands are signed with the peer key.
- Helpers: `sign(bytes, sk)`, `verify(sig, bytes, pk)`, and `signObject(value, sk)` = sign over `canonicalEncode(value)` with a **domain separation prefix** (`"cp2p/v1/<purpose>\0"`), so a signature for one purpose can't be replayed as another.

## 2. Log entries

```ts
interface SignedCommand {
  body: { gameId: string; seat: Seat; nonce: number;  // per-seat strictly increasing
          headSeq: number;                             // author's view of log head (advisory, for staleness)
          command: Command };
  sig: string;                                          // Ed25519 by seat's key, purpose "cmd"
}

interface LogEntry {
  seq: number;              // 0 = genesis
  term: number;             // sequencer term
  prevHash: string;         // hex sha256 of previous entry's hash-body
  payload:
    | { kind: 'genesis'; genesis: Genesis }
    | { kind: 'command'; signed: SignedCommand }
    | { kind: 'system'; input: SystemInput; evidence: SystemEvidence }   // evidence proves validity (beacon reveals, deck proofs, timer claims)
    | { kind: 'membership'; change: MembershipChange };                   // seat online/offline/bot-takeover (stage 10)
  stateHash: string;        // hash of public state AFTER applying this entry (computed by sequencer, verified by all)
  sequencer: PeerId;
  sig: string;              // sequencer signature over all fields above, purpose "entry"
}
entryHash(e) = sha256(canonicalEncode(e without sig))
```

- `Genesis` (full definition in stage 09): `gameId`, `protocolVersion`, `engineVersion`, `config`, seats (`seat → pubkey, name, colour, kind: human|bot`, bot host), `genesisSeed`, cryptographic commitments (stage 07), `createdAt` (informational). Genesis is valid only when it carries a signature from **every** human seat.
- `gameId = base64url(sha256(canonical(genesis without signatures)))[0..22]`.

## 3. Validation of an entry (every peer, every entry)

1. `seq == head.seq + 1` and `prevHash == entryHash(head)`.
2. `term` matches the peer's current term, and `sequencer` is that term's sequencer. Verify the sequencer signature.
3. Per payload:
   - `command`: verify the seat's signature; `gameId` matches; `nonce > lastNonce[seat]`; the engine's `validate(state, input)` returns ok.
   - `system`: verify the `evidence` (stage 07 defines evidence types; here, a `StubEvidence` that honest peers accept); the engine validates.
   - `membership`: validate against membership rules (stage 10).
4. Apply, compute `hashValue(publicState)`, and compare with `stateHash`. A mismatch means either the sequencer is lying or there's a local bug. Check which by comparing with ACKs from other peers (§6).

An invalid entry signed by the sequencer is **misbehaviour evidence**. Keep it, broadcast `ACCUSE { entry }` and start an election that excludes that sequencer for the rest of the game (§5).

## 4. Messages

All wire messages are validated on receipt with Valibot schemas (`v.safeParse`). Use `v.variant("t", [...])` for the message union and `v.strictObject` so unknown fields are rejected. Oversized (> 256 KB after reassembly), malformed or unknown messages are dropped and counted against the sender's reputation (disconnect after a threshold).

The wire schema validates the surrounding message; the engine validates registered command and system-input keys. Signatures, reveal proofs, and timer evidence stay in their log-entry fields. The P2P adapter must reject a local-mode `CARD_DEALT.card` value and deliver that identity privately instead.

```ts
type Msg =
  | { t: 'HELLO'; peerId; gameId?; protocolVersion; appVersion; head?: { seq; hash; term }; sig }
  | { t: 'SUBMIT'; cmd: SignedCommand } // author → ALL peers (broadcast, not just sequencer)
  | { t: 'ENTRY'; entry: LogEntry } // sequencer → all
  | { t: 'ACK'; seq; entryHash; stateHash; term } // all → all
  | { t: 'COMMIT'; seq; term } // sequencer → all (optional optimisation; peers can also derive commits from ACKs)
  | { t: 'SYNC_REQ'; fromSeq; toSeq? }
  | { t: 'SYNC_RES'; entries: LogEntry[]; more: boolean }
  | { t: 'SNAPSHOT_REQ'; atSeq? }
  | { t: 'SNAPSHOT_RES'; seq; state; entryHash } // chunked
  | { t: 'HEARTBEAT'; term; head: { seq; hash }; now: number }
  | { t: 'VOTE_REQ'; term; candidate: Seat; head: { seq; hash; committedSeq }; sig }
  | { t: 'VOTE'; term; candidate: Seat; granted: boolean; sig }
  | { t: 'ACCUSE'; evidence: LogEntry | SignedConflict }
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

## 5. Sequencer & elections (Raft-lite)

- Seats are ordered by seat number. **Eligible** seats are human seats that are currently online and not accused.
- Term 1 sequencer = the lowest eligible seat at game start.
- The sequencer sends `HEARTBEAT` every 1 s. A peer that misses heartbeats for `electionTimeout` (randomised 3–5 s) starts an election:
  - `term += 1`, candidate = **the lowest eligible seat that the peer can currently reach (including itself)**, then `VOTE_REQ` to all.
- Vote granting rules (as in Raft): grant at most one vote per term, and only if the candidate's committed head is at least as up to date as yours (`committedSeq` and hash).
- A candidate that collects votes from a **majority of all human seats** (counting itself) becomes the sequencer for that term. It first ensures it has the longest _committed_ prefix known to voters (pulling via `SYNC_REQ`), then continues.
- Uncommitted entries from older terms that didn't survive are discarded. Peers that optimistically applied them **roll back** to the last committed snapshot and replay.
- **Censorship detection**: every peer receives every `SUBMIT` (broadcast). If a valid, applicable `SUBMIT` isn't sequenced within 3 s while heartbeats continue, peers treat the sequencer as faulty and start an election that skips it for 1 term.
- 2-player games: majority = both. Any disconnect pauses the game (expected).
- Bots are not voters. Bot commands are signed by the bot host's key, with a bot-seat key in genesis (stage 09).

## 6. Commit rule & optimistic apply

- Each peer applies an `ENTRY` optimistically once validated (for UI latency), then broadcasts `ACK`.
- An entry is **committed** when ACKs with a matching `entryHash` **and** `stateHash` come from a majority of human seats (including the sequencer). Everything before a committed entry is committed.
- The UI shows uncommitted effects normally. Rollbacks are rare and handled by re-rendering from the reverted state.
- **Desync**: if a peer's computed `stateHash` differs from the majority's ACKs, it is desynced (a bug). It logs a diagnostic bundle (its state, the entry and the version info) to local storage, fetches a snapshot from a majority peer, and continues. Surface a non-blocking "sync repaired" toast plus a "copy diagnostic" button.

## 7. Snapshots & sync

- Every peer keeps the full log in memory (and in IndexedDB later). Logs are small: a base game is ~1–3k entries.
- `SYNC_REQ` returns entries in batches of 200. `SNAPSHOT_RES` exists for spectators/late joiners, but **peers always verify by replaying the log from genesis** when they can, and use snapshots only as a fast path checked against a committed `stateHash`.

## 8. Session layer

`P2PSession implements GameSession` (from stage 05) composes: transport + log + sequencer state machine + engine + randomness driver + private state. The UI is unchanged. Command submission flow:

1. The UI calls `submit(command)`.
2. Local pre-validation against the public engine **and** the private hand (the owner knows exact values).
3. Sign and broadcast `SUBMIT`.
4. Wait until the entry containing the command is applied, then resolve the promise. Time out after 10 s with a retry.

**System-input driver**: when `getPending` contains `random`/`reveal`/timeout items, the driver runs the corresponding sub-protocol (stubbed now, real in stage 07). The sequencer puts the resulting `system` entry (with evidence) into the log.

## 9. In-memory network & chaos harness

`packages/protocol/test-utils/memnet.ts`:

- A network of N transports. Per-link configurable latency (distribution), jitter, drop probability, duplicate probability, and scheduled partitions/heals. Drive it with a **deterministic virtual clock**: a fake-timers scheduler owned by the harness, so tests are reproducible and fast.
- Reordering: happens only across reconnects (WebRTC channels are ordered while up). Also add a "reorder" mode to prove idempotency.

Chaos scenarios (each run with ≥ 200 seeds in CI; 5k nightly), with RandomBots playing full games through `P2PSession`:

1. Clean network, 4 peers.
2. 5–15% duplicates, 50–400 ms latency.
3. Sequencer crashes mid-turn and comes back 20 s later.
4. Partition 2|2 for 30 s, then heal. Neither side has a majority (3 of 4), so both pause. Assert no divergent commits, and that play resumes after the heal.
5. Partition 3|1: the majority continues, and the minority catches up after heal.
6. Byzantine sequencer: it includes an invalid command → it gets accused and replaced, and the game continues.
7. Byzantine sequencer: it censors one seat's commands → it gets replaced.
8. A peer desync injected artificially (a corrupted local state) → it's repaired via snapshot.
9. Two peers restarting at the same time (their in-memory state is wiped and rebuilt from peers).

**Invariant at the end of every scenario**: all peers have identical committed logs and identical final state hashes. No committed entry is ever rolled back.

## Steps

1. Crypto identity helpers + signing with domain separation.
2. Log entry types, hashing, and validation (unit tests with hand-made logs, including every rejection path).
3. Valibot message schemas, encode/decode, and size limits.
4. Memnet with a virtual clock.
5. Sequencer happy path: submit → entry → ack → commit.
6. Elections, terms, rollback of uncommitted entries.
7. Censorship detection, accusation, exclusion.
8. Sync and snapshot.
9. `P2PSession` + system-input driver with stub randomness.
10. Chaos suite + `pnpm sim net --scenario <n> --seeds 1000`.

## Acceptance criteria

- [ ] All 9 chaos scenarios pass on 1,000 seeds each with zero divergence.
- [ ] Forged signatures, replayed nonces, wrong prevHash and invalid commands are all rejected (unit tests).
- [ ] A Byzantine sequencer is detected and replaced in scenarios 6 and 7.
- [ ] The web app can run a "simulated P2P" dev mode: 4 `P2PSession`s over memnet in one tab, with 4 small game views. Useful for debugging.
