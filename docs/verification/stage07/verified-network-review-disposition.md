# Verified network runner review disposition

The original and follow-up Claude reviews are in `verified-network-review-raw.json` and `verified-network-followup-raw.json`. Their source manifests identify the reviewed snapshots. The actor's fixes and focused-test limitations are recorded separately in `verified-non-voter-review-disposition.md`.

## Runner changes

- Contribution retries follow protocol time rather than packet delivery count. A recurring 250 ms virtual-clock wake keeps retries alive even with an otherwise empty event queue.
- One asynchronous command preparation remains active at a time. The runner resends the same actor intent at its original sequence and hash, catches thrown preparations, and cancels delivery after the parent changes. The helper's tests cover lost-send retry cadence, an in-flight preparation, a same-height fork and an exception.
- Automatic victory claims are submitted only when the engine confirms them using the actor's own private cards. A public claim-only pending item is not enough: the engine exposes that option even when the player cannot win yet.
- The actor transport delegates every method explicitly. Spreading the original class instance lost prototype methods. A real Memnet transport regression now covers both message directions, subscriptions, disconnect and outgoing observation.
- Actor preparation checks both certified height and hash. The loop restarts if a peer finishes a newer commit during an awaited preparation.
- Final scenario-6 acceptance rejects the exact injected proposal/command from the committed history, checks its signed objective evidence in the exclusion entry, and requires later certificates to retain the original epoch and the three surviving voters. This adds fixture assertions to entries already validated by replicas; it does not replace certificate verification.
- No private-proof finding is allowed, including findings against seat 0. The injected invalid-signature proposal is recorded by the certified control entry. It does not excuse later bad cryptographic contributions from the player endpoint.
- The captured actor traffic must contain its own command and terminal master publication, and no consensus message. The honest audits use protocol-delivered masters, never the fixture's test-only master accessor.

The full-game criterion requires at least one exact post-exclusion actor command to commit, continued play to a winner, matching histories and three independent successful terminal audits. It does not promise that every submitted intent wins a race against concurrent certified system work. Parent changes cancel stale intents; those are not evidence of censorship. The next legal action is chosen from the new certified state.

The runner also keeps the stub actor's validated replay state between revisions. Reconstructing the entire history for every new command made the bounded stub regression exceed its 90-second limit despite continued progress. This optimization does not apply to production gameplay or weaken admission of a new entry.

## Verification boundary

The 22 focused simulation checks pass. The [stub scenario-6 regression](verified-runner-stub-regression.json) now completes in 63.21 seconds with 458 certified entries, 77 post-exclusion player commands, all three honest peers converged, and the unchanged quorum assertions satisfied. Its source fingerprint remained unchanged during the run. This is a stub regression, not the required real-crypto fault acceptance. Protocol actor replay and constructor cleanup checks, TypeScript and scoped lint checks pass. One clean four-human verified full game already passed, as recorded in `verified-network-clean-v6.md`. The eight fault scenarios, including live scenario-6 continuation, still require complete results. A passing synthetic certificate fixture or stub game cannot satisfy that requirement.
