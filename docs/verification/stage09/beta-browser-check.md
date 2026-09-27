# Four-human beta browser check

Verified on 2026-09-27 with the Pages production build, served under `/hexfield/`.
The build used `GITHUB_PAGES=true pnpm --filter @cp2p/web build`. Four native
Chromium tabs used separate origins and browser storage on the same laptop:
`localhost:5188`, `127.0.0.1:5188`, `127.0.0.1:5189`, and `127.0.0.1:5190`.
This is not four different browser engines or an external-network test.

The host opened the new Play with friends action on the home screen and created
a four-seat room using the default ten-point target. All three guests joined by
exchanging offer and answer codes with the host. No signaling server or TURN
relay was configured. The existing mesh connected the remaining peer pairs.
The lobby showed four of four human players connected, and guests could inspect
the read-only signed settings before readying. The beta room displayed the
disconnect policy and used the signed `never` takeover setting.

All four browsers completed the protocol-v3 ceremony and navigated to the same
game, `Pb590TjiEUmHPvi6CXcaaz`. The normal board UI accepted and confirmed all
eight settlements and eight roads in setup order. Placements appeared on other
peers, and second placements produced the correct private starting hands.

The first shared roll was 3 + 2 = 5. Blair offered one ore for one grain to Avery
through the card picker. Avery's board overlay showed the incoming ore and
outgoing grain. Avery accepted, Blair selected Trade with Avery, and both hands
updated correctly. Blair then held one lumber, one grain and one ore.

Closing Blair's tab made the other clients show that Blair was reconnecting.
Opening the saved game in the same browser origin restored the board, last roll,
seat identity and that exact three-card hand. A targeted manual code exchange
with Avery restored connections to all three peers. Blair ended the turn, Casey
received the next turn, and another shared dice roll completed.

All four tabs had empty warning/error console logs at the end of this sequence.
The coordinator inspected the production board and home-screen layouts. No
development tools appeared in the production build.

This check covers native four-human startup, public move replication, private
card trading and same-browser reconnection. It does not claim a completed native
four-human game, phone or cross-network connectivity, Firefox/WebKit acceptance,
or a measured sub-three-second resume. The separate
[default-target real-crypto game](beta-v3-game-check.md) completed and passed
independent audits at ten victory points.
