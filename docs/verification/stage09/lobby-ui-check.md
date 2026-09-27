# Online lobby UI check

Checked the new create/lobby routes in the existing native Chrome session on 2026-09-27, using the local Vite server on port 5187 and signaling server on port 3009. No separate Playwright or Firefox process was launched.

The host created a disposable room through the form. The lobby reported a connected signaling service and one of one human players connected. Adding a bot updated the seat immediately. Ready up changed the host to ready; saving a changed victory-point target reset readiness. Copy invitation reported success. Navigating home opened the leave confirmation, cancelling preserved the room, and confirming leave returned home and released the room connection.

The start button stayed disabled because the secure ceremony and gameplay handoff are not connected yet. The home screen still exposes only local play. This check covers one host's UI over a real signaling connection; it does not verify another device joining, an online game, browser resume, or the later mobile/color corrections.

The focused lobby, seed, signed-binding and room-registry run passed 14 tests in 2.08 seconds before the protocol-version migration. The game-transport adapter subsequently passed its three focused tests and the web typecheck. These are component checks, not milestone C or D acceptance.
