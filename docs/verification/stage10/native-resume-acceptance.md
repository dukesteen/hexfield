# Native refresh and everyone-left checkpoint

Date: 2026-09-27. Native Chrome, two isolated browser contexts, local WebSocket
signaling and the development Vite server. The test uses a real signed two-human
game, WebRTC, worker sessions and IndexedDB. It submits legal commands through
the production session API and compares both peers' certified hashes.

`apps/web/tests/online-resume.e2e.ts` certifies setup moves, refreshes the
higher-ID responder and confirms its next move on the other device. It then
closes every app page and worker while retaining each browser context's
IndexedDB. Reopening the guest before the host restores the same seats and
certified head. Another legal move is accepted at the same head by both peers.

The trace passed in 18.2 seconds. The saved public measurement is
[native-resume-measurements.json](native-resume-measurements.json). Refresh
restored the local board in 2,277 ms; the peer accepted the next certified move
in 2,438 ms. This single local trace meets the three-second target. It is not
a production or cross-device performance benchmark.

The earlier trace took 32,827 ms to accept that next move. The survivor could
send its signed offer before the refreshed responder had subscribed to
signaling. It then waited for the old attempt to expire. Resumed rooms now
observe signaling presence and retry a pending offer when an already-admitted
peer returns. Presence never adds a peer, replaces an authenticated link or
overrides a manual/security block. Retries are rate-limited and keep the signed
offer and replay checks. The 31 focused transport and room cases pass.

Source hashes for the passing trace:

- `packages/p2p/src/web-rtc-transport.ts`: `78488cc6de2a2c06124a0368a6780ec4ff4a73b4caf5e8a2af34a38f70152dca`
- `apps/web/src/session/online-room.ts`: `0e1281cb5241eada8dddd13100423f9813ea16bea730d36c49d3dd5be17f379e`
- `apps/web/tests/online-resume.e2e.ts`: `eb33e92606a3247d4eae971c505e9ee4651399b401459dbfb15864789e54462b`

This verifies closed-page/worker recovery with retained browser storage. It does
not close the entire browser process, finish the game or exercise another browser
engine, mobile network or takeover. Contexts close in `finally`. The working tree
included the optional vault's default-off storage hooks; vault-enabled storage
was not exercised by this browser trace.
