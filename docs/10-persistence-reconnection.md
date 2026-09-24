# 10 — Persistence, Reconnection & Seat Takeover

## Goal

Games survive:

- refreshes, crashes and closed tabs,
- flaky mobile connections,
- sequencer loss,
- permanent departures (a bot takes over the seat using escrow-recovered secrets),
- everybody leaving and coming back later.

Saves are exportable and importable.

## Prerequisites

Stage 09 is complete.

## 1. Storage (`@cp2p/storage`, IndexedDB via `idb`)

Database `cp2p`, versioned with explicit migrations:

| Store       | Key                    | Value                                                                                                                |
| ----------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `identity`  | `'device'`             | Ed25519 keypair (private key as non-extractable where possible; otherwise raw bytes), display name, preferred colour |
| `games`     | `gameId`               | `{ gameId, genesis, mySeat, status: 'active'                                                                         | 'finished' | 'abandoned', lastSeq, lastCommittedSeq, updatedAt, lobbyInfo (room id / signaling URL), peers[] }` |
| `entries`   | `[gameId, seq]`        | `LogEntry`                                                                                                           |
| `snapshots` | `[gameId, seq]`        | canonical-encoded public state every 100 entries (keep the last 3)                                                   |
| `private`   | `gameId`               | `PrivateState` + `masterSecret` + per-bot private state (if hosting bots)                                            |
| `escrow`    | `[gameId, dealerSeat]` | received Shamir share                                                                                                |
| `chat`      | `[gameId, n]`          | chat messages                                                                                                        |
| `settings`  | key                    | app settings (ICE servers, signaling URL, animation prefs, …)                                                        |
| `replays`   | `gameId`               | finished-game replay + audit report                                                                                  |

- Writes: persist each entry **before** sending its ACK (durability ⇒ ACK), batched in one transaction per tick.
- Request `navigator.storage.persist()` on the first online game.
- Optional passphrase encryption of `private`/`identity` (AES-GCM via WebCrypto; key from PBKDF2/Argon2 via a small wasm lib). Off by default. Document the trade-off.

## 2. Resume flows

### 2.1 Refresh / crash (others still playing)

1. On load, the app lists active games from `games`. If one was active in the last 24 h, it offers "Resume game".
2. Rebuild state from the latest snapshot + entries. Verify the hash chain and the state hashes.
3. Reconnect:
   - Server mode: rejoin the signaling room (the room id is stored).
   - Manual mode: the returning peer must exchange a code with **any one** connected player ("Ask a player to open _Reconnect_ and scan this"). Mesh relay does the rest.
4. `HELLO` with its head. Peers answer with `SYNC_RES` for the missing entries. The peer validates, applies and re-enters play.
5. The sequencer term may have changed. The peer learns the current term from heartbeats.

### 2.2 Temporary disconnect (mobile background, network switch)

- The transport attempts an ICE restart, then a full renegotiation via the server or mesh relay.
- The game continues without the disconnected seat as long as a majority of seats is online **and** the pending doesn't require that seat. If it does, others see "Waiting for Blue (reconnecting… 0:27)".
- Beacon rounds need every participating seat's reveal. While a seat is temporarily offline, its reveal is pending, and the game waits (up to the takeover policy below).

### 2.3 Membership entries

Seat status changes are logged as `membership` entries by the sequencer, so every peer agrees:

- `SEAT_OFFLINE { seat, since }`, emitted after 15 s without contact.
- `SEAT_ONLINE { seat }`.
- `SEAT_TAKEOVER { seat, botLevel, recoveredCommitmentCheck }`.
- `SEAT_RETURN { seat }`: the human reclaims a seat from a bot; allowed only if the seat still has its master secret. Its private state must be reconciled with what the bot did (see §3.4).

## 3. Takeover policy (seat abandonment)

### 3.1 Trigger

- Configurable in genesis: `takeover: { afterSeconds: 120 (default) | never, mode: 'vote' | 'auto' }`.
  - `vote`: once the seat has been offline longer than `afterSeconds`, the remaining online humans see "Replace Blue with a bot?". It needs **all** online remaining humans to agree (they're the escrow threshold holders anyway).
  - `auto`: triggered automatically after the timeout.
- 2-player games: takeover makes the single remaining player the recoverer (the escrow threshold t = 1, disclosed in stage 07).

### 3.2 Recovery

1. Every online human sends its escrow share for the departed seat to every other online human (`PRIVATE`).
2. Each reconstructs `masterSecret` and verifies it against the genesis commitments (beacon tip, lock pubkeys).
3. They derive the departed seat's private state by **replaying the log in the departed seat's private perspective**. Its hand can be reconstructed from:
   - public events,
   - dealt cards (unlock the chain with its lock keys),
   - stolen cards (as victim: from the sorted-hand/steal-index rule; as thief: from the victim's private message, which the thief must re-send; the victim is online, or also recovered).
4. The sequencer (or the designated bot host = lowest online human) runs the bot for that seat. Its `PrivateState` is the reconstructed one. The bot signs with a **takeover key** announced in the `SEAT_TAKEOVER` entry (signed by all consenting humans).
5. The beacon now uses the recovered chain for that seat (every recovering peer can compute it), so dice never stall again.

### 3.3 Sequencer election

Unchanged from stage 06. A taken-over seat is not a voter. The majority rule then counts **remaining human seats**: a membership entry that changes the voter set needs a majority of the _old_ voter set. This follows Raft's reconfiguration safety rule. Keep reconfiguration to one seat at a time.

### 3.4 Returning human

If the original human returns (with their device storage intact), `SEAT_RETURN` hands control back. Their private state is rebuilt the same way from the log. Their secrets have been exposed to the others, so show a note: "Your hand was visible to other players while a bot played for you."

## 4. Everyone left

- If no peers are online, the game is simply paused. The last committed log is on every device.
- To resume, any player opens "Resume" → the room (server) or manual reconnect. Play continues once a majority of human seats is back (the takeover policy clock doesn't run while _nobody_ is online; it measures time from the moment a majority is back).
- Stale games: after 30 days inactive, mark them `abandoned` locally (user-deletable).

## 5. Export / import

- **Export save** (JSON file, via download): `{ format: 'cp2p-save', version, genesis, entries, private (optional, with warning), escrowShares (optional) }`. Used to move a game to another device: import it on the new device and resume as the same seat. Requires the identity key too, so offer "export identity" with a strong warning.
- **Export replay** (public only, no secrets until audit): a stage-04 replay format superset.

## 5b. React data access

- Expose storage to the UI **only** through TanStack Query hooks in `apps/web/src/queries/`: `useSavedGames`, `useGame(gameId)`, `useResumableGames`, `useDeleteGame`, `useExportSave`, `useImportSave`, `useSettings`.
- Swap the stage-05 `localStorage` settings adapter for IndexedDB.
- Validate imported files (saves, replays, identity exports) with Valibot schemas before touching storage.
- The live log/state of an active game is **not** read via queries. `P2PSession` writes to storage and pushes to Zustand. When a game ends, invalidate `savedGames`.

## 6. Game history

- A list of past games: date, players, winner, audit status, and buttons to open the replay (stage 17), export, or delete.
- Local stats: games played, win rate, average VP. All local; no server.

## Steps

1. The storage package with schema, migrations and fake-indexeddb tests.
2. Persist-before-ACK integration; rebuild-from-storage.
3. Resume UI + flows for server and manual reconnect.
4. Membership entries + offline detection + waiting UI.
5. Takeover: voting UI, escrow recovery, private-state reconstruction, bot hosting, the takeover key.
6. Seat return.
7. Everyone-left resume.
8. Export/import save and replay; the game history screen.
9. Tests.

## Required tests

- Memnet chaos additions:
  - (a) a random peer is killed with storage kept and restarted every ~50 entries;
  - (b) a peer is killed permanently mid-game → takeover → the game completes → the audit passes;
  - (c) all peers are killed at a random point, then restarted in random order → the game resumes and completes;
  - (d) the sequencer is killed during a deck unlock chain;
  - (e) a peer returns after its seat was taken over.
- Private-state reconstruction equals the real private state at every seq (compare against the omniscient simulation) for 500 random games.
- Playwright: refresh a browser mid-game → it auto-resumes; close a context permanently → vote takeover → the game finishes.
- Storage migration test from schema v1 to the current version.

## Acceptance criteria

- [ ] All chaos additions pass on 500 seeds each.
- [ ] Refresh-resume takes < 3 s to be back in play on a typical laptop (measured).
- [ ] Takeover works for 3-, 4- and 2-player games, and the audit passes afterwards.
- [ ] A game can be exported from one browser and resumed in another as the same seat.
