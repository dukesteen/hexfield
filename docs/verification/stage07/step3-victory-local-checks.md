# Automatic victory and deck performance checkpoint

Automatic victory claims now retry a rejected local attempt at the same certified
parent, starting after 250 ms and doubling to a four-second maximum interval.
Accepted commands stay pending without another submission. A new commit resets
the retry; disposal cancels it. Ordinary actions for the winning seat wait for
its automatic claim, including during a temporary proof failure.

The real encrypted-card regression uses legal play, a three-point target and a
privately dealt victory point. One injected reveal-source failure leaves the
owner's card and certified parent intact. A manual end-turn attempt is rejected.
At 250 ms, both peers certify one claim against the deal's exact parent and agree
on the winner. Only the owner had the private card, and its consumed slot is gone.

## Performance evidence

The [independent-peer draw trace](step3-draw-independent-benchmark.txt) records
three isolated samples of 991.5, 974.3 and 965.1 ms. Each measures submitting
`BUY_DEV_CARD` until both peers certify `CARD_DEALT`, including real cryptographic
work, memory-backed durable preparation, consensus and 50 ms links. Each peer
loads its own module graph and verification caches. Legal setup and restoring the
certified pre-purchase prefix are outside the interval. The run uses two humans
and two hosted bots. The median is 974.3 ms; the worst sample has only 8.5 ms margin
against the unchanged one-second target. This is local evidence, not a browser
latency guarantee or a measurement of larger rosters.

Run the opt-in benchmark separately from CPU-intensive work:

```sh
CP2P_DRAW_BENCH=1 pnpm exec vitest run packages/protocol/src/deck-replica.test.ts -t 'certifies a full draw within one second' --maxWorkers=1 --minWorkers=1
```

Ordinary test runs intentionally skip this wall-clock benchmark. Setting
`CP2P_DRAW_PROFILE=1` also writes one `cp2p-draw-profile-N.json` per sample in the
platform temporary directory.

Before optimization, the corrected timing method measured 5,874.4 ms. The profile
attributed about 4.5 seconds to repeated public deck setup validation. A bounded
cache of successful validation for the complete public setup reduced the draw
to 1,304.7 ms. Caching successful verification of the exact DLEQ statement, proof
and context then produced the earlier
[987.9 ms diagnostic](step3-draw-benchmark.txt), which shared caches between peers.
Neither cache retains mutable results or failures. Canonical parsing and all
state, signature, ordering, engine, policy and outbox checks remain. The three
new samples address that shared-cache limitation.

Two fresh dedicated workers in headed Chrome for Testing 153.0.8010.12 measured
2,298.3 ms and 2,173.8 ms for all six sequential 25-card shuffle proof and
verification passes. Including all six locking passes, totals were 2,641.0 ms and
2,538.5 ms. Both runs used the current production bundle and produced the exact
retained transcript and state hashes. The [raw results](step3-chrome-current.json),
[source and run metadata](step3-chrome-current-metadata.json) and
[runner](step3-chrome-current.source.txt) record the measurements. The coordinator
independently checked the source hashes. Chrome and the temporary server closed
cleanly; no Firefox or WebKit process was launched.

The earlier 16.5-second Chrome result remains in
[the original diagnostic](step3-chrome-worker.json). The
[intermediate headless comparison](step3-chrome-comparison.json) also passed, but
may have overlapped another crypto test. The final headed runs had a reserved
timing window. The earlier discrepancy is unexplained; these measurements do not
establish performance on every machine. The 64-round shuffle proof and its bytes
are unchanged.

## Local verification

The final `pnpm check` passes all 749 tests in 130 files, with the opt-in timing
benchmark intentionally skipped. Type checks, lint, formatting, dependency
boundaries, purity and translations pass. The test suite takes 94.37 seconds;
`pnpm build` also passes. Focused session tests pass all 19 cases and deck setup
and draw tests pass all 23 cases.

The [source manifest](step3-victory-source-manifest.json) covers 193 engine,
codec, crypto and protocol source/test files. Its fingerprint is
`c9021225c8f1f55613c7810418072982929ddcd7bcf398056227578d4b6ae60f`.
The [check log](step3-victory-check.txt) and [build log](step3-victory-build.txt)
retain the final results. No source file changed during the gate or build.
The [review response](step3-victory-review-response.md) records the corrections
made after the two read-only source reviews.

A three-human delivery test drops the first direct unlock prefix to the third
peer. It verifies a longer relayed prefix, all three certificate signers, equal
certified heads, one consumed deck position and owner-only private recovery.
It passes in 21.48 seconds. A two-human test also plays the first Knight, legally
buys a second card, and checks the distinct deal positions and private ownership.

The relay helper now observes both an active draw and an already certified deal.
Previously, a deal completed inside network settling, the helper missed the
transient active state, and it continued playing until timeout. Its legal setup
is now a fixed short trace; its input limit is 100 instead of 500. No additional
random game batch is needed for these delivery assertions.

## Remaining scope

Step 3 still needs the remaining roster and adversarial delivery cases, including
proposer control during an active draw. Stage 07 still needs resource
commitments, hidden steals, escrow, audit and full-game cryptographic acceptance.
WebRTC, the lobby and browser recovery remain stages 08–10. This checkpoint does
not expose a production online mode or complete milestones C and D.
