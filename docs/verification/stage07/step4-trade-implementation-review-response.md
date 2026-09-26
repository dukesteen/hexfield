# Trade proof implementation review response

The [review](step4-trade-implementation-review.md) found no Critical or High
issue. It found two reproducible timing problems and several smaller findings.
The [follow-up](step4-trade-followup-review.md) confirms F1-F4 are fixed and F5's
current-engine scenarios are unreachable. This does not complete Stage 07.

- F1: trade proof production now has its own per-peer work budget, permitting
  four distinct requests per ten seconds. The existing three-new-requests limit
  per finalizer and certified parent remains. This permits the initial request
  and three fresh-parent attempts without consuming snapshot or log-repair
  capacity. Successful responses still use their exact cached bytes. Unlike a
  permanent failed-request tombstone, the time window permits a new user attempt
  after a temporary private-source failure at the same parent.
- F2: a replica-side stale-parent result no longer ends preparation while the
  replica is saving/opening its new controller and the session still has the old
  head. The wait continues until the session publishes that head, then creates a
  new request. Two regressions hold this gap across five retry ticks; neither
  spends fresh-parent attempts on the old body.
- F3: timer and automatic-action priority is checked after proof arrival and
  again after local preparation. The ten-second deadline is also checked after
  preparation. A regression expires the timer between retry ticks, supplies the
  response, and confirms that no command reaches the replica.
- F4: planning catches local engine exceptions and returns
  `trade-proof-unavailable`. The receive paths do not strike the sender for this
  local failure. Tests cover both engine validation and application exceptions
  through request and response verification.
- F5: the suggested current-engine incompatibilities are not present. In
  `packages/engine/src/modules/base/trade.ts`, both offer handlers replace the
  previous offer by that proposer, so at most six offers can exist. `parseCounts`
  fills all five base resources, and `recipients` expands omitted recipients to
  explicit other seats while rejecting an empty list. The strict bounded parser
  and recipient check therefore remain. Commodity trading needs an explicit
  protocol extension when that engine module exists.

The review correctly distinguishes the wire-envelope tests from a real verified
trade. The live trace supplies actual consensus, private-source, replay and
direct-routing coverage; coordinator fixtures isolate cancellation and timing.
The network fixture uses two human hosts and verifies every destination and zero
broadcast calls. It is not a three-human privacy experiment.

The original live fixture reused an immutable byte-store implementation under
the steal-store name for deck contributions. Those interfaces have the same
`load`/`putIfAbsent` contract; a correctly named deck store removes that confusing
fixture wiring.

The strengthened live trace holds responses across three certified counter-offer
changes, producing four distinct parent-bound requests within ten seconds. Each
parent invokes the owner source exactly once; an identical retry uses the cache.
A late response from the first parent cannot finish the fourth attempt. Both
peers then restart before confirmation, regenerate the fourth response byte for
byte, and certify exactly one confirmation. Private hands and public commitments
match after another restore. Reducing the trade budget back to three makes this
same test fail at the missing fourth response, as recorded in the
[mutation run](step4-trade-budget-mutation.txt).

The follow-up's conditional N1 is not a defect in the current source.
`hand-transition.ts:verifyHandProof` already wraps its entire parse, context,
group decoding and verification path in a catch that returns `hand-proof-invalid`.
That file was present in the original packet but omitted from the timing-only
follow-up. A new regression signs a correctly shaped response containing an
undecodable group point and confirms rejection without a throw. An extra wrapper
would duplicate that existing exception boundary.

N2 and N3 describe intentional work limits. A temporary owner-source failure may
exhaust the current ten-second intent; the user can retry after the budget
window. Failed requests are not permanently blocked at the same parent. The
budget is shared by the human host's bot seats. Owner message handling cannot
enter the replica/session publication gap: `ConsensusController` awaits
`onEffects`, `persistCommit` calls `onCommit` before returning, and incoming
messages run through the same replica queue. The finalizer's independent retry
timer can enter that gap, which F2 now handles.
