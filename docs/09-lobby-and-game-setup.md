# 09 — Lobby & Game Setup (first end-to-end P2P game)

## Goal

Users can create a game, invite friends (link, code or QR), configure rules, fill seats with humans or bots, and start. Starting runs a **genesis ceremony** that produces the signed genesis entry with all cryptographic commitments. After this stage, real people on different networks can play a full base game P2P.

## Prerequisites

Stages 05, 07 and 08 are complete.

## 1. Lobby model

The lobby is a small replicated document owned by the **lobby host** (the creator; after a host disconnect, the lowest remaining peer). Unlike the game log, lobby edits are host-authoritative and simple: the host broadcasts `LOBBY_STATE { version, ... }`, and other peers send requests.

```ts
interface LobbyState {
  version: number;
  lobbyId: string; // = signaling room id or random id in manual mode
  hostPeer: PeerId;
  name: string;
  seats: Array<{
    seat: Seat;
    kind: 'open' | 'human' | 'bot';
    peer?: PeerId;
    name?: string;
    colour: ColourId;
    ready: boolean;
    botLevel?: BotLevel;
    botHost?: PeerId;
  }>;
  spectators: PeerId[];
  config: GameConfigDraft; // modules + options + map choice + timers
  status: 'open' | 'starting' | 'started';
}
```

Messages: `LOBBY_STATE`, `LOBBY_REQ { kind: 'takeSeat' | 'leaveSeat' | 'setName' | 'setColour' | 'setReady' | 'spectate' }`, `LOBBY_CONFIG { patch }` (host only), `LOBBY_KICK` (host only), `LOBBY_START` (host only, needs all humans ready).

Rules:

- Any config change resets every `ready` flag.
- Colours must be unique.
- 2–4 seats for base; 5–6 once the `five-six` module exists.
- Bot seats are hosted by the lobby host by default. The host can reassign a bot's host to another peer.

## 2. Screens

1. **Home**: Play online (create / join), Play local (stage 05), Settings, How to play, Rules variants reference.
2. **Create game**: name, then choose the connection method:
   - "Invite link" (signaling server): shows a link, a copy button and a QR code.
   - "Offline codes" (manual): shows the offer QR/code per joiner, with the answer-code input.
3. **Join**: route `join/$roomId` (`#/join/<room>`) auto-joins via the server; or paste/scan a code at `#/join`. Routes added in this stage: `online/create`, `join/index`, `join/$roomId`, `lobby/$lobbyId`, `game/$gameId` (the P2P game screen; `useBlocker` guard on leave).
4. **Lobby**:
   - seat list with status, colour picker, ready toggle;
   - config panel (editable only by the host, read-only for others): player count, map layout, modules, all options (from each module's `optionsSchema`, rendered generically), VP target, timers, seed ("random" or a fixed hex for replaying a board);
   - chat;
   - connection diagnostics;
   - "Add bot" / "Open seat" / "Kick".
5. **Starting**: a progress view of the ceremony steps (§3) with per-peer check marks and timeouts.
6. Then the game screen (stage 05 UI with a `P2PSession`).

## 3. Genesis ceremony

Run when the host presses Start (all humans ready, all connected in a full mesh). Every step is signed. The ceremony aborts cleanly (back to the lobby with an error) if any step times out (20 s per step).

1. **Freeze**: the host broadcasts `CEREMONY_BEGIN { lobbyVersion, config, seats }`. Every peer checks it equals its lobby view and replies with a signed `FREEZE_ACK`.
2. **Secrets**: each human seat (and each bot host, for each of its bots) generates `masterSecret`s. For each one it computes and publishes a `SeatCommitments` package:
   - `masterPub` and the encryption key `E` (stage 07 §1),
   - `beaconTip` (hash-chain tip, stage 07 §2),
   - `seedCommit = H("seed" ‖ seedShare)`, where `seedShare = HKDF(master, "genesis-seed")`,
   - deck lock public keys for the decks the config needs (or a compact commitment from which they're derivable; see stage 07 §3),
   - Feldman coefficient commitments and `escrowShareHashes[]` (stage 07 §7).
3. **Escrow**, only when the game starts with at least four humans: send sealed Shamir shares via `PRIVATE`. Each recipient verifies its share against the Feldman commitments, then replies with a signed `SHARE_ACK { dealerSeat, H(share) }`. A bad share aborts the ceremony (stage 07 §7).
4. **Seed reveal**: after every `seedCommit` is collected, each seat reveals `seedShare`. Then `genesisSeed = SHA-256("cp2p/genesis" ‖ seedShares in seat order)`. (The config may specify a fixed seed; then the commit-reveal is skipped and the seed is used as-is. Mark such games "fixed board".)
5. **Genesis draft**: every peer builds the identical `Genesis` object:
   `{ protocolVersion, engineVersion, config, seats(with game keys, identity bindings, names, colours, kinds, botHosts), genesisSeed, ceremonyNonce, security: 'verified', commitments(including share acknowledgements and sealed shares), createdAt(host clock, informational) }`.
   Hash the body and derive the routing `gameId` exactly as defined in stage 06. Every human signs the full genesis digest with its per-game key. The body excludes its derived identifier and consent signatures. The frozen ceremony has a fresh agreed 32-byte nonce even for a fixed board.
6. **Decks**: run deck Phase A (shuffle + lock) for every deck in the config (dev deck for base). The resulting encrypted decks go in as the first log entries after genesis (seq 1..k), as `system` entries with shuffle-transcript evidence.
7. **Start**: log entry seq 0 = genesis with all signatures. The term 1 sequencer begins. The first engine pending is `startSeat` → a beacon round.

Version compatibility: in `HELLO` and in step 1, peers compare `protocolVersion` (must be equal) and `engineVersion` (must be equal). Otherwise the joining peer sees "Your app version differs from the host's. Please reload (the host is on vX)." The service worker update flow (stage 18) must make "reload to update" reliable.

## 4. Seat keys & bots

- A human gets a fresh voting/command key for each game, bound to the authenticated device identity during the ceremony. Persist that key together with the game's consensus safety records before signing genesis. Keep it independent of escrowed game secrets.
- A bot seat gets its own Ed25519 key generated by the bot host. The bot host signs bot commands with the bot key. The genesis records `botHost` so peers know which peer relays them.
- Bot move timing: add a humanlike delay (configurable 0.5–2 s) so bots don't act instantly.

## 5. Turn timers in P2P

- Timer config lives in genesis. The **sequencer** tracks deadlines using the entry times it observes. When a deadline passes, the sequencer appends a `system` `TIMEOUT` entry whose evidence is `{ pendingSince: seq, deadlineMs }`.
- That evidence is outside the engine input. The input itself contains only `kind`, `type`, `seat`, and `phase`.
- Peers accept it if their own local clock agrees (with ±3 s tolerance) that the deadline has passed since they applied `pendingSince`. If they disagree, they reject it, and the sequencer retries later. Don't use absolute timestamps across devices; use each peer's own monotonic time since it applied the referenced entry.
- The UI timer ring uses local time since the referenced entry.
- Timeout auto-actions that need the timed-out seat's private data (e.g. discard) are computed by that seat's client if it's online (it submits the command itself when its own local timer expires). If it's offline, the action waits until takeover (stage 10).

## 6. Chat & emotes

- `CHAT` messages are broadcast, signed and rate-limited (5 per 10 s), max 300 chars. They're not in the game log (not hashed), but are stored locally.
- A small set of quick emotes/reactions.
- Mute per player.

## Steps

1. Lobby state machine + messages + host handover (unit tests on memnet).
2. Screens: home, create, join, lobby (with generic option rendering from `optionsSchema`).
3. Ceremony implementation + memnet tests (including every abort path).
4. Wire the `P2PSession` start from genesis. Game screen in P2P mode (own seat only; other hands hidden; waiting indicators showing who the game waits for, from `getPending`).
5. Timers in P2P.
6. Chat.
7. Playwright: 3 browser contexts + 1 bot; create via link, join, configure, start, and play to the end with bots controlling all human seats through the `__cp2p` hook. Assert all contexts see the same winner and the audit passes.
8. Manual test on real devices across networks (home Wi-Fi + mobile hotspot). Record the results in STATUS.md.

## Acceptance criteria

- [ ] Create → invite → join → start → finish → audit ✓ works over the signaling server and over manual codes.
- [ ] Mixed humans and bots work. The bot host can be any peer.
- [ ] A version mismatch is detected with a clear message.
- [ ] Every ceremony abort path returns everyone to the lobby cleanly.
- [ ] Turn timers work, and a disagreeing peer can't be forced into an early timeout.
