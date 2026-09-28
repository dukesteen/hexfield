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
behavior changed. Scoped type-aware lint passed before the corrected run.

[Follow-up run 36395219426](https://github.com/dukesteen/hexfield/actions/runs/36395219426)
tested `bd95b4d5c24fb3730165edc2f4b6fe91b33c9576` and also failed before startup.
Manual relay connected and seated the first Chromium guest; the next Firefox
guest remained on the join page for the 45-second route deadline. The join form
reports a generic invalid-invitation message, so the underlying exception was
not preserved. Signaling connected both Chromium contexts to all three peers,
but Firefox and WebKit had only two peers each. Firefox reported `signal-error`,
which identifies an outbound signaling callback rejection, not a remote SDP
validation error. Its underlying cause is also not retained by that diagnostic.

The next run adds bounded test-only exception diagnostics for these two paths.
No timeout increase or speculative transport change is justified by this result.
