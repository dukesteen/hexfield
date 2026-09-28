# Coordinator deck prefix review

Claude approved the coordinator-owned prefix cache without blocking findings. The review was read-only and used the source hashes in `deck-prefix-review-manifest.json`. Production source remains unchanged from that review.

Each deck cache binds the attempt, canonical definition, ordered signed-pass hashes and copied predecessor states. A newly validated candidate becomes a prefix state only after the accepted slot matches its step, pass hash and predecessor hash. A new coordinator validates durable passes again; disposal clears the cache. The existing 20-second phase deadline stays unchanged.

The reviewer identified non-blocking points about retained bounded state after retirement, mutable references passed to trusted current helpers, hash work on retry, and fail-closed handling of an unreachable missing candidate. These are accepted for this change. Existing deck slot keys omit deck ID; the current base catalogue contains one deck, and multi-deck support remains separate work.

The review also requested a positive retry signal in the no-revalidation test. The test now observes a new held-pass retransmission before checking zero repeated `applyDeckPass` calls. An existing completed-replay dispute test injected its message before the restored listener registered; it now injects only after registration. Four focused tests pass, covering that replay notification, unchanged-prefix retry plus cold restart and the original deadline, validator-output mutation isolation, and an invalid authenticated late pass. TypeScript compilation, lint and formatting checks pass.

A 24-test run before the replay-injection correction passed 23 tests and failed that timing-sensitive test. Its log is `/private/tmp/hexfield-deck-prefix-full-final.log`. The subsequent four focused checks passed in 35.47 seconds, recorded in `/private/tmp/hexfield-deck-prefix-regressions-final.log`. Native performance and full lifecycle acceptance are evaluated separately.
