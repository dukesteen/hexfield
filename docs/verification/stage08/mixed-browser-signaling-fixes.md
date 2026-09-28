# Mixed-browser signaling fixes

Updated 2026-09-28. This records two failures from
[mixed-engine run 36400317716](https://github.com/dukesteen/hexfield/actions/runs/36400317716)
at `ca1b487`. Neither connection mode passed in that run. The fixes need a new
mixed-engine run before they count as browser acceptance.

## Overlapping description operations

The signaling mode produced an offer with `inReplyTo: 1`, generation 3 and
revision 2. The signaling validator correctly rejected it. Concurrent incoming
offers could both call `setRemoteDescription` and `setLocalDescription`; the
second call replaced the first call's unsent answer with an offer.

A focused polite-peer duplicate-offer test reproduced this against the original
source. It emitted two offers carrying `inReplyTo` instead of one answer. The
reproduction log is kept locally at
`/private/tmp/hexfield-peer-link-offer-race-before.log`.

`PeerLink` now serializes incoming descriptions and local negotiation. The queue
holds at most 16 operations, each with an SDP limit of 65,536 characters, and
copies description fields before waiting. Repeated local negotiation events are
coalesced. Initial answer-only eligibility is checked when the event arrives so
authentication during queueing cannot revive an ineligible startup event.
Closing the link prevents suspended work from sending an answer or offer.

ICE candidates remain independently bounded and can arrive while a description
is being applied. Duplicate queued answers cannot discard candidates for the
accepted answer. Generation, revision, reply binding, identity, fingerprint and
signaling-envelope checks remain enforced.

Focused regressions cover duplicate offers, local/remote overlap, duplicate
answers with early and late candidates, caller mutation, close during RTC work,
queue overflow, glare and renegotiation after an ICE restart. The transport
fixture drains one event-loop turn instead of assuming a fixed number of promise
callbacks.

The implementation received a read-only review. It found no remaining concrete
deadlock, glare or security issue; its suggested restart regression was added.

## Firefox end-of-candidates marker

In manual mode Firefox reached `local-description-set` and then failed with the
diagnostic hash for `Manual ICE candidate is malformed`. Firefox can emit an ICE
candidate object whose `candidate` string is empty. The collector treated the
object as a normal candidate and the strict SDP assembler rejected it.

Commit `3374ba5` treats an empty candidate string as the end of gathering, as it
already treats a null candidate. Nonempty candidates still receive the same
validation. The focused regression covers both host offer and guest answer with
an empty marker carrying `sdpMid: data`. All five manual-bootstrap tests passed.

## Verification

The combined focused run passed all 72 tests: 40 peer-link, 27 WebRTC transport
and five manual-bootstrap tests. Test TypeScript compilation and scoped
type-aware lint also passed. No native Firefox or WebKit process was launched
locally.

## Four-engine rerun

[Run 36402581103](https://github.com/dukesteen/hexfield/actions/runs/36402581103)
used `86acf16`. Both signaling and manual relay passed the four-context full-mesh
assertion, readiness and startup into the same game route. The Firefox manual
offer/answer sequence completed, and neither mode reported the malformed
signaling envelope from the previous run.

Both tests then timed out in `certifyPostSetupMove`, before terminal play. That
driver waited for all sessions to enter `main` while submitting only `setup`
commands. The engine ends setup in `preRoll`; reaching `main` requires the first
roll, which the driver only submitted after its wait. The corrected driver waits
for `preRoll`, then submits and certifies that roll. It also uses the production
pending selector so optional out-of-turn trades cannot displace required game
actions. Its total, setup and finish limits are unchanged.

Failure diagnostics now look up game rooms on game routes and report only public
phase, head, active seat, controlled seats and pending action kinds. The former
diagnostic used a lobby-only lookup after navigation, producing misleading
`roomOpen: false` reports. The corrected driver still needs a full rerun; this
result proves the mesh/startup assertions, not finished mixed-browser games.
