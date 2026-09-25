# 10 — Persistence, Reconnection & Seat Takeover

## Goal

Games survive:

- refreshes, crashes and closed tabs,
- flaky mobile connections,
- sequencer loss,
- permanent departures when the current quorum can authorize escrow recovery and bot takeover,
- everybody leaving and coming back later.

Saves are exportable and importable.

## Prerequisites

Stage 09 is complete.

The strict-agreement rules from stage 06 apply throughout. Two- and three-human games pause after losing a required voter. Four-human games can authorize one departure with their other three votes, then require all three remaining humans. Connectivity and recovery timers never reduce a quorum.

## 1. Storage (`@cp2p/storage`, IndexedDB via `idb`)

Database `cp2p`, versioned with explicit migrations:

| Store       | Key                    | Value                                                                                                                                                 |
| ----------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`  | `'device'`             | Ed25519 keypair (private key as non-extractable where possible; otherwise raw bytes), display name, preferred colour                                  |
| `games`     | `gameId`               | `{ gameId, genesis, mySeat, status: 'active'                                                                                                          | 'finished' | 'abandoned', lastSeq, lastCommittedSeq, updatedAt, lobbyInfo (room id / signaling URL), peers[] }` |
| `entries`   | `[gameId, seq]`        | Agreed log value with its verified commit certificate                                                                                                 |
| `consensus` | `gameId`               | Per-game voting key, highest height/round, signed proposals/votes, locks, justified value and certificates, protocol metadata, writer/transfer status |
| `snapshots` | `[gameId, seq]`        | canonical-encoded public state every 100 entries (keep the last 3)                                                                                    |
| `private`   | `gameId`               | `PrivateState` + `masterSecret` + per-bot private state (if hosting bots)                                                                             |
| `escrow`    | `[gameId, dealerSeat]` | received Shamir share                                                                                                                                 |
| `chat`      | `[gameId, n]`          | chat messages                                                                                                                                         |
| `settings`  | key                    | app settings (ICE servers, signaling URL, animation prefs, …)                                                                                         |
| `replays`   | `gameId`               | finished-game replay + audit report                                                                                                                   |

- Writes: atomically persist each consensus transition before transmitting any dependent proposal, prevote or precommit. Persist the committed value, certificate and derived metadata before publishing the result or entering the next height. Preserve locks and the highest entered round through restart. A failed transaction stops voting.
- Generate a separate per-game voting/command key and bind it to the device identity at genesis. Keep it in the same durable record as the game's safety data. It must not be derived from the escrowed master secret. Losing this record requires an agreed key replacement or takeover; loading an old identity backup cannot recreate permission to vote.
- Use an exclusive writer per identity/game across browser tabs. Export/import of a seat uses a certified key transfer, not concurrent copies of a signing key.
- Request `navigator.storage.persist()` on the first online game.
- Optional passphrase encryption of `private`/`identity` (AES-GCM via WebCrypto; key from PBKDF2/Argon2 via a small wasm lib). Off by default. Document the trade-off.

## 2. Resume flows

### 2.1 Refresh / crash (others still playing)

1. On load, the app lists active games from `games`. If one was active in the last 24 h, it offers "Resume game".
2. Restore persisted voting/lock records before any signing. Verify the certified log and replay it to derive engine state, nonces, membership and cryptographic metadata. A snapshot can cache data but cannot independently authorize resumed voting.
3. Reconnect:
   - Server mode: rejoin the signaling room (the room id is stored).
   - Manual mode: the returning peer must exchange a code with **any one** connected player ("Ask a player to open _Reconnect_ and scan this"). Mesh relay does the rest.
4. `HELLO` with its head. Peers answer with `SYNC_RES` for the missing entries. The peer validates, applies and re-enters play.
5. Verify signed round evidence or certificates before advancing consensus. Never regress the restored round. Heartbeats alone cannot clear a lock or authorize a commit.

### 2.2 Temporary disconnect (mobile background, network switch)

- The transport attempts an ICE restart, then a full renegotiation via the server or mesh relay.
- The game continues only with the stage-06 quorum **and** an available pending input. Otherwise show which voters or input are missing, such as "Waiting for Blue (reconnecting… 0:27)".
- Beacon rounds need every participating seat's reveal. While a seat is temporarily offline, its reveal is pending, and the game waits (up to the takeover policy below).

### 2.3 Membership entries

Seat status changes are logged as `membership` entries by the sequencer, so every peer agrees:

- `SEAT_OFFLINE { seat, since }`, emitted after 15 s without contact.
- `SEAT_ONLINE { seat }`.
- `SEAT_RECOVERY_AUTHORIZED { seat, botLevel, botHost, takeoverKeys }`: old-quorum commit freezes the departed seat and its hosted bots, removes its vote at the next height, and permits share release.
- `SEAT_TAKEOVER { seat, recoveredCommitmentCheck }`: a subsequent commit under the remaining set activates the recovered bot only after its secrets pass verification.
- `SEAT_RETURN { seat }`: the human reclaims a seat from a bot; allowed only if the seat still has its master secret. Its private state must be reconciled with what the bot did (see §3.4).

## 3. Takeover policy (seat abandonment)

### 3.1 Trigger

- Configurable in genesis: `takeover: { afterSeconds: 120 (default) | never, mode: 'vote' | 'auto' }`.
  - `vote`: once the seat has been offline longer than `afterSeconds`, show "Replace Blue with a bot?" only when the current voter set can certify removal. Recovery needs the stage-07 escrow threshold as well as the consensus quorum.
  - `auto`: triggered automatically after the timeout.
- Games starting with two or three humans do not distribute recovery shares and cannot take over an absent human under strict agreement. They wait for that human to return. A normal live seat transfer can still be authorized while all required voters participate.

### 3.2 Recovery

1. Commit recovery authorization under the old voter set before honest holders release any shares. Freeze the departed seat and hosted bots. Holders verify that certificate, then release their shares to the authorized recoverers. The sealed original shares remain available in genesis, including shares held by previously recovered seats. Share withholding can still stall recovery.
2. Each reconstructs `masterSecret` and verifies it against the genesis commitments (`masterPub`, beacon tip, lock pubkeys, encryption key). A mismatch ends the game as void (stage 07 §7).
3. They derive the departed seat's private state by **replaying the log in the departed seat's private perspective**. Its hand can be reconstructed from:
   - public events,
   - dealt cards (unlock the chain with its lock keys),
   - stolen cards (as victim: from the sorted-hand/steal-index rule; as thief: by decrypting the sealed opening in the log with the recovered encryption key), plus the blindings of its committed hand (stage 07 §4), re-derived from the recovered secret and the sealed openings.
4. Commit the verified recovery result under the new set before running the bot. Use the host and takeover keys named in the authorization entry; do not choose them from each peer's local online list. Command validation uses the certified current seat key.
5. The beacon can now use the recovered chain for that seat. Other missing reveals or unavailable recovery shares can still pause play.

Authorization and share release are irreversible for privacy. Recoverers can inspect the bot's hand and its historical secrets. Recovered keys also weaken the collusion threshold for other seats. A returning human's hand does not become secret again.

### 3.3 Membership handoff

Membership is fixed within each consensus height. The old voter set certifies a change using its current quorum; the new set and incremented epoch take effect only at the next height. Change one human seat at a time. Joining or replacement keys sign readiness over the full genesis digest, parent value hash, next epoch and proposed member list. They cannot vote before verifying the transition certificate. Protocol-control entries remain available while the engine waits on an offline seat's input or reveal. A four-to-three transition leaves a quorum of three and cannot tolerate a further absent voter.

### 3.4 Returning human

If the original human returns (with their device storage intact), `SEAT_RETURN` hands control back. Their private state is rebuilt the same way from the log. Their secrets have been exposed to the others, so show a note: "Your hand was visible to other players while a bot played for you."

## 4. Everyone left

- If no peers are online, the game is simply paused. The last committed log is on every device.
- To resume, any player opens "Resume" → the room (server) or manual reconnect. Play continues when the certified voter set's quorum is back and required inputs are available. The takeover clock does not run while nobody is online; it measures time after the required quorum returns.
- Stale games: after 30 days inactive, mark them `abandoned` locally (user-deletable).

## 5. Export / import

- **Export save** includes genesis, certified entries, protocol safety records, and optional private/escrow material with an explicit warning. Imports validate all records before writing. Importing an old key does not authorize voting. To resume the same seat on a new device, create a fresh game key there, commit a key replacement with its readiness statement, and retire the old key before activating the destination. The old device or another sufficient current quorum must participate. If that quorum is unavailable, the imported game remains read-only and paused.
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
2. Persist-before-transmission integration, exclusive writer, and replay plus safety-record restoration.
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
  - (b) one of four humans is killed permanently mid-game → old quorum authorizes recovery → takeover → the game completes → the audit passes;
  - (c) all peers are killed at a random point, then restarted in random order → the game resumes and completes;
  - (d) the sequencer is killed during a deck unlock chain;
  - (e) a peer returns after its seat was taken over.
- Private-state reconstruction equals the real private state at every seq (compare against the omniscient simulation) for 500 random games.
- Playwright: refresh a browser mid-game → it auto-resumes; close a context permanently → vote takeover → the game finishes.
- Storage migration test from schema v1 to the current version.
- Lost vote store, failed transactions, tab writer contention, stale save imports, certified key transfers and crashes at every signing boundary.
- Two-/three-human departure pauses without share release or unilateral removal; return resumes the same committed history.
- Withholding recovery shares cannot activate a fabricated bot; recovery keys and command authorization survive a second takeover where the remaining quorum permits it.

## Acceptance criteria

- [ ] All chaos additions pass on 500 seeds each.
- [ ] Refresh-resume takes < 3 s to be back in play on a typical laptop (measured).
- [ ] Four-human takeover and audit pass; two-/three-human departure pauses safely and resumes when the required voter returns.
- [ ] A game can be exported and resumed in another browser as the same seat through a certified key transfer; a stale save cannot reactivate a retired key.
