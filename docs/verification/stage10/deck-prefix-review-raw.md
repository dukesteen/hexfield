# Review: coordinator-owned validated deck prefix cache

**Verdict: APPROVE.** I found no blocking correctness or security defects. The cache removes the repeated `applyDeckPass` fold without weakening initial validation, candidate binding, restart revalidation or the deck deadline. Non-blocking limitations and test gaps are listed below.

## What holds

**Exact identity**
- The cache map is per instance, keyed by `deckId`, and cleared on `dispose()`.
- Each deck's definition is re-hashed and compared on every advance.
- Nothing is shared across attempts or processes.
- Including `#attemptId` in `definitionHash` is redundant, since it is constant per instance, but harmless.

**Accepted candidate binding**
- `validate` records the result as a pending `next` entry, keyed by `step`, `passHash` and `predecessorHash`. This happens before persistence.
- A later advance only promotes `next` if all three match the hash of the value actually taken from `#accepted` or the store.
- Every route that sets `#accepted` (receive, store load, `#outgoing`) runs `validate` for that exact payload first. The queue serialises these, so nothing can interleave between validation and acceptance.
- A validated but rejected candidate can overwrite `next`, but that either:
  - fails the hash match (fail-closed), or
  - comes from a conflicting packet for an already committed slot, which retires the attempt through the conflict path.
- So an unaccepted state can never be promoted.

**Immutable ownership**
- The initial state and every `next.state` are detached with `copy()`.
- `applyDeckPass` parses a fresh copy of its input, so the stored predecessor is not aliased into its output.
- States never reach `#result` or transcripts.
- For already-cached steps, the `passHash` re-check detects any later mutation of the accepted pass objects that are shared with escrow and consent code.

**Invalid late passes**
- A newly received pass still goes through the full `applyDeckPass(before, payload)`. Only already-folded steps skip it.
- An invalid packet fails in `#checkedPayload` and retires with `online-ceremony-invalid-packet`, as before.

**Retirement, restart and deadline**
- After a restart the cache is empty, so every stored pass is re-validated through the store-load path, one step at a time.
- `#enterPhase` and its timeout scheduling are untouched, so no new path renews the deadline.
- The first test's `advanceBy(18_999)` after restart would fail if the deadline were renewed.

**Bounded memory**
- Per deck the cache holds at most 2·participants+1 states (participants ≤ 6, 128 points each) plus one pending state.
- The number of decks is fixed by the frozen manifest.

## Non-blocking findings

1. **Mismatch fails closed but stays stuck until the deadline.** If `next` is missing or mismatched, the advance returns `online-ceremony-deck` and shows the `error` phase. The value stays in `#accepted`, so every retry fails the same way until the timeout retires the attempt. I found no reachable path to this with correct inputs. Still, a fallback would make it self-healing: on mismatch, run `applyDeckPass(before, pass)` and push `copy(result)`, instead of failing.

2. **Cached states are shared by reference with other code.** `before` is the long-lived cached object, and it is passed directly to `prepareDeckPass`, `applyDeckPass` and `hashValue`. Before this change it was rebuilt on every advance, so a mutating callee could not corrupt later steps. Today's callees don't appear to mutate, but deep-freezing the cached states, or passing a `copy(before)` to `prepareDeckPass`, would make ownership enforced rather than conventional.

3. **Retained after retirement.** `#deckPrefixes` is only cleared in `dispose()`, not when `#abortUnsafe` retires or a disclosure retires the attempt. The size is bounded, so this is minor.

4. **Hashing on every advance.** Each advance re-hashes every cached pass (including large shuffle proofs) and every predecessor state. This is much cheaper than proof verification, but for already-cached steps an identity check against the stored pass would be cheaper still.

5. **Pre-existing, not introduced here: deck-pass slot keys omit `deckId`.** The key is `(deck-pass, seat, step)`. With more than one deck definition, deck 2 would collide with deck 1's stored or cached passes. The old code failed on the `operationId` check; the new code fails with "prefix incomplete". It is worth confirming there is only ever one deck, or adding `deckId` to the slot key.

## Test notes

- **`vi.spyOn(deckSetup, 'applyDeckPass')`** relies on Vitest's transform making ESM named imports live, patchable property reads. This is transform-dependent and fails under native ESM or browser mode.
- **The "skip validated passes" assertion can pass vacuously.** `expect(applied).not.toHaveBeenCalled()` would also pass if the host's retry never ran. Add a positive signal that the retry actually reached the deck step, for example a spy on the rebroadcast or `#exchange` count.
- **The invalid-late-pass test** doesn't assert that the predecessors were actually served from the cache. The title claims this, but only rejection is checked.
- **The mutation test is effective.** Because the spy is shared by both instances, a retained reference would produce an identity point that later validation rejects.
