# 17 — Spectators, Replays & Map Editor

## Goal

Three features that fall out of the event-log design:

1. **Spectators**: watch a live P2P game without being able to affect it or see secrets.
2. **Replay viewer**: step through finished (or in-progress, public-only) games. After the audit, with all cards visible.
3. **Map editor**: create custom boards and share them as compact strings. They're playable in the lobby.

## Prerequisites

Stage 10 is complete (the storage and replay formats exist). The map editor also needs the stage 11 scenario abstraction; seafaring terrains are needed after stage 12.

## Part A — Spectators

- Spectators join the lobby (`LOBBY_REQ spectate`) or a running game (via an invite link with `?spectate=1`).
- A spectator connects to **one** peer only, the **spectator host** (to limit mesh size; spectators aren't in the mesh), by default the lowest online human seat, falling back to others.
- The host sends: genesis, committed entries (public payloads only), and heartbeats with the committed head. **Never** `PRIVATE` messages, escrow shares or private state.
- The spectator verifies everything as a normal peer does (signatures, hash chain, engine validation) using a `SpectatorSession implements GameSession` with `mode: 'spectator'`. It has no controllable seats, and it never ACKs (it isn't counted in the majority).
- **Delay option** (genesis option `spectatorDelayEntries`, e.g. 0 or 20): the host forwards entries only when they're N entries old. This prevents a spectator relaying info to a player (weak protection; document it).
- Max spectators per host: 4 (configurable). Spectators can chat in a separate spectator channel (players can mute it).
- UI: the game screen with all hands hidden, a "Spectating" badge, and a player-perspective toggle limited to public info.

## Part B — Replay viewer

- Input: a local game from history, an imported replay file, or a replay pasted as a compressed string (`HXREPLAY1.` + deflate + base64url; warn when it's too long for chat).
- `ReplaySession implements GameSession` with `mode: 'replay'`. It precomputes states at checkpoints (every 50 inputs) for fast seeking.
- Controls: play/pause, speed (0.5×–8×), step forward/back by input, jump to turn N, jump to "next 7", and a timeline scrubber with markers (builds, awards, robber moves, largest swings).
- **Perspectives**:
  - public only (default for in-progress/unaudited replays),
  - omniscient: when the replay includes the audit's master secrets, reconstruct every hand and card identity with the audit machinery and show all hands,
  - a seat's perspective: show one seat's private view over time.
- **Stats panel**:
  - resources gained per seat over time (line chart),
  - dice histogram vs expected,
  - robber impact (resources blocked per seat),
  - trade summary.

  Use the `dataviz` guidance for charts (consistent palette, accessible, dark/light).

- Export: download the replay JSON; copy the replay string.

## Part C — Map editor

- Route `#/editor` (TanStack Router file route `routes/editor.lazy.tsx`, with search params `{ map?: string }` validated by Valibot). Uses the same renderer with an editor plugin layer. The replay viewer is `routes/replay/$gameId.lazy.tsx`, and imported replays use `#/replay/import`.
- Tools:
  - terrain brush (all terrains the enabled modules allow, including sea/gold/fog/lake),
  - number-token placement (click to cycle; or "auto-assign balanced"),
  - harbor placement on coastal edges (type picker),
  - erase,
  - set the robber/pirate start,
  - mark setup-allowed areas/islands (for seafaring),
  - define a fog stack (terrain + token multiset),
  - VP target and module requirements.
- **Validation panel** (live):
  - every land hex except desert/lake has a token,
  - token counts are reasonable,
  - no unreachable land for the modules in use,
  - harbors are on coastal edges,
  - enough settlement spots for the player count in the setup areas,
  - the balance warnings (adjacent 6/8…).

  Errors block export; warnings don't.

- **Randomise** helpers: fill the terrain bag randomly; auto-assign tokens with the constraint solver from stage 03.
- **Format**: `MapDef` JSON (versioned schema in `@cp2p/maps`, validated with Valibot). Share string: `HXMAP1.` + base64url(deflate-raw(canonical JSON)). Import by paste, by file, or by link `#/editor?map=<string>` (for small maps).
- **Lobby integration**: map layout "Custom" → paste or pick from saved maps. The `MapDef` is embedded in `GameConfig`, so it's part of the genesis (hashed and signed), and every peer builds the same board.
- Saved maps are stored in IndexedDB (`maps` store: add a storage migration), accessed via TanStack Query hooks (`useSavedMaps`, `useSaveMap`, `useDeleteMap`). Imported map strings are validated with the Valibot `MapDef` schema.
- Undo/redo (a command stack), keyboard shortcuts, and a mobile-friendly palette.

## Steps

1. Spectator host logic + `SpectatorSession` + memnet tests (assert that no private data ever reaches the spectator: intercept all messages to the spectator and scan for `PRIVATE`, share or secret fields).
2. Spectator UI + invite link.
3. `ReplaySession` + controls + perspectives + the omniscient reconstruction via audit.
4. Stats panel with charts.
5. The `MapDef` schema + codec + validation.
6. The editor UI.
7. Lobby integration + storage migration.

## Acceptance criteria

- [ ] A spectator can watch a live 4-player P2P game. The message-interception test proves it received no secrets.
- [ ] Any finished game can be replayed, with an omniscient view after the audit. Seeking to any point takes < 200 ms.
- [ ] A custom map made in the editor can be shared as a string, loaded in a lobby, and played P2P.
