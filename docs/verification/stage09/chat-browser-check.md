# Signed chat browser check

Date: 2026-09-27. Local Vite app at `http://127.0.0.1:5195`, Node signaling at
`ws://127.0.0.1:8909`. Two independent profiles, Chrome and the Codex in-app
Chromium browser, used their own device identities. Only test peers received
messages. This was a development build on one laptop and network, not a public
cross-network acceptance run.

## Observed behavior

- The host created a two-seat room and the guest joined its displayed invitation.
  Both names saved automatically, both peers took seats and readied.
- A guest lobby message appeared on the host. A host reply and reaction appeared
  on the guest. Muting hid the guest's prior message and suppressed a new reaction;
  unmuting restored the retained message.
- Both peers completed the signed ceremony and opened the same game. Each game
  chat dialog began empty, with no lobby message carried into its game history.
- Game messages traveled in both directions. The host reloaded its game. The
  guest used Save and leave, reloaded the home page and resumed the saved game.
  Both restored the two prior game messages and reconnected.
- A new guest message and host reaction arrived after restoration. No lobby
  history appeared in the restored game chat.
- At 390 × 844, the chat dialog and its controls fit the phone viewport. At
  844 × 390, the document stayed 844 × 390 and the dialog measured 512 × 352
  with its own internal scroll. The message field and Send remained reachable;
  a landscape message arrived on the host. No guest console warnings or errors
  were reported during the final check.

The coordinator visually inspected the lobby chat, portrait modal and landscape
modal. Browser tabs were closed, the viewport override reset and both temporary
servers stopped afterward. This check did not play the game to victory, measure
proof latency or exercise a physical phone.

The final small review fixes for receive-window jitter and roster changes were
covered by focused tests. Both saved-game paths and the final messages used the
reloaded implementation. The pinned review inputs and later corrections are
recorded in [the review disposition](chat-review-disposition.md).
