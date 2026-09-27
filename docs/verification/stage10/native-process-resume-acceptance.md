# Browser process restart, final audit and history

Verified 2026-09-27 with native Chrome and protocol v5, using an isolated checkout
of `2d01049c1971de6bd382d99247e4a80c65e8b874` plus the extended
`apps/web/tests/online-resume.e2e.ts`. Its dedicated Vite server used port 5296
with `CI=1`, so Playwright could not reuse another development server. Local
WebSocket signaling used port 8909.

The test created a real two-human room through the server invitation UI, started
a three-point game, and certified setup moves. It refreshed the higher-ID
responder, restored that seat and accepted its next move on the other peer.
It then closed both independent Chrome processes and relaunched their original
disk profiles in reverse order. Both restored the same certified head and seats,
then certified another legal move.

The test completed 122 further legal commands through the production session API
and actual workers/WebRTC. Both peers reached turn 25, winner seat 0, and certified
head 163. Both independent final audits were complete and successful, with no
violations, missing seats, input errors or cheat findings. Each player used Save
and leave; both Home views showed one verified game and one game played.

The full test passed in 1.1 minutes. Refresh restored the local head in 2,369 ms
and the next move was accepted by the other peer in 2,577 ms. This meets the
three-second target for this local sample. The
[public measurements](native-process-resume-measurements.json) contain certified
hashes, the terminal result and the audit, with no private keys or hands.

Earlier attempts accidentally reused a server belonging to the redesign
worktree on port 5198. Their missing-history result and timing do not describe
this checkout and are excluded from acceptance. The opt-in resume test now
disables server reuse even outside CI.

This check covers the default-off vault, two Chrome peers and local signaling.
It does not establish mixed-browser, mobile-network, takeover, encrypted-vault
or full ten-point game acceptance. The three-point finish is deliberate and
keeps the restart/audit/history check bounded. Profiles are removed after both
processes close.
