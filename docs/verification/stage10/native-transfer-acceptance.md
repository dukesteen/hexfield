# Native seat-transfer acceptance

The opt-in `apps/web/tests/online-transfer.e2e.ts` trace uses three isolated native Chrome contexts and the real local WebSocket signaling server. Two human devices start a verified game and certify the deck passes before the source invites a fresh third device. Browser contexts close in `finally`.

## Fresh-device handoff

The v5 trace certifies authorization and activation, opens the game on the destination, submits a legal setup move there, and waits for the survivor to certify the same head. The source has no controllable seat, and reloading it refuses its retired signing key.

The run passed in 21.6 seconds, recorded in `/private/tmp/hexfield-transfer-v5-retired-reload.log`. A fresh-Vite repeat with the final module lookup helper passed in 19.5 seconds, recorded in `/private/tmp/hexfield-transfer-v5-pristine-vite.log`. The helper imports the app's loaded room-registry URL to avoid inspecting a separate empty registry. The production worker ingress correction is in `3d4175e`.

The isolated Vite source was baseline `a06a309` plus worker ingress `3d4175e` and the six protocol files from `f2c99b7`. The handoff test SHA-256 was `b7c0a48f63d59494607b31171efddf0fa2429eee220e70fec9678ad95babcb27`.

## Certified cancellation and destination reload

The cancellation trace holds the destination's genuinely produced signed readiness artifact, certifies authorization, then uses the source's Cancel action. It checks cancellation follows authorization, releases readiness, waits for the destination receipt, and confirms the source retains its seat. A legal source move is accepted by the survivor at matching later heads. Reloading the destination must show the durable cancelled outcome without an Open game button.

This exposed a production bug: a finished destination waited for a source connection before displaying its already verified cancellation. The fix treats the finished browser record as a locator. The isolated worker resumes the exact durable attempt, verifies its terminal outcome, and the exchange checks the authorization and final head before showing it. Reconnecting only repairs a lost receipt; link failure cannot hide the verified result. Cancellation never promotes keys.

The fixed native trace passed 1/1 in 46.7 seconds, recorded in `/private/tmp/hexfield-transfer-v5-cancellation-terminal-reopen.log`. Focused browser and exchange tests passed 19/19. Test TypeScript, scoped type-aware lint, formatting and diff checks passed. The native assertions compare certified sequence order and equal heads; the run does not emit their numeric refs.

Frozen source hashes for the cancellation run:

- `online-transfer-browser.ts`: `5cd12741a854afb0f7eb8207a73b64c56b73601e50f9aeb98af13a37937463ad`
- `online-transfer-exchange.ts`: `765b9438cf957539f0c9b1a5c84d999c8270d94ed250fb5627d2c99d00062950`
- `online-transfer.e2e.ts`: `bbd693866fe804fe7e44bae025b210163cb98f51b6d5558b36ec4d055a069320`

These checks cover fresh-device handoff and cancellation on native Chrome. They do not establish post-takeover return, another browser engine, or remote deployed signaling acceptance.
