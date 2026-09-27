# Final delta review: context-mutation and create-ordering fixes

**Verdict:** The create fix is sound. The reduction fix has one remaining gap: the post-reducer context check is skipped when the reducer fails.

## Finding: the post-reducer check only runs on success (low)

In `OwnedConsensusStateImpl.dispatch`:

```ts
if (!next.ok) return next;          // returns before the context check
const after = this.checkContext();
```

If a callback changes the context during a reduction that then fails, the controller sees the reducer's own error instead of `consensus-context`.

**Counterexample:**
1. A `proposal` event arrives with a valid proposal.
2. During `receiveProposal`, a policy or engine callback sets `excludedProposers = [proposer]`.
3. The reducer rejects the entry with `proposalEntryRejected: true` (not a control).
4. `dispatch` returns that failure without re-stamping the context.
5. The controller does not call `stopVoting()`. Instead it:
   - caches the honest proposal in `rejectedProposals`, and
   - returns an entry-rejection error to the caller.

**Consequences:**
- **Persistent mutation:** the next dispatch's pre-check stops voting, so the stale cache entry does not matter. But the caller has already been told the proposer's entry was invalid. That result is caused by the mutated context, not by the proposer. If the session layer turns `proposalEntryRejected` into an accusation, an honest proposer gets accused.
- **Mutation reverted later in the same reduction:** the pre-check on later dispatches passes. The valid proposal stays in the rejection cache and is refused with `cached: true` until it is evicted. That is a liveness defect for that round.

**Minimal fix:** check the context on both outcomes, and let a context failure take precedence:

```ts
const after = this.checkContext();
if (!after.ok) return after;
if (!next.ok) return next;
```

**Regression test:** use the existing callback test, but make `admitLocalValue` (or a receive-path admissibility callback) mutate the context and return `false`. Then assert:
- the result is `consensus-context`,
- `rejectedProposals` was not populated (the next identical proposal is not answered with `cached: true`), and
- the controller is stopped.

## Residual limit (no action under the stated contract)

Stamp comparisons cannot detect a context that is mutated and then restored within one synchronous reduction, if the reducer reads it in between. Your stated contract covers this: callbacks are deterministic for a fixed replayed context and do not retain or advance it. If that contract ever needs enforcing, the fix is to reduce against a private canonical copy taken at open. Adding more checks would not close it.

## Create fix: no defect found

- The store's absence is checked first.
- `openOwnedConsensusState` does the full restore and stamps the context before `save(null, …)`.
- A stamping failure returns before any write, which the cyclic-context test covers.
- A context change during the initial save is caught by the next dispatch's pre-check, and nothing is emitted from `create`.

Commit after save is also correct:
- `commit()` re-stamps the context and turns a throw into `consensus-context`.
- The controller then discards the pending state and stops before emitting anything.
- The persisted revision stays fail-closed for a later `restore`.
