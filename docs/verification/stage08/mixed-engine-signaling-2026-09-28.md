# Mixed-browser signaling game passes; manual relay remains open

[Run 36405459968](https://github.com/dukesteen/hexfield/actions/runs/36405459968)
tested source `2d027c17a14caa99d872a6af1367accc41bb9365` on Linux with two
isolated Chromium contexts, Firefox and WebKit. The signaling job passed; the
manual-relay job failed. No local Firefox or WebKit process was launched.

## Signaling

All four peers formed the full mesh, completed the real signed startup ceremony,
placed their setup pieces, played to the configured victory and completed four
independent successful audits with identical final heads and results. The test
asserts each peer still has three authenticated links and no page errors.

The [summary](mixed-engine-signaling-2026-09-28/summary.json) records 20 post-setup
commands and terminal sequence 57, hash
`701be4612cad345da58317e13b9361c293bbba236afdcae114bfacd8be3654c9`.
The test took **239.632 seconds against its unchanged 240-second limit**. This
is a passing trace with little runtime margin, not a claim of stable timing.
The previous signaling attempt hit that same deadline.

This browser fixture retains its existing three-point victory setting. It proves
mixed-engine ceremony, networking, legal play, terminal agreement and audits.
The separate default-ten-point human, hosted-bot and recovered-bot traces remain
the evidence for full-length game compositions.

## Manual relay

All four humans joined. At failure the host and second Chromium peer each had
three authenticated links, while Firefox and WebKit each had two. WebKit's
remaining link to Firefox stayed at `have-local-offer`, local revision 1 and
remote revision -1. Firefox had no corresponding link and never sent an answer.
There was no invalid-signaling or failed-SDP diagnostic.

The room code permits a newly joined peer to learn existing seated peers before
those peers have admitted it into their own roster. Its early offer can therefore
be correctly discarded at the receiving admission boundary. The transport then
waits for the existing attempt deadline rather than retrying that initial offer.
This explains the recorded unmatched offer and motivates a bounded resend within
the same attempt. Unknown-roster rejection must remain intact. The fix and its
regressions are separate work; this result does not establish manual acceptance.

The [manifest](mixed-engine-signaling-2026-09-28/manifest.json) pins the original
public job logs as exact gzip-compressed bytes with raw and compressed hashes.
Diagnostics omit SDP, ICE candidate addresses, private hands and secret keys.
