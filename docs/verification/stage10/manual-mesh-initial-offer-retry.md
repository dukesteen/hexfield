# Bounded initial offer retry

CI diagnostic run 36405459968 showed an admitted WebKit peer sending its first
offer before Firefox had admitted that peer. WebKit retained `have-local-offer`
at local revision 1; Firefox had no link and sent no answer. Unknown roster peers
must remain rejected, so the sender now retries its initial offer four times.

Retry delays are 250, 500, 1,000 and 2,000 ms, placing resends at 250, 750, 1,750
and 3,750 ms after the first send. Each reads current `pc.localDescription`, which
includes gathered ICE, and keeps the same signed attempt, generation and revision.
It performs no SDP setter, creates no new offer and sends no candidate burst.
Retries stop on accepted remote SDP, answer application, authentication, closure,
local revision change or exhaustion. Existing signaling limits, roster authority,
fingerprint checks and all connection/handshake deadlines remain unchanged.

The new genuine `WebRtcTransport` regression starts the lower-id peer before the
higher-id peer admits its roster. Admission alone does not initiate the higher-id
link. The [before-fix run](manual-mesh-initial-offer-before.log) fails because the
peers remain disconnected. With retry, both authenticate at the first scheduled
resend using an identical signed envelope body and attempt.

The final [focused run](manual-mesh-initial-offer-focused.log) passes 73 tests in
1.83 seconds across the complete peer-link and transport test files. It covers
latest gathered SDP, exactly four resends without renegotiation, exhausted timer
cleanup, accepted-answer cancellation, an answer held mid-application, direct
closure with a pending timer, and revision-change cancellation. The existing
availability-hint fixture drops all resends of its first two distinct attempts,
preserving its separate replacement-attempt assertion. The
[manual-bootstrap run](manual-mesh-initial-offer-manual.log) passes five tests in
91 ms. Shared test TypeScript checking, scoped type-aware lint, formatting and
diff checks pass. [Measurements and exact source hashes](manual-mesh-initial-offer-retry.json)
preserve the reviewed source.

This fixes the reproduced pre-roster offer race. It is not a passing mixed-browser
matrix: that requires a new native CI run. No local bundled browser was launched.
The mechanism does not retry an answer lost after its offer was already accepted;
duplicate accepted remote revisions remain rejected.
