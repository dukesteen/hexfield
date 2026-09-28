# Mixed-engine full-game follow-up, 2026-09-28

[CI run 36422582118](https://github.com/dukesteen/hexfield/actions/runs/36422582118)
tested the full mixed-engine game on protocol v6 at
`21553e304bfe36f3a5005898c5fe6b0aba7dcccf`. The signaling-relay job passed;
the manual-relay job failed its bounded terminal-and-audit wait. No product
transport failure or peer divergence was reported.

At the end of the 150-second `finishAndAudit` poll, all four browsers still
reported playing at the same head, sequence 97 and hash
`1439d3d8582f8a7b01cd6fb219ff3f68a231abe36fb3d767fb848734ed210409`. The
reported turn was 21, phase `main`, active seat 0; result was absent and audits
were `not-started`. Every peer link was connected, the mesh was complete, and
`connectionError` was null. The last retained progress point was sequence 94,
turn 20, at 280.528 seconds relative to the test. The predicate requiring a
terminal result and complete audits did not become true before the unchanged
deadline. These diagnostics do not establish a deadlock or a transport fault.

The earlier progress record at sequence 88 and `verifying` phase belongs to a
different run and is not evidence about this run. This CI result leaves the
current-source manual-relay full-game gate open; the signaling-relay job passed
on this source. It makes no physical-device or deployed-server claim.

The [compressed public failure log and Playwright report](mixed-engine-followup-36422582118-artifacts.tar.gz)
preserve the sanitized CI evidence. SHA-256:
`6b1f9bc1964270a68cbd6bc2e50f713d0529983d9794ae165529381fcacffb64`.
