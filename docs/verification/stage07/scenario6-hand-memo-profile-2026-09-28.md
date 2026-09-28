# Public hand-point memo measurement

The bounded public hand-commitment cache in `b11751a` reduced its measured
validation cost and increased certified progress in the same 60-second verified
scenario 6 diagnostic. This is one before/after pair over early prefixes, not
terminal acceptance or a guaranteed speedup across seeds, devices or later play.
The 900-second acceptance deadline remains unchanged.

Both runs used seed 42, game index 0, parallelism 1 and a 60,000 ms diagnostic
limit under Node v25.9.0 with CPU profiling. All 263 compiled JavaScript/lock
hashes matched before and after the second run; its broad source fingerprint
also remained unchanged. Compared with the baseline, the only changed compiled
file was `packages/protocol/dist/hand-commitments.js`.
The [manifest](scenario6-hand-memo-profile-2026-09-28/manifest.json) pins the raw
local profile, command and archived artifacts. The
[comparison](scenario6-hand-memo-profile-2026-09-28/comparison.json) includes
weighted sample costs, caller breakdowns and runner timings.

| Measurement                                               |           Baseline |          Hand memo |
| --------------------------------------------------------- | -----------------: | -----------------: |
| Stop time                                                 |       60,038.64 ms |       60,044.99 ms |
| Certified revision                                        |                 95 |                116 |
| Turn                                                      |                 18 |                 22 |
| Hand commitment validation, inclusive sampled time        |            9.647 s |            0.258 s |
| Point decoding, inclusive sampled time across all callers |            8.208 s |            2.113 s |
| Canonical encoding, inclusive sampled time                |           19.394 s |           23.502 s |
| Genesis digest, inclusive sampled time                    |            8.112 s |            9.810 s |
| Actor export, runner timing                               | 0.552 s / 75 calls | 0.785 s / 96 calls |

Certified progress increased by 21 entries (22.1%) within the same diagnostic
budget; sampled hand validation cost fell by 97.3%. The second run performs more
work and reaches a different final operation, so total encoding/digest costs are
not a comparison at an identical certified prefix. Inclusive costs overlap and
must not be added together. Neither run reached a terminal result.

Canonical encoding now occupies about 38.9% of sampled time. Genesis digest
computation occupies 16.2%, including 3.826 seconds beneath
`resolveArtifactSigner`. These remain measured targets, not approved cache
changes. That function accepts arbitrary genesis/authority input and checks their
binding; substituting the authority's own digest would make that check circular.
An exact canonical-content digest memo could preserve mutation detection, but it
would still encode every body and would save only hashing. Reusing a digest from
an already verified context would require an explicit trusted boundary and tests
showing that altered genesis or controller authority still fails closed. No
mutable-object genesis cache, context guard shortcut or broad cache change was
implemented for this measurement.
