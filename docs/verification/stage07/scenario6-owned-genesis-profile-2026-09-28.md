# Owned genesis digest measurement

The immutable owned-genesis digest memo in `6196fcf` removed most sampled digest
work in a matched 60-second scenario 6 diagnostic. The current run reached
revision 174 and turn 34, compared with revision 116 and turn 22 in the previous
hand-memo run. This is 50% more certified entries within the diagnostic budget.
Eleven compiled files changed between runs, including the detached entry export
optimization, so the throughput gain cannot be attributed solely to the digest
memo. Neither run reached a terminal result.

Both runs used verified security, seed 42, game index 0, parallelism 1, Node
v25.9.0, CPU profiling and a 60,000 ms diagnostic cap. The 900-second acceptance
deadline was not changed. All 263 compiled JavaScript/lock hashes and all 389
recorded source hashes stayed unchanged during the current run. The runner also
reported `sourceUnchanged: true`.

| Measurement                                | Previous hand memo |       Owned genesis |
| ------------------------------------------ | -----------------: | ------------------: |
| Stop time                                  |       60,044.99 ms |        60,003.78 ms |
| Certified revision                         |                116 |                 174 |
| Turn                                       |                 22 |                  34 |
| Genesis digest, inclusive sampled time     |            9.810 s |             0.521 s |
| Digest beneath artifact signer resolution  |            3.826 s |             0.008 s |
| Canonical encoding, inclusive sampled time |           23.502 s |            21.566 s |
| Actor export, runner timing                | 0.785 s / 96 calls | 0.343 s / 154 calls |

Sampled digest time fell by 94.7% while the run completed more work. Inclusive
sample costs overlap and must not be added together. Detached driver contexts,
mutable inputs and byte-containing genesis values retain deterministic digest
recomputation. Signed genesis validation and independent audits are unchanged.

The mixed compiled delta is `genesis-identity.js`, `replay.js`,
`master-reveal.js`, `replicated-log.js`, `online-ceremony.js`,
`testing/recovery-fixture.js`, `indexed-db-protocol-journal.js`, and the P2P
`manual-bootstrap.js`, `peer-link.js`, `signaling-envelope.js` and
`web-rtc-transport.js`. The uncommitted terminal checkpoint implementation was
included, but these early prefixes never reached terminal processing. The
[comparison](scenario6-owned-genesis-profile-2026-09-28/comparison.json) records
all paths and sampled caller costs. The
[manifest](scenario6-owned-genesis-profile-2026-09-28/manifest.json) records the
command, exact dirty scope and raw profile identity. The public diagnostic
result, before/after pins and compressed CPU profile are archived beside it.
