# Native refresh and everyone-left checkpoint

Date: 2026-09-27. Native Chrome, two isolated browser contexts, local WebSocket
signaling and the development Vite server. The test uses a real signed two-human
game, WebRTC, worker sessions and IndexedDB. It submits legal commands through
the production session API and compares both peers' certified hashes.

`apps/web/tests/online-resume.e2e.ts` certifies setup moves, refreshes the next
player, and confirms its next move on the other device. It then closes every app
page and worker while retaining each browser context's IndexedDB. Reopening the
guest before the host restores the same seats and certified head. Another legal
move is accepted at the same head by both peers.

The corrected trace passed in 46.6 seconds. A follow-up run retaining the timing
artifact also passed in about 75 seconds. The saved public measurement is
[native-resume-measurements.json](native-resume-measurements.json).

The measured refresh restored the local board in 2,208 ms, but its next move was
accepted by the peer only after 32,827 ms. The three-second refresh-to-play target
is **not met**. Reconnection delay requires investigation. These development
server timings are not a production performance benchmark.

This verifies closed-page/worker recovery with retained browser storage. It does
not close the entire browser process, finish the game or exercise another browser
engine, mobile network or takeover. Contexts close in `finally`.
