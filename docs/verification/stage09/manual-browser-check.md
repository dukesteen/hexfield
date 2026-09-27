# Manual lobby, saved-game resume and finished-game browser check

Date: 2026-09-27. Local development build, two native Chromium tabs in the in-app
browser, using `localhost:5187` and `127.0.0.1:5187` for separate browser storage
and device identities. Both tabs ran on the same laptop and network. No signaling
server was configured. This is a focused integration check, not Stage 08–10
acceptance.

## Observed

- The host created a four-seat room with a three-point target, then added two
  RandomBots. The offer was 1,154 characters; the guest's answer was 1,102. The UI
  rendered a QR code plus copy/share controls and warned that these dense codes
  can be pasted instead. No phone camera scan was attempted.
- After the host entered the answer, the guest received the host's signed lobby.
  The guest took the remaining seat, changed its name, and readied. The host also
  readied, then started the game through the normal UI.
- Both players reached the same game route and board. Human settlements and roads
  were selected and confirmed on the board; the other browser displayed the
  resulting points and remaining pieces. Both hosted bots also placed their
  pieces. Setup completed and the first turn produced a last-roll total of 11.
- Closing the guest tab made the host show that player as reconnecting. Opening
  the same saved-game route in a new guest tab restored the board, both humans'
  two public points, the last roll, and the guest's private hand of one wool and
  two ore. The restored game correctly waited for a connection to the host.
- No warning or error appeared in the browser console during these steps.

## Reconnect correction and retest

The returning guest generated a targeted reconnect offer, but the surviving host
could not produce an answer. Inspection found that a closed manual bootstrap
bridge can remain registered in the mesh adapter and reject a replacement bridge
for that peer. The correction unregisters closed bridges immediately and guards
ownership during concurrent acceptance and cancellation. Pending answers also
expire to a retryable state after a bounded five-minute interval. The three
focused manual/transport/room test files pass 30 tests.

The development server was restarted after checking that it was serving stale
module transforms. Its served source was then checked for the new five-minute
deadline, close observer and reconnect UI before retesting. Both players reopened
the saved game and exchanged targeted codes; the host then certified another
dice roll. With the host left running, the guest was closed again and reopened.
The host displayed it as reconnecting, accepted its new targeted offer and
generated an answer. Both peers reported connection restored. The host ended its
turn, and the guest received the roll-dice action. This repeats the previously
failing surviving-host path and establishes gameplay after reconnect.

## Finish and audit

The reconnected guest rolled and ended its turn. The hosted bots continued,
and Bot 4 built its third settlement to reach the configured three-point target.
Both browsers opened the results dialog and independently displayed
`Game audit passed` for the same winner. Both showed the same five-roll histogram:
5 once, 6 once, 8 twice and 11 once. Both also showed resource-production totals
of Avery 1, Blair 3, Bot 3 3 and Bot 4 7. Neither console reported a warning or
error. The results and passed-audit messages were rechecked in both retained tabs.

This completes the manual-code create, join, start, play, close/reopen, reconnect,
finish and audit path for two humans with two host-owned bots in a shortened
game. It does not compare exported log hashes or establish the signaling-server,
four-human recovery, different-browser or different-network paths.

The check also found and corrected a results-display defect: each browser showed
a complete score only for locally owned seats, even after the successful audit.
The audit report now supplies reconstructed hidden-VP counts only after complete,
successful verification. After closing and reopening each finished game, both
browsers displayed Bot 4 at 3 VP and all other players at 2 VP, with no unknown
totals. Both again displayed `Game audit passed`, using the saved certified
history without a new peer connection. Focused audit, worker and session-store
tests cover the boundary between private in-game cards and verified final scores.

## Remaining verification

The browser automation's reload operation left the original tab alive; closing
and reopening a tab was used for the durable restoration check. Neither operation
provides a valid measurement for the plan's three-second refresh-resume target.

No cross-network connection, four-browser mesh, Firefox or WebKit run, phone
scan, or takeover is established by this check. The offer sizes also exceed the
plan's less-than-700-character target.
