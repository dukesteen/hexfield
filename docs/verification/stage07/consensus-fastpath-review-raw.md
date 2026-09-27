# Review: Hexfield owned-state consensus fast path

Scope: the diff and excerpts above only. Tools were disabled, so I did not check anything against the pinned files. Findings are ordered by severity.

## 1. High: a context change during `store.save` still commits and broadcasts

**Where:** `consensus.ts` `OwnedConsensusStateImpl.commit`, and `consensus-controller.ts` `ConsensusController.dispatch`

**Problem:** `checkContext()` runs only at the start of `dispatch` and in `snapshot`. The `'Certified context changed during persistence'` branch fires only if someone happens to call `snapshot()` while the save is in flight.

**Counterexample:**
1. `dispatch({kind:'timeout', phase:'prevote', …})` signs a prevote. `pending` is set.
2. While `store.save` is awaiting, the host mutates `context.excludedProposers` or `context.log.state`.
3. The save resolves. `owned.commit()` installs the state without any check, `stopped` is false, and `emit` broadcasts the vote signed under the old context.
4. On the next dispatch, `checkContext` sees `pending === null` and takes the rebind path (see finding 3).

This breaks the rule that a changed certified context fails closed.

**Fix:** make `commit(): Result<void>` recompute `contextStamp` and fail with `consensus-context` if it differs from `this.stamp`, keeping `pending` persisted but not emitted. In `dispatch`, call `stopVoting()` and return before `emit` when that check fails.

## 2. High (conditional): the fast path assumes the historical verifiers are pure, but their contract allows them to change

**Where:** `consensus.ts` `transition`, `OwnedConsensusStateImpl.checkContext`, and `snapshot`

**Problem:** `EntryPolicy.verifyCommand` is documented as pure. `verifyHistoricalCheat` is not: it is "resolved from a replayed certified prefix by the caller", and `context.verifyHistoricalAccusation` appears to work the same way. The stamp compares only function identity. A closure over a replay that keeps advancing therefore keeps the same stamp while its verdict changes.

**Counterexample:**
1. A proposal or `pendingAccusation` carrying a historical-cheat control is retained while the caller's replay is still behind. The verifier accepts it.
2. The replay catches up, and the same claim now proves a fault.
3. Before this diff, the next transition's `restoreConsensusState` would hit `haltForControlFault` / `terminalFault`. The resulting terminal state would be persisted, or `snapshot` would detect the difference and stop.
4. Now `transition` skips restore via `ownedStates.has(state)`, and `snapshot` returns the cached copy. The controller keeps voting on the faulty value and never persists the terminal proof.
5. A restarted controller would normalize to terminal instead, so a live node and a restarted node diverge.

The new test `public reducers revalidate retained proposals when a callback changes behavior` covers only the public path. Nothing covers the owned path.

**Fix:** either:
- bind an explicit replay revision or prefix hash into `ProposalContext` and include it in `contextStamp`, or
- run a full `restoreConsensusState` in the owned path whenever the historical verifiers are present, before any transition that signs.

## 3. Medium: a changed certified context is silently rebound instead of failing closed

**Where:** `consensus.ts` `OwnedConsensusStateImpl.checkContext`

**Problem:** when the stamp differs and nothing is pending, the code re-restores, adopts the new stamp, and continues. This path is also reachable from a read-only `snapshot()`.

**Counterexample:**
1. Mid-height, the host swaps `policy.verifyCommand` or changes `excludedProposers` for a non-local seat.
2. The retained state still passes `restoreConsensusState` under the new context.
3. Voting continues at the same height under a different proposer schedule or validation rule than the one it was opened for.

This contradicts both "opens only after full restore for one controller height" and "changed certified context must fail closed".

**Fix:** on any stamp mismatch, return `failure('consensus-context', …)` unconditionally. The controller already calls `stopVoting()` for that code. The caller then restores a new controller.

## 4. Medium: `contextStamp` is an allowlist, not a complete fingerprint

**Where:** `consensus.ts` `contextStamp` and `sameContextStamp`

**Problem:** the stamp has three gaps:
- **Top-level fields:** it encodes only `log` (minus `engine`), `membership`, `excludedProposers` and `policy`. Any other `ProposalContext` data field is ignored.
- **Function discovery:** it collects functions through `Object.entries`, so prototype, non-enumerable and nested methods are missed.
- **Object identity:** it never compares the identity of `engine`, `policy` or `randomDerivations`.

**Counterexample:** the engine is a class instance with `apply` on its prototype. The host replaces `context.log.engine` with another instance that has the same own data fields but different derivation behavior. `nonfunctions(engine)` and the function list are unchanged, the stamp matches, and the owned path never revalidates. The public path does revalidate in the same situation, which is exactly what the new public-path test checks.

**Fix:** add the identities of the whole context, `context.log`, `engine`, `policy` and `randomDerivations` to `functions`. Then either fail closed at open on any non-plain-object context component, or walk the prototype chain.

## 5. Low (liveness): an exception after `owned.dispatch` leaves `pending` stuck

**Where:** `consensus-controller.ts` `ConsensusController.dispatch`, and `consensus.ts` `OwnedConsensusStateImpl.dispatch`

**Problem:** `beforePersist`, or either `copyConsensusStateData` call, runs outside the `try`.

**Counterexample:**
1. `beforePersist` throws.
2. `pending` is never discarded, and `stopped` is never set.
3. Every later dispatch returns `consensus-pending`. The controller is wedged but not stopped, and the key is not zeroed.

A second path: an untyped runtime event with an unknown `kind` now reaches `next.ok` while `next` is undefined. That throws a `TypeError`, where the old code returned `consensus-event`.

**Fix:**
- Wrap everything from `owned.dispatch` through `commit` in `try { … } catch { this.owned.discard(); this.stopVoting(); return failure(…) }`, or use a `finally` that discards when not committed.
- Restore the `default: return failure('consensus-event', …)` branch in the owned switch.

## Checked with no defect found

- **WeakSet membership:** it never escapes. The transition copy is replaced by `copyConsensusStateData(this.pending)` before it is returned.
- **Callback aliasing:** `beforePersist`, `onEffects` and `admitValue` all receive detached copies.
- **Dispose during a write:** it suppresses emit after `commit`.
- **Failed CAS or write:** it discards `pending` and stops.
- **Concurrent `snapshot` during save:** with the context unchanged, it returns the old committed state, which is consistent with `this.state`.
