# Saved online game resume checkpoint

Date: 2026-09-27. This is local implementation evidence, not Stage 09/10 acceptance
or a published P2P release.

## Implemented behavior

The home screen lists saved online games using bounded public metadata. Opening
the game route restores the original signed lobby agreement, device identity,
game keys and certified journal. It reconnects with the frozen device roster in
the original signaling room, without creating another lobby or setup attempt.
The original host follows the same resume path as any other human.

Full resume validates the signed genesis entry, board seed, seat bindings and
deck transcripts. Missing credentials, ceremony records or damaged voting
history cause an error. The implementation never substitutes new keys or
replaces existing history. A signed start interrupted before its first journal
write may initialize only when the built-in IndexedDB journal atomically proves
genesis, entries, consensus safety and key binding are all absent.
The list validates the stored metadata structure and digest without replaying
cryptographic proofs for every saved game.

Ceremony replay subscribes to inbound messages before reading stored phases.
It withholds its ready result until messages received during replay have drained.
A verified disclosure halts opening or active gameplay. Public board state and
history remain available after an active session halts.

The UI supports retry and return home on resume failure. Duplicate route opens
share the same restoring room; a different saved game cannot silently reuse a
live lobby with the same room code.

## Verification

- Serial Vitest run of `online-resume`, `online-startup`, `online-startup-retry`
  and `online-credentials`: 11 tests in four files passed in 59.69 seconds.
  The resume trace uses two real human ceremonies and two hosted bots. It
  certifies a move, closes both sessions, restores the stored identities and
  journals, and verifies matching public state with isolated private hands.
  It also rejects missing journal/material and exercises the startup dispute
  halt. This trace uses an in-memory transport and durable test stores.
- Focused ceremony regressions pass for exact completed-setup replay, real
  post-consent disclosure, disclosure received during replay, invalid-envelope
  handling, outsider packet rejection and interrupted retirement. The real
  signed-dispute-during-replay case passed in 17.97 seconds. These tests establish
  cryptographic verification separately from the browser lifecycle injection.
- Saved-game record tests: 3 passed, covering immutable byte preservation,
  index recovery, concurrent saves, detached return values, corrupted metadata
  and missing start records.
- Combined registry, storage lock, freeze-pin and seat-binding checks: 21 tests
  in four files passed in 2.20 seconds. Both `-` and `_` are accepted as leading
  characters in a valid ceremony lock identifier.
- Repository typecheck, type-aware lint, dependency boundaries, engine purity,
  translation-key checks and production build passed. Vite reports the online
  chunk slightly above its 500 kB warning threshold.

## Remaining checks

Actual WebRTC/IndexedDB reopening through `OnlineRoom.open({kind:'resume'})`
has not been verified in Chrome. Chrome automation timed out and native
automation could not find a visible window; browser verification is pending.
The three-second refresh target has not been measured. The follow-up Claude
review is complete; its [correction record](browser-resume-review-disposition.md)
tracks reproduced fixes and remaining work.

Manual signaling, external-network gameplay, browser recovery/seat-transfer
controls, transferable saves, timers and current-protocol full-game acceptance
remain open. The production home screen still exposes local game creation only.
