# Stage 07 Step 2 beacon review: follow-up

This is a static read of the attached packet. I ran nothing and did not re-review the accepted voting algorithm. The later deck, hand, steal-consumption, membership and escrow-recovery work is still absent: `consumeFixedBeacon` has no caller, so a fixed steal still stalls. Nothing below implies that work is complete.

## Verdict on issue 1 (extension secret lifecycle)

**Addressed under the documented provider contract, with one qualification (finding A below).**

Replaying the original failure trace against `createBeaconSecretSource`:

- **Crash before `putIfAbsent`.** `extension(e)` derives its seed from `(master, ceremonyId, seat, chainEpoch, length)` using the `beaconExtension` label. A restarted provider therefore returns the same tip, and later `link(e, i)` calls come from that same chain. Step 4 of the original trace, where certified tip B meets a retained chain A, can no longer happen.
- **Two tabs or workers racing.**
  - Both derive the same `{length, tip}`.
  - Ed25519 signing is deterministic.
  - So both write identical bytes, and it does not matter which `putIfAbsent` wins.
- **Parameter mutation.**
  - `master` is validated, then copied with `slice()`.
  - The context is copied into a fresh `bound` object. Accessors, extra keys and non-canonical base64url are rejected.
  - Every returned tip or link is a `slice()`, so caller writes cannot reach the cache. The mutation test covers this.
- **Cache eviction.**
  - Eviction only removes an epoch that is not the one just inserted.
  - Evicted links are zeroed, but no reference to them escapes: `chain()` output is consumed synchronously and copied.
  - Re-derivation after eviction is deterministic. The eviction test checks epochs 0 and 1 after both are evicted.
- **Disposal.**
  - It zeroes the master copy and every cached link, then clears the cache.
  - Every later entry point throws once it reaches `chain()`.
  - The HKDF output `seed` is zeroed after the chain is built. Its copy, the last chain element, is zeroed with the cache.
- **Error mapping.** Source and signing failures now return `beacon-contribution-source` instead of the storage code.

Durable storage of the master and ceremony ID is still a Stage 10 responsibility. If the master is lost or replaced, the seat still fails closed.

## Confirmed remaining defects

### A. Chain length is a derivation input but not part of the retained-context contract (Low)

`length` is hashed into every chain seed (`{ ...bound, chainEpoch, length }`) and defaults to the module constant `DEFAULT_LENGTH`. However, two documents describe the contract as master, ceremony context and epoch only:

- the `BeaconSecretSource` doc comment in `beacon-contributions.ts`;
- the review response ("master or ceremony context").

**Trace:**

1. Genesis commits `{length: 4096, tip: T0}` from a provider built with the default length.
2. Later the process restarts with the same master, ceremony and seat but a different `length`. This happens if an explicit argument differs or if a code update changes `DEFAULT_LENGTH`.
3. At the next reveal, `getBeaconOperation` gives epoch 0, index k, and `previous` equal to link k−1 of the 4096-link chain.
4. `source.link(0, k)` derives a different seed, so the returned value does not hash to `previous`. `signBeaconReveal` throws, and the result is `beacon-contribution-source`. If the new length is below k, the index check throws instead.
5. Every restore repeats this, so the seat is permanently failed. That is the same outcome as the original issue 1, reached by a different path.

The same happens if an extension record was persisted under length L1 and the restart uses L2. `verifyStored` checks the record only against the operation, not against the local source. The record is certified, and the first reveal from that epoch then fails.

**Direction:** do either of the following:

- State that `length` is part of the retained context and persist it alongside the master. This covers `DEFAULT_LENGTH` changes as well.
- Take the length from certified chain state rather than from a constructor argument.

A test that constructs providers with differing lengths would document the dependency.

### B. The new system-type guard does not cover `steal-index` outcomes from extension derivations (Low, hardening)

In `createRandomDerivations().derive`, the check only runs for system outcomes:

```ts
if (outcome.kind === 'system' && outcome.input.type !== pending.systemType)
```

A registered extension type with `systemType: 'X_RESULT'` can therefore return a well-formed `{kind: 'steal-index', …}` outcome, and the guard does not apply. The trace:

1. `completeBeaconState` installs `fixed`.
2. The inbox proposes `beacon-fixed`.
3. `validateCryptoTransition` accepts it, because `outcome.kind === 'steal-index'`.
4. From then on, every input hits `beacon-pending`. The only way out is `consumeFixedBeacon`, which is steal-specific.

The registry is trusted module code, so this is a module-bug failure mode, not a peer attack. Even so, the response's statement that "registered extension outcomes must also answer the frozen `pending.systemType`" does not hold for this outcome kind.

## Claims versus the tests as provided

- **"Prepares a valid reveal from another fresh provider"** is not what the crash test does.
  - The test in `beacon-contributions.test.ts` prepares both the extension and the next reveal from the same `restarted.source`, so the epoch-1 reveal comes from that instance's cache.
  - The "certifies" step is a direct `extendBeaconState` call, not certification.
  - Coverage is still adequate in combination: `beacon-source.test.ts` checks `restored.source.link(1, 1)` against a tip `announced` by a different, disposed instance. The documentation should describe the test accurately.
- **The separate error code is untested.**
  - No test asserts `beacon-contribution-source`. If the inner `try` were removed, source failures would fall back to `beacon-contribution-prepare` and every test would still pass.
  - Disposal during the `await store.load` gap also maps to this code, with the message "do not match the frozen chain or signer". That message is misleading for a disposed provider.
- **The duplicate regression is conditional on code not in the packet.**
  - The `derive`-count assertion only catches removal of `received.has(seat)` if two conditions hold in `replicated-log.ts`:
    - a `true` from `remember` reaches `inbox.candidate()`;
    - `candidate()` receives `policy.entry.randomDerivations`.
  - Otherwise the spy may be hit only by proposal validation. The `toHaveBeenCalled()` check before re-injection does not tell these two paths apart.
  - If both conditions hold, the test is a real regression test. The post-commit stale check is sound, because after `START_SEAT` the phase is null.
- **Negative tests that do fail if their guard is removed:**
  - protocol label → `beacon-evidence-required`;
  - `beacon-fixed-kind`;
  - `ambiguous-random-request`;
  - `beacon-pending`. This one asserts the specific code, even though the engine would also reject the unknown system type;
  - `random-result-type`;
  - the exact-byte outbox test, where `link` is called once and `extension` is never called.
- **Still untested, and not claimed as tested:**
  - `beacon-request-changed`;
  - the active-and-fixed exclusivity check in `validateBeaconState`;
  - a command while a beacon is active. The engine's `dicePhase` exposes `claimCommands`, so `beacon-pending` is a live barrier there;
  - a second, different, valid extension from the same seat not replacing the first. Under the new contract only a malicious signer can produce this.
- **The extension race test still uses a nondeterministic source.** That source violates the new contract. The test remains valid only as evidence of store atomicity.

## Earlier conditional findings, now resolved by the engine snippets

- **Seats.** `baseModule.modifyConfig` rejects fewer than 2 or more than 4 seats, which matches `seatList`. Five and six seats are later module work, not a flaw.
- **Balanced dice.**
  - `rollDice.apply` resets a deck of 6 or fewer cards to 36 before replacing the frame with `dice`. So `dicePhase.pending` always reports at least 7 remaining, which matches the `ids.length >= 7` check in `diceIds`.
  - The request shape `{type, mode, remaining}` matches `validateDice`.
  - The derived `index` matches `diceResult`'s `diceDeck[input.index]` lookup.
  - Only `ROLL_DICE` is shown entering the `dice` frame. Other modules are outside this review.

## Limitations

- `replicated-log.ts` is not in the packet, so I could not confirm:
  - how `beacon-contribution-source` feeds into `failClosed`;
  - the wiring that decides whether the duplicate test is effective.
- No test or replica fixture exercises `createBeaconSecretSource` through `ReplicatedLog`. The replica fixtures use hand-rolled deterministic sources.
