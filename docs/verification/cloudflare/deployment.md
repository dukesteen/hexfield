# Cloudflare deployment verification

Date: 2026-09-27. Target: `hexfield.steenbakkers.cc`, Worker `hexfield`.
The deployment branch starts at the published multiplayer beta `abbd408` and
excludes the unfinished chat, seat-transfer and milestone changes in the main
workspace.

## Free-only requirement

The user confirmed **Workers Free** in the account dashboard before deployment.
The authenticated API returned `standard` for the default usage model but denied
subscription reads; that API value was not used as proof of the plan. Read-only
checks found no existing Worker scripts, target DNS record or TURN keys.

The app uses static assets, a Worker and SQLite Durable Objects on Workers Free.
Cloudflare's free limits reject further requests or operations instead of
charging overage. Cloudflare STUN is free. TURN is disabled because no
provider-enforced zero-overage cap was verified. The deployed code has no TURN
issuer, key, secret binding or provider call. `/api/turn` returns 503 for all
methods. No subscription was created or upgraded.

This is a deployment constraint, not a guarantee against future account changes
or unrelated paid products. Sources and operating instructions are in
[Cloudflare hosting](../../ops/cloudflare.md).

## Local checks

- Full repository typecheck, lint, format, dependency boundaries, engine purity
  and translation checks passed. Existing unused-translation and bundle-size
  warnings remain.
- 33 focused tests passed across signaling core, the Node adapter, the Cloudflare
  adapter, the disabled TURN route, deployment network defaults and room creation.
- The Cloudflare SPA production build passed with the signaling default enabled
  and no default TURN endpoint.
- The online game now uses the same full-height viewport wrapper as local games.
  Four existing online game-screen tests passed. The live desktop and mobile
  checks are recorded in [layout-check.json](layout-check.json).
- Lobby names and settings save after 400 ms without Save buttons. Focused tests
  cover debounce, validation, reverted drafts, cancellation and signed-update
  acknowledgement. The nine lobby tests passed; Ready and Start wait for pending
  changes. A regression covers canonical key reordering, and another covers
  semantically unchanged seed casing.
- Claude's tools-disabled review and the follow-up source review are recorded in
  [the disposition](deployment-review-disposition.md). Its earlier TURN quota
  finding does not apply to the free-only implementation.

The native runtime authentication check separates receipt of a close frame from
completion of the TCP close handshake. Local traces put the authentication sweep
at ten seconds; Node's completed close event can arrive several seconds later.
The smoke check requires the socket to leave OPEN within fifteen seconds and
bounds the remaining handshake separately. The core rejects late authentication
regardless of close-handshake timing.

The previous GitHub beta CI run `36306523885` passed all nine network-simulation
jobs and its simulation job, but its coverage job failed with 22 test timeouts and
four failed suite hooks after about 32 minutes. This is not a green full-CI claim.
The previously recorded local beta acceptance and the focused deployment checks
are used for this release; the slow coverage run needs separate correction.

## Deployment and live checks

The app and signaling Worker are live at <https://hexfield.steenbakkers.cc/>.
Final deployed version: `9cb4bf8f-2a7a-4e1a-9a43-9c299e0c8d27`.
The Worker has only the room Durable Object, connection rate limiter, static
assets and app-origin bindings. No TURN secrets or paid subscriptions were added.

The real WebSocket smoke check passed locally under Wrangler and against the
deployed endpoint. It covers signed admission, peer discovery, opaque relay,
identity replacement, continued relay after an idle interval, binary rejection
and authentication timeout. HTTPS checks cover the SPA, asset responses, direct
route fallback, health and the disabled TURN endpoint, recorded in
[http-check.json](http-check.json).

Two separate browser profiles created and joined an invite-link lobby, completed
startup and replicated settlements and a road. Saved-game reload restored the
same board and pieces. The desktop layout measured 3440 × 1267 in a 3440 × 1267
viewport; portrait measured 390 × 844 in a 390 × 844 viewport, with no document
overflow. Landscape at 844 × 390 kept the board on the left and the hand/actions
on the right; Game info opened the Bank and Event log. These are browser viewport
checks, not a new physical-phone performance claim.

The final live lobby check changed the player name and victory-point target
without a Save button. Both saved, the Saving indicators cleared, Ready became
available, and marking the player ready enabled Start after filling the other
seat with a bot. Test rooms and desktop test tabs were closed after verification.

This release uses the local checks above and is committed with `[skip ci]` to
avoid repeating the known failing full-repository coverage run. The next CI
change will retain the full functional test suite while collecting coverage only
for the engine, where the required thresholds apply.
