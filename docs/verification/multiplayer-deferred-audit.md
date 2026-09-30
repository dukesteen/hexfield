# Multiplayer beta: deferred-items audit

Audited on 2026-09-30 against `main` at `f9e953f` (protocol v6). The
[first multiplayer beta](../multiplayer-beta.md) listed these items as deferred on
2026-09-27. Most of them were built, reviewed and verified during Stage 10 and
shipped in the protocol v6 release (`9652085`, 2026-09-28). The beta page was
not updated when they shipped, so its "Deferred" list was stale.

Classification:

- **SHIPPED**: live in the production build and reachable by a player.
- **HIDDEN**: implemented but gated or hidden from beta users.
- **PARTIAL**: reachable, with a named part missing.
- **MISSING**: not implemented.

No deferred item is HIDDEN. The app has no feature flags; the only gates are
`import.meta.env.DEV` (developer tools and board/network pages) and protocol
eligibility checks, such as the four-human requirement for takeover.

## Summary

| Item                                                    | Status                                                                                         | Where                                                                                                                                                                                                              | Tests and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seat transfer (live move to another device)             | SHIPPED                                                                                        | Game menu, "Move this seat to another device" (`OnlineGameScreen.tsx`, `TransferPanel.tsx`); destination route `/transfer/$code` (`TransferDestinationScreen.tsx`); protocol `transfer-*.ts`, `p2p-session.ts`     | `packages/protocol/src/transfer-membership.test.ts`, `transfer-session.test.ts`, `transfer-private.test.ts`, `recovery-replica.test.ts` (live transfer and cancellation); web `online-transfer-*.test.ts`, `TransferPanel.test.tsx`, `TransferDestinationScreen.test.tsx`; `apps/web/tests/online-transfer.e2e.ts`; [native transfer](stage10/native-transfer-acceptance.md), [cross-engine CI](stage10/cross-engine-transfer-ci-2026-09-28.md)                  |
| Transferable private saves                              | SHIPPED                                                                                        | Menu "Export full save" (`FullSaveExportDialog.tsx`, optional passphrase-encrypted private material); home "Imported full saves" (`ImportedOnlineFullSaves.tsx`); `/full-save/$saveId` + `ImportedTransferRequest` | `online-full-save*.test.ts`, `FullSaveExportDialog.test.tsx`, `ImportedTransferRequest.test.tsx`, `routes/full-save/-full-save.test.tsx`; `apps/web/tests/online-full-save.e2e.ts`, `imported-transfer.e2e.ts`; [imported-save transfer](stage10/imported-save-transfer-browser-acceptance.md). An imported file is read-only; control moves only through a signed live transfer approved by the current device, and a stale import cannot revive a retired key. |
| Fresh-device return                                     | PARTIAL                                                                                        | Return goes through the certified host's "Return player N to a device" link (`startTransfer(..., 'return')`)                                                                                                       | `transfer-membership.test.ts` ("return uses the last certified human game key…"), `transfer-private.test.ts` (recovered return, custody); `online-takeover.e2e.ts`. Missing: the return destination must be the **original device**, because it proves the claim with its retired game key. A player who lost that device cannot reclaim the seat; see below.                                                                                                    |
| Reclaiming a recovered bot                              | SHIPPED                                                                                        | Bot host: "Return player N to a device" (menu, and since this audit a board notice, `RecoveredSeatNotices.tsx`); returning device opens the link on `/transfer/$code`                                              | `transfer-membership.test.ts`, `transfer-private.test.ts`, `transfer-session.test.ts` ("fresh host takes a recovered bot…", "second-generation retired human…"); [native takeover and return](stage10/native-takeover-acceptance.md) (two takeovers, fresh-key return, returned-human command, finish and three clean audits); `online-takeover.e2e.ts`                                                                                                          |
| Voted takeover UI                                       | SHIPPED (a recovered bot did not move on `main` from 2026-09-29 until this audit; see Defects) | Lobby setting "Replace a disconnected player after" + "Who starts a takeover?" (`OnlineConfiguration.tsx`, default vote after 120 s); in-game `RecoveryPanel.tsx`                                                  | `takeover-policy.test.ts`, `takeover-runtime.test.ts`, `recovery-*.test.ts`, `p2p-recovery.test.ts`; `RecoveryPanel.test.tsx`, `OnlineConfiguration.test.tsx`; `online-takeover.e2e.ts`; [takeover product checks](stage10/product-acceptance-checkpoint.md#takeover-controls)                                                                                                                                                                                   |
| Automatic takeover                                      | SHIPPED                                                                                        | Same setting, "Start automatically"                                                                                                                                                                                | `automatic-takeover.test.ts`; [automatic scheduler acceptance](stage10/automatic-takeover-acceptance.md)                                                                                                                                                                                                                                                                                                                                                         |
| Certified presence timers                               | SHIPPED                                                                                        | `recovery-presence.ts`, `recovery-presence-observer.ts`, `session-timing.ts`; offline markers gate takeover eligibility                                                                                            | `recovery-presence.test.ts`, `takeover-runtime.test.ts`, `turn-timeout*.test.ts`, `private-discard-timer.test.ts`; [timer and quorum acceptance](stage10/timer-acceptance.md)                                                                                                                                                                                                                                                                                    |
| Continuation after a required player permanently leaves | PARTIAL                                                                                        | Four-human games: takeover replaces the player with a certified bot. Recovery that cannot complete ends the game as void (`RecoveryVoidDialog.tsx`)                                                                | `p2p-departure.test.ts` (two- and three-human games pause safely and resume on return); takeover tests above. Missing by design: games that started with two or three humans cannot continue without the absent voter (DECISIONS 2026-09-25, "Strict agreement and recoverable voting state").                                                                                                                                                                   |
| Chat                                                    | SHIPPED                                                                                        | Lobby `ChatPanel`; game: menu entry until this audit, now an on-board button with unread count (`ChatLauncher.tsx`)                                                                                                | `apps/web/src/session/online-chat.test.ts`, `ChatPanel.test.tsx`, `ChatLauncher.test.tsx`; `apps/web/tests/online-chat.e2e.ts`; [chat browser check](stage09/chat-browser-check.md). Signed per-peer messages, mute, lobby/game history separation, restore with the saved game.                                                                                                                                                                                 |
| Emotes                                                  | SHIPPED                                                                                        | Five signed quick reactions in `ChatPanel` (`chat-emotes.ts`)                                                                                                                                                      | As chat                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| History statistics                                      | SHIPPED                                                                                        | Home, saved online games: games played, win rate, average VP (`SavedOnlineGames.tsx`, `online-game-history.ts`)                                                                                                    | `online-game-history.test.ts`, `online-game-history-writer.test.ts`, `SavedOnlineGames.test.tsx`; `online-history.e2e.ts`; [saved-history checkpoint](stage10/saved-history-checkpoint.md). Only complete clean audits count.                                                                                                                                                                                                                                    |
| Automated abandoned-game cleanup                        | PARTIAL                                                                                        | Unfinished games are marked "Inactive for 30 days" (`online-game-activity.ts`); removal is a confirmed per-game action                                                                                             | `online-game-activity.test.ts`, `SavedOnlineGames.test.tsx`; [native history check](stage10/native-history-v6-acceptance.md). Missing: automatic deletion. Deliberately not added; see below.                                                                                                                                                                                                                                                                    |
| Automated cheat-evidence capture and fairness UI        | PARTIAL                                                                                        | Rejected signed proofs are captured and certified (`cheat-capture.ts`, `cheat-proof.ts`); board fairness indicator, player badges, event log and results (`FairnessStatus`)                                        | `cheat-*.test.ts`; [fairness status check](stage09/fairness-status-check.md). Missing: penalties or other consequences for a certified cheater, and publication of evidence beyond the game's own peers and exported replay.                                                                                                                                                                                                                                     |
| QR camera scanning                                      | SHIPPED                                                                                        | "Scan QR code" on join and manual-connection screens (`ScanInvitation`, `qr-scanner.ts`: native `BarcodeDetector`, local decoder fallback)                                                                         | `qr-scanner.test.ts`, `InvitationCode.test.tsx`. Not verified with a physical camera (user waiver, 2026-09-28).                                                                                                                                                                                                                                                                                                                                                  |
| Invitation-size optimization                            | SHIPPED                                                                                        | Manual codes are compact SDP, deflate-raw compressed, capped at 1,533 bytes for QR (`packages/p2p/src/manual-code.ts`, `manual-sdp-codec.ts`); signaling invitations are short links                               | `manual-code.test.ts`, `manual-sdp-codec.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                |
| Exhaustive cross-browser certification                  | PARTIAL                                                                                        | Chromium, Firefox and WebKit engine checks for transfer and mixed-engine games                                                                                                                                     | [cross-engine CI](stage10/cross-engine-transfer-ci-2026-09-28.md), `mixed-engine-online.e2e.ts`. Not exhaustive; physical phones untested.                                                                                                                                                                                                                                                                                                                       |

Excluded from implementation (need devices, other networks or paid services):
connection checks between physical devices on different networks, a default
TURN relay, and the eight-resource proof-performance target. They remain in the
beta page's deferred list.

## Notes on the partial items

**Fresh-device return.** A recovered seat's hand was disclosed to the other
players, so its old key is retired. The return protocol accepts a return
request signed with the last certified human game key of that seat
(`transfer-membership.ts`); only the original device holds it. Allowing another
device would need a different proof of identity. The bot's host choosing any
device would let one player hand an absent player's seat to anyone, which
weakens the current guarantee. Workaround: return to the original device, then
use a live seat transfer to move to the new device.

**Two- and three-human games.** Strict agreement needs a certificate from the
old voter set. Without the absent voter, the remaining players cannot certify a
membership change, so the game waits. Changing this would need a weaker quorum,
which the 2026-09-25 decision rejected because one equivocating voter could then
certify conflicting histories.

**Abandoned-game cleanup.** An unfinished game may still be resumed by its
players; its local journal and voting safety records are what prevent this
device from signing conflicting history. Deleting them automatically could
remove a game a friend is waiting to continue, and the deletion design keeps a
tombstone for exactly this reason. The inactive marker plus confirmed removal
stays.

**Cheat consequences.** The protocol already refuses bad proofs and the end-game
audit checks hidden cards. Penalties (for example forfeiting a proven cheater)
change game outcomes and need a rules decision; the beta targets games among
friends.

## Changes made with this audit

- In-game chat: an on-board button under the game menu, with an unread count and
  a short preview of the newest message (`ChatLauncher.tsx`, `chat-unread.ts`).
  The panel scrolls to the newest message, shows an empty state, and keeps the
  message field and Send on one row on phones. Browser check:
  `apps/web/tests/online-chat.e2e.ts` (desktop host, phone guest).
- Recovered seats: the bot's host sees a board notice with the return action.
  The original device of a replaced player, when reopened, holds only its
  retired key; it used to report "This game stopped after an unexpected
  error". The session's retired status now carries `code: 'seat-retired'`
  (`session-types.ts`, `p2p-session.ts`), and the board explains that this
  device no longer plays the seat and how to get it back
  (`RecoveredSeatNotices.tsx`, `GameActions.tsx`).

## Defects found while verifying

- **Recovered bots never moved (fixed).** Since hosted bots moved to a worker
  (`10cff72`, 2026-09-29), a bot's RNG seed came only from the material
  present when the game opened. A bot activated later by a takeover had no
  seed, `decideBot` returned nothing and the game waited on that seat forever.
  The native takeover check, which last passed on 2026-09-28, reproduced it
  (stuck at the first recovered-bot turn). `hostedBotSeed` now gives such a
  bot a fresh local seed (`bot-runner.ts`, `bot-runner.test.ts`); its choices
  are still validated by every peer.
- **Browser checks drifted (fixed).** The transfer check read the room
  registry from the resource-timing buffer, which the grown app now overflows;
  it sets a larger buffer, as the takeover check already did.
- **Seat requests could be dropped (fixed).** A guest's "Take seat" request
  that raced another lobby commit (for example a name autosave or a settings
  change) was signed against an older lobby version; the host refused it as
  stale without a reply, so the click appeared to do nothing. The 2026-09-28
  readiness window only covers `setReady`. The host now answers every
  authenticated refusal with a signed `LOBBY_REJECT` (`stale-lobby`,
  `seat-unavailable` or `invalid-request`) after resending its snapshot. The
  guest re-sends a stale Take seat against the newer snapshot (up to three
  attempts) while the seat is still open. Otherwise it says the seat is gone,
  or after 10 s without an answer offers "Try again". The button shows
  "Taking seat…" while waiting (`lobby.ts`, `OnlineLobby.tsx`; `lobby.test.ts`
  "Take seat feedback", `OnlineLobby.seat.test.tsx`; DECISIONS 2026-09-30).
  The browser checks no longer retry the click.

## Browser checks run (2026-09-30, local signaling on 127.0.0.1:8909)

| Check                                                                            | Result              |
| -------------------------------------------------------------------------------- | ------------------- |
| `online-chat.e2e.ts` (desktop host, phone guest, landscape)                      | passed, 12.9–17.9 s |
| `online-takeover.e2e.ts` with `CP2P_ONLINE_TAKEOVER_RETURN_ONLY=1` (four humans) | passed, 2.2 min     |
| `online-transfer.e2e.ts` (transfer and certified cancellation)                   | 2 passed, 1.1 min   |
| `online-chat.e2e.ts` and `online-transfer.e2e.ts` after the seat fix, one click  | 3 passed, 1.1 min   |

The takeover check stops after the returned human's first certified command.
Its full form (second takeover, finish and three audits) was not rerun; the
[native takeover record](stage10/native-takeover-acceptance.md) holds the last
full pass. Screenshots of the new board notices and chat were inspected at
desktop, phone portrait and phone landscape sizes.
