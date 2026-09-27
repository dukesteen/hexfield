# First multiplayer beta release

Published on 2026-09-27 at 08:33 UTC to
[Hexfield](https://dukesteen.github.io/hexfield/).

The deployed source is
[`7ec176d8c27a95101ce30bd1c500021b0dadb414`](https://github.com/dukesteen/hexfield/commit/7ec176d8c27a95101ce30bd1c500021b0dadb414).
The [manual publication workflow](https://github.com/dukesteen/hexfield/actions/runs/36306532663)
completed both build and deploy successfully. It verified the exact commit
against the supplied local-verification revision before building.

The release uses the [local checks](beta-local-check.md),
[four-human browser scenario](beta-browser-check.md) and
[completed v3 ten-point game](beta-v3-game-check.md). Normal CI runs separately;
this record does not claim that its longer test and simulation jobs have passed.

## Published-site check

The native Chromium browser loaded the actual GitHub Pages URL and showed
Play with friends, Join a game and New local game. The create-room route loaded
with code exchange selected by default and a ten-point target.

A temporary room was created through that form. Its lobby showed the host,
open seats, settings and the policy that disconnected players keep their seats.
Create offer code generated a complete invitation and QR graphic. Cancelling
the invitation and leaving the room returned to the home screen.

Join a game loaded the invitation form. Reloading its `#/join` URL loaded the
same form without a 404. The browser reported no warnings or errors. The home
screen remains open as the user-facing result.

This is an entry-route and invitation-generation check on the live deployment.
The multiplayer gameplay checks ran against the Pages production build locally;
they are not evidence of a live cross-network game.

## How to play and current limits

The host chooses Play with friends and Exchange codes, then creates an offer
for one friend. That friend chooses Join a game, pastes the offer and sends the
answer code back. The host pastes that answer and connects. Repeat for each
friend, fill any remaining seats with bots, then have everyone ready up.

No Hexfield signaling server is required for this flow. The app uses public
STUN, and there is no default TURN relay. External-network connectivity remains
unverified and direct connections can fail on restrictive networks.

Same-browser saved-game restoration and manual reconnection are supported. Seat
transfer, return after bot recovery and takeover UI are deferred. Full M-C and
M-D remain incomplete, as recorded in the [beta scope](../../multiplayer-beta.md)
and [M-C gap matrix](mc-remaining-acceptance.md).
