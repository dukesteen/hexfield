# Scenario 6 CPU diagnostic, 2026-09-28

This is a 60-second performance diagnostic of verified scenario 6, seed 42,
game index 0, parallelism 1. It does not establish terminal acceptance or replace
the 900-second acceptance limit. Scenario, gates and seed were unchanged.

The command was `node --cpu-prof --cpu-prof-dir=/private/tmp/hexfield-scenario6-cpu-profile --cpu-prof-name=scenario6-60s.cpuprofile tools/sim/dist/index.js net --scenario 6 --security verified --seed 42 --start-index 0 --seeds 1 --parallel 1 --max-elapsed-ms 60000`.

The run stopped at 60,038.64 ms, revision 95, turn 18, without a terminal result.
The [manifest](scenario6-cpu-profile-2026-09-28/manifest.json) pins the raw CPU
profile by SHA-256 and records the exact command parameters and operation timing.
All 263 compiled JavaScript/lock files matched before and after; the broad source
fingerprint also remained unchanged. Node was v25.9.0. The full CPU profile remains
at the manifest's local path; only public summaries and hash manifests are archived.

Weighted sampling collected 48,306 samples spanning 60.377 seconds. Inclusive
costs include callees and overlap; they must not be added together:

| Function/path             | Sampled cost | Scope                                                    |
| ------------------------- | -----------: | -------------------------------------------------------- |
| Canonical encoding        |     19.394 s | Inclusive, 32.1%                                         |
| Curve `pow2` plus `mod`   |     19.042 s | Self time, 31.5%                                         |
| `validateNextEntry`       |     18.081 s | Inclusive                                                |
| `validateCertifiedEntry`  |     13.696 s | Inclusive                                                |
| `persistCommit`           |     12.633 s | Inclusive                                                |
| `validateHandCommitments` |      9.647 s | Inclusive; 6.187 s is point decoding beneath this caller |
| `genesisDigest`           |      8.112 s | Inclusive; 3.142 s beneath `resolveArtifactSigner`       |
| `contextStamp`            |      4.183 s | Inclusive                                                |
| `sameContextStamp`        |      2.347 s | Inclusive                                                |

Runner timing attributed 45.831 seconds to session flushes. Actor export consumed
0.552 seconds across 75 calls; actor advance consumed 3.452 seconds, including
export, validation and contribution publication. This early prefix does not show
actor-history copying as the dominant cost and does not measure late-game scaling.

The [sample summary](scenario6-cpu-profile-2026-09-28/summary.json) and
[caller breakdown](scenario6-cpu-profile-2026-09-28/caller-breakdown.json) identify
repeated encoding and cryptographic validation as the next measured targets.
No optimization result or post-change speedup is claimed by this profile.

The resulting narrow change memoizes at most 256 successful, exact canonical
public hand-commitment strings. It stores no point instances or proof results,
retains the identity policy, and leaves shape/roster validation, output copying,
arithmetic and opening verification in place. Failures are not cached.
Focused tests verify warm hits, fresh outputs, malformed repeat rejection and
eviction, alongside existing hand transition, trade and range-proof regressions:
27 tests across four files passed. This is correctness evidence; no post-change
scenario timing or terminal acceptance is claimed.
