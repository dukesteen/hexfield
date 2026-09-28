# Mixed-engine CI, 2026-09-28

[Run 36393894729](https://github.com/dukesteen/hexfield/actions/runs/36393894729)
tested commit `f520e83c48c814633ece9c36db2d21c376380a74` with two Chromium
contexts, Firefox and WebKit on Linux. Both connection modes failed before game
startup. This is not mixed-engine acceptance.

- Signaling seated all four humans, but the full-mesh check observed peer counts
  `[3, 2, 3, 2]`. The second Chromium context reported a connection error. The
  failure report retained only a boolean, so the transport cause is unknown.
- Manual relay failed before inviting the first guest. The test extracted the
  room's `startManualInvitation` prototype method and called it without its room
  receiver. Access to `this.manualOffer` then threw. The answer helper had the
  same receiver bug.

The corrected test calls both methods on the room instance. Failure diagnostics
now retain public connection errors, signaling state and peer connection/route
states. Peer statistics are collected only on failure so normal mesh polling
does not add RTC statistics work. No connection deadline or product transport
behavior changed. Scoped type-aware lint passes; the corrected CI run remains
pending.
