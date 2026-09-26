# Review: victory recovery and validation caches

I reviewed the pasted sources only and ran nothing. I found no safety defect in either cache. I found one conditional liveness defect introduced by R2, one low-severity robustness regression, and two informational items.

## Findings

### F1 (Medium if the engine gates `CLAIM_VICTORY` by phase; otherwise none): R2 can deadlock a seat when the automatic claim is illegal at the current head

**Where:** `P2PSession.automaticCommand`, used by `validate` and `getLegalCommands`.

`automaticCommand` blocks every other command for the seat whenever `getAutomaticInput` returns an owned command. It never checks that the command is currently legal. `automaticVictoryClaim` only excludes setup and checks `activeSeat`. `claimVictory.validate` has no phase check, but I could not see whether the engine's dispatcher also requires the command type to be in the pending `allowed` list.

**Trace** (assuming `CLAIM_VICTORY` is not allowed during the robber sub-phase):

1. The active seat holds 1 hidden victory point and has 8 public VP, with a target of 10.
2. They play a Knight before rolling, which gives them Largest Army. `publicVp` becomes 10 − 1 = 9, `needed` becomes 1, and the pending action is `MOVE_ROBBER` for this seat.
3. After the commit, `getAutomaticInput` returns `CLAIM_VICTORY`. `submitAutomatic` then fails in `engine.validate`, and `retryAutomatic` retries every 4 s or less.
4. `getLegalCommands` returns nothing, and `validate(MOVE_ROBBER)` returns `automatic-input-pending`.
5. The head never advances, so the claim never becomes legal. Without a turn timer, the game stalls.

The same pattern applies to free roads from Road Building (gaining Longest Road) and to any discard that the active seat owes.

Before R2, the same failure only caused background retries. The player could still move the robber, and the claim then succeeded at the next head.

**Fix:** In `automaticCommand`, return the command only if `engine.validate` and `applyPrivate` both accept it at the current head. As a secondary measure, stop blocking after a deterministic rejection code (the terminal-code classification from the earlier design note). That way a persistent local proof fault cannot lock the seat either.

**Test gap:** `automaticCommandFixture` always selects `commands[0]` from the legal set, so this case is never exercised.

### F2 (Low): `getAutomaticInput` exceptions now escape into UI paths

Before R2, a throwing `getAutomaticInput` was contained in `maybeAutomatic` and reported as `session-automatic-input`. Now `automaticCommand` runs inside `getLegalCommands` and `validate`:

- `getLegalCommands` throws synchronously to the view.
- Every manual `submit` resolves `session-command-preparation`, which hides the real cause.

The existing containment test still passes because it never calls `getLegalCommands` after the fault.

**Fix:** Catch inside `automaticCommand`. Then fail closed: return empty legal commands and a distinct `automatic-input-unavailable` code from `validate`, rather than throwing.

### F3 (Info): The remaining `.catch` in `submitAutomatic` is mislabelled and still leaves a memo without a timer

After R1, `submit` cannot reject:

- `replica.submit` never rejects.
- Preparation is caught.
- The `finally` block cannot throw.

The `.catch` is therefore only reachable from the `.then` handler, in practice when `clock.setTimeout` throws inside `retryAutomatic`. The comment "does not establish whether it was admitted" is no longer accurate, because the admission outcome was already known at that point.

The effect is the same as the old R1 trace: `automaticParent === parent`, no timer, and recovery only on the next commit. This is extremely unlikely to occur. Correct the comment. Optionally, clear `automaticParent` so that a later `repair` or `submit`'s `finally` can re-drive the claim.

### F4 (Info): A throwing listener overwrites the retry diagnostic

`retryAutomatic` sets `{rejected, code}` and then emits. If any listener throws, `notify` replaces the status with `session-listener`, and the root cause (for example `deck-reveal-proof`) is lost. Consider keeping the first rejection code, or only recording `session-listener` when there is no current status.

## Caches: checked, no defects

**`validateDeckSetupState`**

- **Key completeness:** the key is a domain-separated hash of the entire strictly parsed state. Every later check (definition, participant keys, point distinctness and non-identity, dimensions, canonical unshuffled points) is a pure function of those bytes. A hit therefore returns exactly what a miss would.
- **Failure behaviour:** failures are never inserted.
- **Mutation:** a hit returns the freshly parsed `state`, never a retained object.
- **Authority:** the function only ever asserted shape validity. Certification still comes from the signed-pass fold, `deckPassHash` against genesis, and the `finalStateHash` check.

**`verifiedUnlockProof`**

- **Key completeness:** the key includes the full statement (`base1`, `point1`, `G`, `lockKey`), the full proof, and the context (`operationId`, `step`, `seat`). `verifyDleq` depends on nothing else, so a hit cannot move a proof to another operation, step, seat or point.
- **What still runs:** order and seat checks, `operationId` equality, the signature check and the point-validity check all run before the cache lookup.
- **Replay:** the `operationId` in the context already binds genesis, epoch, anchor, position, slot and setup hash, so replaying a context cannot carry a success across draws.

**Bounds and sharing**

- **Memory:** both caches are bounded, at most 96 hex strings in total.
- **Eviction:** inserting into the unlock cache requires a participant signature. Setup-cache inserts from snapshots are rate-limited by `admitExpensiveRequest`. Forced eviction therefore only costs performance.
- **Sharing:** module-level sharing between sessions in one process is sound because both predicates are pure.

**Performance note:** with more than 32 distinct live setup states accessed cyclically (multi-deck expansions, `MAX_DECKS = 32`, plus intermediate pass states), the LRU gets a 0% hit rate. This does not affect correctness.

## Test gaps

1. **No default-suite test shows either cache ever hits.** Deleting both caches passes every non-benchmark test, and the only performance check is opt-in. Add a check that counts `verifyDleq` calls through a module mock or a test hook, and assert that one call covers two verifications of the same prefix. Do the same for point decoding in `validateDeckSetupState`.
2. **LRU eviction is untested.** Insert 33 distinct entries and check that the oldest one is verified again.
3. **The F1 and F2 cases are untested:** an illegal automatic command at the head, and `getLegalCommands` or `validate` with a throwing `getAutomaticInput`.
4. **The victory test does not check the failed attempt's side effects.** It never asserts `getProtocolStatus()` after the failed reveal (`session-command-proof`), and it never checks that the deck contribution stores are unchanged between the failure and the retry. `preparedReveals === 0` does show that nothing was signed before 250 ms, so the missing transport observation is acceptable.
5. **Prior gaps not addressed by this change:** replica-level rejection with no `SUBMIT` broadcast (previous gap 2), the retry timer racing a manual command in flight (gap 4), and a retry across a halt followed by repair (gap 5).
6. **The benchmark is too thin to support an acceptance claim.**
   - It is one sample with a 12 ms margin.
   - In memnet, the second peer reuses unlock-proof and setup-validation successes computed by the first. The measured figure is therefore closer to one peer's verification cost than two.
   - Report the median of N runs and per-peer verify counts before quoting it.
   - The profile path `/private/tmp` is macOS-only. Use `os.tmpdir()`.
