# Mixed-engine startup wait

[Manual-only run 36424809148](https://github.com/dukesteen/hexfield/actions/runs/36424809148) ran at `f81a05b` after the [bot driver correction](mixed-driver-local-checks.md). Build, browser installation and signaling startup passed. The test stopped during mesh startup after 37.5 seconds overall. Its final mesh poll used Playwright's default five-second limit and observed peer counts `[3, 2, 2, 3]` instead of the required `[3, 3, 3, 3]`.

Chromium-B and Firefox lacked their mutual connection. Firefox retained an unanswered offer with ICE `new`, signaling `have-local-offer`, local revision 1 and remote revision -1. The other five links were authenticated and connected. No connection error was reported. The game never started, so this run supplies no result for the corrected bot driver, gameplay or audits. The diagnostics show repeated outgoing offers, but do not establish whether the remote peer received them.

Production relay negotiations use a 30-second attempt timeout and a 250 ms minimum retry in [WebRtcTransport](../../../packages/p2p/src/web-rtc-transport.ts). [PeerLink](../../../packages/p2p/src/peer-link.ts) allows ten seconds for HELLO after a channel opens. OnlineRoom uses those defaults for its mesh links. The five-second test wait could interrupt this existing recovery path before it had time to finish.

The final mesh poll now has an explicit 45-second limit and still requires all four peers to report exactly three connected peers. The existing 240/300-second overall limits, 150-second play-and-audit limit, 300-command cap, game rules and production connection code are unchanged. This correction does not prove that the missing link recovers. The next bounded run must demonstrate recovery or provide a later failure to investigate; another timeout increase is not justified by this trace.

The [raw public log, run metadata and failure report](mixed-mesh-wait-36424809148.tar.gz) have SHA-256 `258aee5c47104b918d4630d37330e90c9195de73d69d0f949afc0bd2201aaa0e`.
