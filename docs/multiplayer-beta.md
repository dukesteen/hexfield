# First multiplayer beta

The user narrowed the immediate release goal on 2026-09-27 to playing with friends without operating a server. This is a smaller release than the full M-C and M-D milestones. Their unfinished acceptance items remain open.

## What ships

- The GitHub Pages app creates and joins rooms through manually shared invitation and answer codes. Public STUN services help discover direct routes. A deployed Hexfield signaling service is optional and is not a release prerequisite.
- Two to four human players can play the base game, with existing hosted bots filling seats when wanted.
- Players can finish a game and inspect the result and audit.
- Closing and reopening the same browser profile restores the existing seat. Reconnecting can require another exchange of connection codes.
- A missing player is not replaced automatically. The game waits whenever the current agreement or private-card protocol needs that player.

The no-hosting requirement does not guarantee a direct connection through every router. The current app has no default TURN relay. If direct connectivity fails, the UI explains that a relay or another network is needed. A relay forwards encrypted traffic; browsers still execute and verify the game. External-network connectivity remains unverified in this beta; same-laptop browser checks cannot establish it.

## Work required before publishing

- Finish the current protocol-version integration and make beta rooms use the signed `never` takeover policy. Keep strict agreement and cryptographic validation.
- Expose the online entry point and make the manual create, invite, answer, join and reconnect flow clear. A failed startup must offer an honest recovery or fresh-room action without reusing retired secrets or discarding durable consent.
- Verify one current-version four-human game through the normal browser flow, plus a mixed human/bot case. Include a default-target completed game with successful audits, resource trades and development-card use across the focused checks.
- Verify same-browser close/reopen and reconnect, and safe waiting when a required peer is absent.
- Run the affected local checks and production build, publish the beta, and smoke-test the actual Pages routes and assets.

Use a small scenario matrix and retain the existing passing evidence. Do not run thousands of full games as a release gate. Add tests for a distinct failure or missing behavior, rather than increasing seed counts without a reason.

## Deferred

- Seat transfer, transferable private saves, fresh-device return and reclaiming a recovered bot.
- Automatic or voted takeover UI, certified presence timers and continuation after a required player permanently leaves. Completed protocol groundwork can remain, but beta users should not see unfinished controls.
- Chat, emotes, history statistics and automated abandoned-game cleanup.
- Automated cheat-evidence publication, penalties and the full fairness UI. Existing proof rejection and end-game audit stay enabled; this beta targets games among friends.
- Exhaustive cross-browser certification, QR camera scanning and invitation-size optimization. Publish the browsers actually verified.
- A connection check between separate physical devices on different networks. Record direct or relayed connectivity when devices are available; do not infer it from the same-laptop checks or claim general network compatibility before then.
- The eight-resource proof-performance target and broad statistical or simulation acceptance from the full milestones. Fix hangs and failed correctness checks; additional optimization can follow the beta.
- Deploying and operating a Hexfield signaling service or TURN service as a prerequisite for this release.

## Existing evidence

The [current browser check](verification/stage09/beta-browser-check.md) covers four-human protocol-v3 startup, all setup placements, dice, a player trade and same-browser reconnect in the Pages production build. The [v3 ten-point game](verification/stage09/beta-v3-game-check.md) completed 332 legal commands with two humans and two hosted bots, development cards, hidden steals and matching successful audits. These are local checks; external-network connectivity is unverified. The [M-C gap matrix](verification/stage09/mc-remaining-acceptance.md) preserves the broader milestone gaps.
