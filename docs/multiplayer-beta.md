# First multiplayer beta

The user narrowed the immediate release goal on 2026-09-27 to playing with friends without operating a server. This is a smaller release than the full M-C and M-D milestones. Their unfinished acceptance items remain open.

## What ships

- The app at [playhexfield.com](https://playhexfield.com/) creates rooms with hosted WebSocket signaling by default. Friends join through the invitation link. The GitHub Pages build retains manual invitation and answer codes. Public STUN services help discover direct routes.
- Two to four human players can play the base game, with existing hosted bots filling seats when wanted.
- Players can finish a game and inspect the result and audit.
- A guest's Take seat click always gets an answer: the seat, a re-sent request when the lobby changed at the same moment, a note that the seat was taken, or a retry offer when the host does not answer.
- Closing and reopening the same browser profile restores the existing seat. Reconnecting can require another exchange of connection codes.
- A missing player in a game with two or three humans is not replaced. The game waits whenever the current agreement or private-card protocol needs that player.
- Since protocol v6 (2026-09-28), which the [deferred-items audit](verification/multiplayer-deferred-audit.md) maps to code and evidence:
  - Signed chat in the lobby and the game, with five quick reactions and per-player mute. In a game, a chat button under the menu shows unread messages and previews the newest one.
  - Seat transfer: a player moves their seat to another device through a signed invitation that the current device approves. The old device's key is retired.
  - Full saves: export with optional passphrase-encrypted private material, and import as a read-only snapshot that can request a live transfer.
  - Takeover in games that started with four humans. The host picks the delay (default 120 seconds, or never) and whether players vote or it starts automatically. Certified offline markers and a connected quorum gate it. The remaining players then see the replaced player's hand.
  - Reclaiming a recovered seat: the device hosting the bot sends a return link from its board, and the returning player opens it on their original device to take the seat back with a new key.
  - Saved online games list statistics from audited games and mark unfinished games inactive after 30 days.
  - QR codes for invitations and manual codes, with camera scanning where the browser allows it.

The no-hosting requirement does not guarantee a direct connection through every router. The free-only deployment has no default TURN relay. Workers Free stops service when its allowances are exhausted; Cloudflare TURN is disabled because its traffic can incur overage charges. If direct connectivity fails, the UI explains that a relay or another network is needed. A relay forwards encrypted traffic; browsers still execute and verify the game. External-network connectivity remains unverified in this beta; same-laptop browser checks cannot establish it.

## Work required before publishing

- Finish the current protocol-version integration and make beta rooms use the signed `never` takeover policy. Keep strict agreement and cryptographic validation. (Superseded on 2026-09-27: new rooms default to a vote after 120 seconds; see DECISIONS, 2026-09-30.)
- Expose the online entry point and make the manual create, invite, answer, join and reconnect flow clear. A failed startup must offer an honest recovery or fresh-room action without reusing retired secrets or discarding durable consent.
- Verify one current-version four-human game through the normal browser flow, plus a mixed human/bot case. Include a default-target completed game with successful audits, resource trades and development-card use across the focused checks.
- Verify same-browser close/reopen and reconnect, and safe waiting when a required peer is absent.
- Run the affected local checks and production build, publish the beta, and smoke-test the actual Pages routes and assets.

Use a small scenario matrix and retain the existing passing evidence. Do not run thousands of full games as a release gate. Add tests for a distinct failure or missing behavior, rather than increasing seed counts without a reason.

## Deferred

Items that shipped since the first beta moved to "What ships" above. What remains:

- Returning to a recovered seat from a different device. The return request is signed with the seat's last certified key, which only the original device holds; a player can return there and then move the seat with a live transfer.
- Continuing a game that started with two or three humans after one leaves for good. Strict agreement needs the absent voter; the game waits.
- Automatic deletion of abandoned games. Unfinished games are marked inactive after 30 days and removed only on confirmation, because their records prevent this device from signing a conflicting history.
- Penalties for a proven cheater and publication of cheat evidence beyond the game's peers. Proof rejection, certified proof-failure display and the end-game audit stay enabled; this beta targets games among friends.
- Exhaustive cross-browser certification and a physical-camera QR check. Publish the browsers actually verified.
- A connection check between separate physical devices on different networks. Record direct or relayed connectivity when devices are available; do not infer it from the same-laptop checks or claim general network compatibility before then.
- The eight-resource proof-performance target and broad statistical or simulation acceptance from the full milestones. Fix hangs and failed correctness checks; additional optimization can follow the beta.
- A default TURN relay. The hosted app and signaling service are deployed on Cloudflare Free; TURN requires a verified provider-enforced zero-overage limit to meet the user's cost requirement.

## Existing evidence

The [current browser check](verification/stage09/beta-browser-check.md) covers four-human protocol-v3 startup, all setup placements, dice, a player trade and same-browser reconnect in the Pages production build. The [v3 ten-point game](verification/stage09/beta-v3-game-check.md) completed 332 legal commands with two humans and two hosted bots, development cards, hidden steals and matching successful audits. These are local checks; external-network connectivity is unverified. The [M-C gap matrix](verification/stage09/mc-remaining-acceptance.md) preserves the broader milestone gaps.

The [Cloudflare deployment record](verification/cloudflare/deployment.md) covers the custom domain, hosted signaling, free-only restrictions and live checks.
