# Consensus fast-path review disposition

The initial tools-disabled source review is in `consensus-fastpath-review-raw.md`; the follow-up reviews are in `consensus-fastpath-followup-raw.md` and `consensus-fastpath-final-review-raw.md`. Each input has a pinned SHA-256 manifest. The final source after the last review recommendation is:

```
663e66c68514df7c2fcaa12328a18f54268b3d6ea0440231adf295df400cbdae  packages/protocol/src/consensus.ts
4200ff75e34754cff6f79ac05878128eb1a5d1b933d145e2d6d79c242b93b309  packages/protocol/src/consensus-controller.ts
3b61c6c669f38eb635409b31f62e32953aa7e9fe60fdd587cdefb488908005dc  packages/protocol/src/consensus.test.ts
bdef1358aa4f3cd56cc6e186c9fd43ff9cc1b4ebb8020f63c6b008ddc3cfe12c  packages/protocol/src/consensus-controller.test.ts
```

The review's post-save context race is fixed by checking the stamp again before committing and emitting. Changed context now stops the controller instead of rebinding it. The stamp covers all enumerable data plus engine, policy, log, random-derivation and callback identities, including prototype methods. A throwing observer discards pending state and zeros the controller key. Unknown runtime events return a named error. Creation opens and stamps the validated owned state before writing revision zero.

The final review found that a reducer failure could bypass the new post-reducer context check. That check now runs before returning either a successful or failed reduction, so a local callback's context mutation takes precedence over an entry-rejection result. The focused regression verifies no new durable revision or emitted effect and that voting stops. The proof of absence of a mid-reduction mutate-and-revert attack relies on deterministic callbacks for a fixed certified context. Production historical resolvers capture a certified array that stops growing when replay returns. The production `onEntry` users observed in `audit.ts` do not retain its intermediate context or open a controller with it. A future caller must preserve that contract.

The same-seed 55-second V8 diagnostic improved from revision 35 to revision 80, with full safety restoration falling from 59.9% to 0.8% of sampled CPU. The last detached mirror copy and last two review guards were added after that run, so this is not an exact final-source benchmark or a completed-game claim. Details are in `verified-network-cpu-profile.md`.
