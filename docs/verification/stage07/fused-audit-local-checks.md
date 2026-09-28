# Fused terminal audit: local checks and review disposition

The terminal audit now validates the certified branch twice, rather than four times. Its first pass authenticates the complete public branch. Its second pass compares independent LocalGame and VerifiedSessionDriver private states at genesis and every certified sequence. Only the current sequence's hashes are retained. Public private reconstruction continues to authenticate the complete history and revealed masters before callbacks. No acceptance deadlines, seeds or game rules changed.

Read-only Claude Opus 5.5, medium review completed in 193.259 seconds (session 36975). Input, original frozen manifest and raw response are in `/private/tmp/hexfield-fused-audit-review-2026-09-28/`. The review found authentication order and deferred failure precedence sound, and identified one disposal regression plus test gaps.

| Finding                                                            | Disposition                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1: disposal could escape the audit and skip its master wipe       | Reproduced against the exact reviewed pre-fix audit source: run 4277 failed with the disposal exception (14.41s). Disposal now runs inside the audit error boundary; successful cleanup precedes final hidden totals, matching the prior report. All audit master copies are wiped in the outer finally. |
| H1: observer cleanup could skip master copies after driver failure | Every seat's master and beacon cleanup runs in finally; remaining seats and driver disposal are attempted before the first cleanup error is rethrown.                                                                                                                                                    |
| C1: differential reference reused the extracted observer           | Added a frozen prior private-replay implementation and wired the old audit reference to it. Direct differentials compare callback sequences, snapshot hashes, resulting states and errors on honest, changed-length and unrelated signed-extension histories. Neither reference is a package export.     |
| C2: precedence test did not establish the earlier discrepancy      | Added a control without the later draw exception, proving the earlier START_SEAT discrepancy, then comparing the later-error report with the reference.                                                                                                                                                  |
| H2: current hash sequence alignment was implicit                   | The callback now checks sequence equality as well as all private-state hashes.                                                                                                                                                                                                                           |
| H3: defensive copy for a mutating engine                           | Not added: engine purity is the existing contract; no current regression was established.                                                                                                                                                                                                                |
| H4: internal API exposure                                          | Package exports are only `.` and `./testing`, with no wildcard. Neither internal observer helper is reexported. Restored the public reconstruction authentication-order comment. A new import lint rule was not needed for this change.                                                                  |

Archive: [prompt, raw review, manifests and check logs](fused-audit-review-2026-09-28.tar.gz), SHA-256 `eb9c6bb0961054cee2ed34a1232e783627ed3799bbf46b7c8b0f4088891d5fd7`. Test logs are captured terminal excerpts, explicitly identified in the archive; complete test stdout was not redirected. No secret fixture outputs are included.

Checks:

- Initial run 31437: audit 10/10 and private replay 7/7 passed; runner 29.38s. The genuine terminal fixture proved exactly two certified-entry validations per entry versus four in the frozen audit reference.
- Strengthened run 25432: 17 passed, one disposal-report mismatch failed; runner 36.82s. The mismatch was final hidden totals being assigned before disposal, and was corrected.
- Corrected disposal run 87727: 1/1 passed, runner 15.82s. Combined with the 17 unaffected passing cases, all 18 assertions are covered. Caller-supplied master bytes remained unchanged.
- Full production build 65400 passed; complete build log is included in the archive.
- Shared test typecheck 69480 and 77500 passed. Final scoped type-aware lint and formatting passed. Final lint-only changes remove an unnecessary array copy and narrow test literals; they do not change the checked behavior.

These are bounded protocol regressions using a genuine small terminal-game fixture and certified private history. They do not establish a full four-human 10VP acceptance run or a wall-time speedup. Optional additional audit-level exception/disposal spies were not needed to address the concrete findings; the existing private replay cleanup and callback-exception tests passed.

Frozen final source hashes:

| Source                                                      | SHA-256                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/protocol/src/audit.ts`                            | `2fa0939434051a9b37ce1aa54c3586ed26c97e613b3f5b0a43ee2d02fc7ff7b8` |
| `packages/protocol/src/audit.test.ts`                       | `31e51ea76c6446a4b96d9d052a80c98c71114462241451989c6e263f62c1163b` |
| `packages/protocol/src/private-replay.ts`                   | `ad5e1a6f7389225fc39c4877d0eb06283845f4966123da67c0cbcba0fb744946` |
| `packages/protocol/src/private-replay.test.ts`              | `618557979be3d9cd2d0d16d34dd3680dfb9c95c69ab184760644d51a74f22a1c` |
| `packages/protocol/src/private-replay-observer.ts`          | `8e02ec2d81e5209275c226a41afcb273c41e3b035fccecab90f1f4d7d32565d8` |
| `packages/protocol/src/replay.ts`                           | `4325ee41b489e109223d446a3a30a62ebad6786a8be69a1d3db3e33bf2e9378e` |
| `packages/protocol/src/testing/audit-reference.ts`          | `64d268d7ca4f29e6fb8d4f5ee03293f683b242cb38887f7d96990ca3f42b7dc0` |
| `packages/protocol/src/testing/private-replay-reference.ts` | `4da41a2db121445a9b98743cb6d5c6ec76ae331bcad8f662cf1f1bb816e0d5d1` |
