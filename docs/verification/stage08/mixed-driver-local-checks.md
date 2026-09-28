# Mixed-engine bot driver checks

The browser driver receives a newly structured-cloned game config on each observation. RandomBot uses config identity to reset its offer counters. The driver therefore reset the one-offer-per-turn and eight-offer-per-game limits on every decision. Both setup and finish now compare config values and reuse an owned config reference. Changed config values fail the test. Other state, private state, legal commands and actual session submission remain unchanged.

The focused regression passed 2/2 tests in 24ms, 440ms runner time. Ten cloned turns exercise both offer limits. A second case verifies changed config rejection and isolation from snapshot mutation. Shared test typechecking and scoped type-aware lint passed.

The finish summary and failure message now include accepted command-type counts, refusal-code counts, and play/audit elapsed time. Successful summaries also include lobby and setup elapsed times. The single 150-second finish deadline, 300-command cap, 240/300-second overall deadlines, real cryptography and 3VP target remain unchanged. The caps apply to OFFER_TRADE and PROPOSE_TRADE; maritime trades are not capped by this bot policy.

The previous manual-relay failure was still playing at a matching head on all four peers. This identity defect is established independently of that failure, but its contribution to the timeout is unmeasured. No browser acceptance run was performed for this change.

Claude Opus 5.5 at medium effort confirmed the identity defect and the value-checked correction. Board caching, additional stall deadlines, policy changes and wider instrumentation remain outside this change. The exact review input, source manifest, raw response and stderr are archived in [mixed-driver-review-2026-09-28.tar.gz](mixed-driver-review-2026-09-28.tar.gz). Archive SHA-256: `1c067d9f4218b4167fa7e87e56b8cc081602e711a50c44989f85f32aad3050ac`.
