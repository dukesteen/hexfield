# Current-source full draw timing

One uncontended rerun after the owned-genesis digest change passed the unchanged
three-sample full-draw benchmark. Samples were **687.0, 889.0 and 586.3 ms**;
the median was 687.0 ms and the worst was 889.0 ms against the strict one-second
bound. Both peers independently loaded their module graphs and verification
caches. The measured interval remained `BUY_DEV_CARD` submission through both
peers' certified `CARD_DEALT`, including real cryptographic work, memory-backed
durable preparation, consensus and 50 ms links. Legal setup and restoration of
the certified pre-purchase prefix remained outside that interval.

The focused test passed in 46.367 seconds, with a 48.71-second runner duration.
All 213 pinned production, fixture, test and lock files matched before and after
the run. No concurrent local crypto workload ran. The current uncommitted
terminal checkpoint draft was included in those pins, but this draw did not reach
terminal processing. There was no profiling flag, bound increase or second retry.

This is a current-source local timing pass with 111 ms worst-sample margin, not
a browser latency guarantee or proof of a causal speedup from one change. The
[earlier 1,002.8 ms failure](step3-victory-local-checks.md) remains negative timing
history. The owned-genesis change justified this single new measurement; the
new result does not erase that previous failure or establish stable timing
across devices, larger rosters or later play.

The [manifest](draw-owned-genesis-2026-09-28/manifest.json) records the exact
command, tested HEAD, dirty scope, three samples and source pins. The exact
[stdout](draw-owned-genesis-2026-09-28/benchmark.log) and before/after hash
manifests are archived beside it. The benchmark's worst-sample assertion was
unchanged and passed.
