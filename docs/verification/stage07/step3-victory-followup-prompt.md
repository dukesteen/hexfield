# Victory recovery and validation cache review

Read-only review with tools disabled. The user's standing approval covers this
packet. Test keys are deterministic fixtures; no live secrets are included.

Review the changes since `step3-victory-review.md` and the two small validation
caches. Return concrete correctness or security defects with failing traces.
Distinguish test gaps from defects and avoid repeating unfinished later stages.

For R1, `P2PSession.submit` now catches exceptions before replica admission and
returns `session-command-preparation`. Exceptions with unknown admission outcome
still do not trigger retries. For R2, a pending owned automatic command hides
ordinary legal actions and rejects other commands for that seat. For R3, retry
diagnostics notify subscribers and a successful commit clears stale rejection
status. The retry rechecks lifecycle after notification, because a listener can
dispose synchronously. Tests cover the exact backoff boundaries, validation
exceptions, disposal from a listener and a real encrypted victory claim against
the deal's exact certified parent.

A measured draw took 5.87 seconds on real 50 ms links. A CPU profile attributed
about 4.5 seconds to repeated public deck setup point validation. The current
draw takes 987.9 ms in one isolated sample, with only 12 ms margin. No timeouts,
proof rounds, engine checks or wire formats were changed.

- `validateDeckSetupState` first performs its existing bounded canonical shape
  parse. A success-only 32-entry LRU then recognizes the hash of the complete
  parsed public setup. A hit returns the new parsed copy, never a retained
  mutable result. Misses run all existing definition and group checks. The
  cache carries no authority that the shuffle transcript was certified.
- `verifiedUnlockProof` has a success-only 64-entry LRU keyed by the complete
  DLEQ statement, proof and operation-bound context. It skips only repeated
  verification of that exact public proof. Signature, group-point, ordering,
  operation, ledger, engine, policy and durable contribution checks still run.

Check cache-key completeness, failure and mutation behavior, context replay,
bounded memory, and whether either success can improperly authorize a later
state. Existing tests plus the new warm-cache tests reject changed points,
definitions, contexts and freshly re-signed false proof responses. The benchmark
is opt-in so ordinary test concurrency does not make a wall-clock acceptance
threshold flaky. Several peers share a module in memnet; separate browsers will
each populate their own caches, so this result is not a browser latency claim.
