# Native lobby connection check

On 2026-09-27, the existing Chrome session passed
`http://127.0.0.1:5187/dev/lobby-smoke.html` against the local signaling server on
port 3009. No Firefox, WebKit or Playwright browser process was launched.

The page creates three `OnlineRoom` clients with separate in-memory test identity
stores. Each uses native WebSocket, RTCPeerConnection and browser writer leases.
All clients discover and authenticate the other two peers. Two guests take
seats, the host adds a bot, and every human signs the same frozen configuration
and fresh ceremony nonce. The check closes every room afterward.

Chrome displayed:

```text
PASS three clients discovered and authenticated every native peer link
PASS two guests took seats and the host added a bot
PASS every human signed the same configuration and fresh ceremony nonce
PASS closing observers reuse the same completed cleanup
PASS lobby connection check complete
```

The first native run found a real startup race. The guest sent its only lobby
request before WebRTC authentication completed, and the failed send had no retry.
The controller now retries a signed hello on authentication and on a bounded
timer. A focused test covers both an unauthenticated send failure and a dropped
authenticated request. Five lobby tests pass.

The check also reproduced a cleanup recursion when a view called `close()` while
handling the closed notification. The room now assigns its cleanup promise before
notifying views. The native regression requires the nested call to return that
same promise and the view to receive exactly one closed notification.

This verifies three clients in one page on one computer. It does not verify
independent browsers, NAT traversal, a deployed signaling server or a finished
online game. The production create/join screens, game ceremony and session
handoff are still unfinished. No Stage 09 acceptance box is checked.

## Reproduce

Start the signaling service on loopback port 3009 and Vite on port 5187. Open the
page above in Chrome and click **Run lobby check**. Each asynchronous condition
has a 15-second deadline. Failures display public lobby state and connection
diagnostics, without private keys.
