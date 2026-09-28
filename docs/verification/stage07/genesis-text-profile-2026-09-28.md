# Exact owned-genesis text: bounded profile

The context guard now compares full signed-genesis canonical text separately from the rest of the context. Only detached, deeply frozen, byte-free genesis objects created at the existing ownership boundary receive an identity-scoped text memo. Mutable or byte-containing objects still receive full encoding on every check. The text includes gameId and signatures; no digest substitutes for exact content. All runtime references and guard call points remain checked.

The matched profiles demonstrate less work in the context stamp, **without a measured gain in game progress**. Both runs are diagnostics stopped at the unchanged 60-second limit, not acceptance passes.

| Measurement                        | Baseline    | Candidate   |
| ---------------------------------- | ----------- | ----------- |
| Certified revision / turn          | 148 / 28    | 147 / 28    |
| contextStamp inclusive samples     | 6,913.6 ms  | 3,952.7 ms  |
| canonicalText inclusive samples    | 21,863.4 ms | 19,254.4 ms |
| sameContextStamp inclusive samples | 84.8 ms     | 81.7 ms     |
| session flush calls                | 5,500       | 5,497       |
| session flush wall total           | 45,893.1 ms | 43,024.8 ms |

Context-stamp samples fell 42.8%; inclusive sample times overlap and must not be added. Sampling variance and other work prevent attributing an end-to-end gain to this pair. Remaining candidate costs include canonicalDecode (12,478.4 ms) and copyConsensusStateData (6,523.8 ms). No further cache changes are part of this change.

Both runs used isolated copies of the prior paired candidate at f203c5b, Node 22.23.3, real-crypto scenario 6, seed 42, game index 0 and the same 60-second cap. The sole source differences were genesis-identity.ts and consensus.ts. All 459 source and 217 compiled JavaScript hashes per tree matched before and after. Handles were baseline 55290 and candidate 1544; each ended at the diagnostic deadline with exit 1. No other tests or builds ran during either profile.

A separate same-fixture read-only measurement (75655) found the initial stamp contains 75,858 characters: direct genesis 30,735 (40.52%), head 31,103, crypto 8,022 and state 3,374. The sequence-zero head embeds another copy of genesis. Later field proportions were not measured. The measurement ran after both profiles and emitted only sizes.

Correctness run 50372 passed 54/54 tests in 1.52 seconds: genesis identity 7, consensus 15 and controller 32. Regressions cover full gameId/signatures/nested mutable changes during persistence, equivalent mutable replacement, owned input isolation and byte-containing fallback. Shared test typecheck, scoped type-aware lint and formatting (16013) passed; both isolated production builds passed.

[Profile archive](genesis-text-profile-2026-09-28.tar.gz) includes both compressed CPU profiles, diagnostics, manifests, scripts and the exact production-source overlays. SHA-256: `b345cf1e18ff2e0dce90f0ee2ef6963beb5ee99b511744f09dd9bec82d408c8b`.
