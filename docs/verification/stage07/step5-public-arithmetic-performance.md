# Hidden-transfer public arithmetic timing

The eight-type hidden-transfer proof has the same statement, 6-bit range widths, proof encoding, and transcript as the prior checkpoint. The change uses variable-time Ristretto multiplication only for disclosed proof scalars during full verification and fixed public range weights. Witness blindings and proof nonces keep the existing `scalePoint` path. The inverse of the fixed final range weight is cached by public width. The canonical test proof digest remains `b1e86a98ef84995fee4601548728a63045e165d999447a77fd1fd7b201eb573a`.

An in-process Node 22 CPU profile attributed most samples to Noble's curve arithmetic. A small public-scalar microbenchmark found `multiplyUnsafe` faster than the secret-safe path; a two-point `mulAddUnsafe` candidate was slower and was not adopted. These diagnostics selected the change but do not establish browser performance.

In one fresh **headless** Chrome 153 run on the strict local server at port 5294, the same browser ran three baseline and three changed eight-type full prove-plus-verify samples. Each sample used an independent nonce input and passed verification. Both variants used the same timing worker and statement; the baseline worker imported the pre-change crypto modules, while the changed worker imported the modified modules. No verification cache was used. This A/B predates the security-review correction described below.

| Variant           | Prove + verify samples (ms) | Median (ms) |
| ----------------- | --------------------------- | ----------: |
| Baseline          | 237.6, 219.6, 206.4         |       219.6 |
| Public arithmetic | 179.5, 171.9, 174.9         |       174.9 |

The preliminary paired median improved by 44.7 ms, about 20%. The source-only review then found that public-scalar arithmetic in secret-selected simulated CDS branches could disclose the known branch through prover timing. The final patch restored secret-safe arithmetic on that path and made exported inspectors secret-safe by default; only verification of every branch opts into public arithmetic. The preliminary A/B is therefore diagnostic, **not a speedup estimate for the final source**. Its [raw output](step5-public-arithmetic-headless-pre-review-ab.json) is retained for comparison.

One subsequent **headed** Chrome 153 run on the same strict local server measured the corrected source. Three independent, valid eight-type full prove-plus-verify samples took 203.3, 188.2, and 192.1 ms (median 192.1 ms). Proving took 152.4, 138.5, and 140.9 ms; verification took 50.9, 49.7, and 51.2 ms. The [raw result](step5-public-arithmetic-headed-timing.json) is retained with the [final-source hash manifest](step5-public-arithmetic-followup-manifest.sha256). A separate earlier [headed Chrome run](step5-hidden-transfer-precompute.md) measured 1,091.8–1,142.0 ms after fixed-H precomputation. The large absolute difference is not attributable to this source change from the available paired data; browser, scheduling, or served-module state may have differed. The corrected run is one machine's observation, not cross-device acceptance of the 300 ms target.

The focused crypto tests passed 49/49, including proof round-trip and pinned digest; the crypto package build and scoped type-aware lint passed. The measured optimization does not change the proof format or its verification rules. A [follow-up review](step5-public-arithmetic-review-disposition.md) records the pre-existing zero-scalar early return as a remaining privacy risk outside this optimization.
