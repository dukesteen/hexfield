# Follow-up review: consensus fast path

I reviewed only the diff and the excerpts you provided, with no tool access. Two things I could not see: the controller lines between `reduce` and `beforePersist`, and the `onEntry` call sites. Findings that depend on either are marked conditional.

## Findings

### 1. Context is not re-stamped after the reducer returns (low; hardening)

`OwnedConsensusStateImpl.dispatch` checks the stamp before the reducer. `commit()` checks it after the save. Nothing checks it in between, so a mutation made during the reducer and reverted during `await store.save` goes undetected.

`admitLocalValue` is a controller option. It is not part of the stamped context, and the EntryPolicy purity contract does not cover it. It can still reach `options.context` through a closure.

**Counterexample:**

1. `admitLocalValue` changes `context.membership.voters` (or `excludedProposers`) so that the votes it holds reach quorum.
2. It returns `true` and calls `queueMicrotask(revert)`.
3. The rest of the same `receiveVote`/`timeout` transition computes the lock, precommit or commit under the altered membership.
4. The revert runs while the save is awaited.
5. `commit()` sees an identical stamp and emits.

This only matters if local callbacks count as untrusted. Your new "callbacks cannot mutate controller-owned safety state" test suggests they do.

**Fix:** in `dispatch`, after `if (!next.ok) return next;`, add:

```ts
const after = this.checkContext();
if (!after.ok) return after;
```

One case remains: a callback called twice in one transition could mutate and then revert. That is covered by the same callback contract described under item 2 below.

### 2. `create` persists the record before the context is stamped (low; liveness)

`store.save(null, …)` runs before `openOwnedConsensusState`. Suppose `contextStamp` throws, for example because `log` or `policy` holds a non-canonical nested value. Then:

- `create` returns `consensus-restore`, but the revision-0 record is already on disk.
- A retry of `create` gets `consensus-write-conflict`.
- `restore` fails for the same reason as the first attempt.

The result fails closed, but the stored record is stranded. It also leaves `this.state` (`initial.value`) and the owned state as two separately derived copies.

**Fix:** call `openOwnedConsensusState(initial.value, …)` before the save, and return its failure without persisting anything.

No other concrete defects found. The following items from the previous review check out:

- **Trust marker:** it is identity-only. `ownedStates` is a module-private WeakSet, and only `transition` consults it. Public reducers still run full validation on caller-supplied data, and there is no caller-supplied trusted flag.
- **Copies:** owned state, pending state, the snapshots, and the `admitValue`/`beforePersist` inputs are all separate copies. The transition `copy` that gets added to `ownedStates` never leaves `OwnedConsensusStateImpl.dispatch`.
- **Discard paths:** every failure path after the reducer discards `pending`. That covers `beforePersist` failure, save returning false, save throwing, commit failure, and the outer catch. This is conditional on there being no other early return between `reduce` and `beforePersist`.
- **Post-save commit failure:** output is suppressed, voting stops, and `restore` reloads the newer persisted revision. Recording a vote that was signed but never sent is conservative, so this is safe.

## Earlier finding 2 (historical verifier purity): this is a contract, not a vulnerability

From the excerpt, `certified`, `controllerTimeline`, `historical` and `cheatHistorical` are locals of a single `replayCertifiedPrefixWithCache` activation.

**After replay returns, nothing can grow `certified`.** The closures on `replayed.value.context` therefore see a fixed length, and each verdict is a function of the claim alone:

- **Bounds check:** `atSeq > certified.length` compares against a length that no longer changes.
- **Parent hash:** checked before the cache lookup.
- **Signer:** checked before the cache lookup.
- **`verifiedFindings` key:** the claim hash, and the claim embeds `evidence.at.hash`, so a cache hit implies the same parent.
- **LRU eviction:** only forces a deterministic re-replay, given the EntryPolicy and engine purity contract.
- **Contexts opened later:** a context derived by spreading from that one keeps the stale closures. That can only make verdicts stale-but-stable (more failures), never flip a failure into a success.

**The one window is `onEntry`.** Its `next` argument shares the closures while `certified` is still growing. If any `onEntry` implementation keeps `next`, or opens a controller with it, before replay finishes, the verdict can flip. Take a claim with `certified.length < atSeq ≤ laterLength`: it fails at open and succeeds later. The owned fast path would never revalidate proposals it has already retained. I can't see the `onEntry` call sites, so I can't rule this out.

**Contract to state:** contexts passed to `onEntry` are ephemeral. Controllers may only be opened from `replayed.value.context` after replay returns. Engine, EntryPolicy and `verifyHistorical*` verdicts must be deterministic for a fixed context.

**Cheap enforcement:** call `Object.freeze(certified)` and `Object.freeze(controllerTimeline)` just before `replayCertifiedPrefixWithCache` returns. Any later push then throws instead of silently changing a verdict.
