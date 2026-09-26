# Automatic victory review response

The user approved project reviews. Both reviews ran with tools disabled against
the exact source packets in the adjoining manifests. No production credentials
or actual game secrets were sent.

## Initial review

The [first review](step3-victory-review.md) identified three recovery issues.
Command preparation exceptions now return a pre-admission failure, allowing the
automatic caller to retry. Ordinary actions for the owning seat wait for its
automatic claim. Retry diagnostics notify listeners, and a certified commit
clears stale rejection status. A listener that disposes the session cannot cause
a retry timer to be armed afterward.

The retry tests check both sides of each delay boundary, including the four-second
cap. The real encrypted victory-card test checks the exact certified parent,
one claim in each history, two signatures, and private-slot consumption.

## Follow-up review

The [follow-up](step3-victory-followup.md) found no defect in the public validation
caches. Its key, mutation, context and authority analysis agrees with the local
implementation checks.

- F1 is conditional and does not apply to the base engine. `withClaim` in
  `modules/base/shared.ts` adds `CLAIM_VICTORY` outside setup. The discard,
  move-robber and road-building pending handlers use it. The existing
  `robber-timeout.test.ts` explicitly checks a pending claim while another seat
  owes a discard. Removing the automatic-action guard after a local proof failure
  would let end turn preempt a winning claim, so that suggestion is not adopted.
- F2 is fixed. Automatic-input lookup failures return empty legal actions and
  `automatic-input-unavailable` from manual validation/submission. They no longer
  escape to the view. The guarded background lookup retains its retry diagnostic.
- F3's comment now accounts for failures while scheduling recovery. The fallback
  clears the memoized parent and notifies listeners, allowing later session
  activity to try again.
- F4 is fixed. A failing subscriber cannot overwrite an existing rejection or
  halted diagnostic. A focused regression retains the original proof failure.

Default-suite regressions now observe that repeated setup validation skips point
decoding and repeated unlock verification skips DLEQ work. Altered signatures
still fail after a cache hit. Existing warm-cache tests reject changed setup
points, definitions, contexts and re-signed false proofs. The bounded eviction
loops have been inspected; no extra test hooks are exposed by production code.

Three subsequent isolated draw measurements use independent module graphs and
verification caches per peer. All pass the unchanged one-second target at
965.1–991.5 ms. This replaces the earlier shared-cache diagnostic as the local
performance evidence. The optional CPU profiler uses the platform temporary
directory. The three-human relay and second-draw tests pass; additional roster
and control-interleaving cases remain open.
