# CI proof-test contention note

Run `36317520006` failed in the `check` job during `pnpm test`. Static checks completed successfully. The test report showed 1,377 passing tests, 13 skipped tests, four test timeouts at 60 seconds, and one `recovery-readiness.test.ts` setup-hook timeout at 10 seconds. The timeouts were:

- `count-replica.test.ts`: live Monopoly count replication.
- `deck-replica.test.ts`: third-human draw relay and four-human first draw.
- `trade-replica.test.ts`: uncertain-hand trade retry/replay.
- `recovery-readiness.test.ts`: `beforeAll(createRecoveryFixture())`.

There were no assertion failures in that run. The unit-test step took 17m44s and Vitest reported 1,972.65 seconds of aggregate test time, about 1.85 tests active on average. The current worker cap allowed two workers on that runner. These scenarios use repeated curve proofs and can exceed wall-clock limits while competing for CPU.

Vitest now uses one worker when `CI` is set and retains the existing capped local parallelism. The change keeps the test list and deadlines intact. It may increase CI test duration. The failed workflow has not been rerun, so this note does not claim that serial execution makes the full CI job pass.

Focused local checks after the protocol v4 change:

- `pnpm exec vitest run packages/protocol/src/recovery-readiness.test.ts`: 11/11 passed in 8.52 seconds.
- `pnpm exec vitest run packages/protocol/src/count-replica.test.ts -t "certifies owner count contributions and folds private hands after a legal Monopoly"`: passed in 53.96 seconds with the updated deterministic nonce.

The Monopoly fixture used nonce 7 under v3. Since `deckCeremonyId` includes `protocolVersion`, v4 changes that deterministic shuffle. A bounded derivation-only probe found nonce 14 for the same board and fixed owner masters. It did not generate candidate games; the focused test then checked the real certified game and private count-fold path once.
