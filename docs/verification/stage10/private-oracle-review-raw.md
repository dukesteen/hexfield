# Review: per-sequence private-state comparison (M-D)

I found no high or medium-severity defects. The comparison fails closed, a mismatch is classified as a local processing error, and no validation gate was removed. The findings below are low-severity, mostly about test strength and diagnostics. I did not run any tests.

## Findings

### Low

**1. `audit.test.ts` ~173–213: the transient test does not assert its own premise.**
- The test checks `added` and `removed`, but never checks that the probe is absent at the end. A later `START_SEAT` would re-add it, and the final states would then differ.
- As written, the test does separate the two behaviours:
  - Before this patch, the result would be `ok: true`. Public hashes are unaffected, and `checkTrueHands` only inspects hands.
  - After this patch, the audit fails at the first `START_SEAT` seq.
- The final-equality premise is still only implied.
- Fix: keep a `present` flag set to `Object.hasOwn(ext, 'transientAuditProbe')` on every call, and assert `present === false` after the audit. The LocalGame replay finishes before `crossCheck` runs, so the last call does reflect the final state.

**2. `private-replay.test.ts` ~285–310: the rejection test does not check disposal.**
- The test shows that no driver is returned. It does not check the other stated requirement, "dispose owned secret copies".
- It also leaves three paths untested:
  - rejection at seq 0 (the `initialPrivateCheck` early return, `private-replay.ts` ~158–159);
  - a callback that throws, which becomes `private-replay-failed`;
  - the missing-state branch.
- The code paths themselves look correct: every early return passes through `finally { if (!retained) dispose(); }`.

**3. `private-replay.test.ts` ~263–269: a failing `expect` inside the callback is disguised.**
- A failing assertion throws inside `reconstructPrivateSeats`.
- The surrounding `catch` turns it into `private-replay-failed`, so the real assertion message is lost.
- Consider collecting the keys and asserting on them after the call.
- The aliasing probe is also narrow. It mutates `hand.brick` only; `slots` and `ext` detachment are not exercised. `copyPrivate` does copy both, so this is coverage only.

**4. `private-replay.ts` ~153: the missing-state error loses its seq.**
- `failure('verified-private-missing', ...)` carries no `{ seq }`.
- `audit.ts` ~359–365 therefore falls back to `context.log.head.seq`, and `auditError.seq` points at the final head instead of the failing entry.
- Fix: pass `{ seq }`.

**5. `audit.ts` ~266 vs ~350: one error code covers two different conditions.**
- `audit-private-state` means "omniscient private state missing" in `rememberPrivateHashes`.
- It also means "reconstruction differs" in the cross-check.
- Both are processing errors, so classification is fine, but the report cannot tell them apart. A separate code such as `audit-omniscient-private-missing` would help.

**6. `audit.ts` ~268 vs `verified-session-driver.ts` `copyPrivate`: the two sides hash different representations.**
- The LocalGame side hashes the raw frozen `privateView`.
- The driver side hashes `copyPrivate`'s projection. That projection keeps only `seat`, `hand`, `slots` and `ext`, and round-trips `ext` through canonical encode/decode.
- Any extra top-level field, or `ext` content that is not idempotent under the round trip, would make honest games fail the audit.
- This fails closed (a false processing error, never a false pass), and the base game appears unaffected. It is a risk for expansion modules that store rich `ext` data.

**7. `beta-game.test.ts` ~61, ~76: the owned-master restriction does not detect over-requests.**
- Returning `null` for seats the peer does not own is the correct restriction.
- However, a session that over-requests foreign masters would pass silently.
- Recording or throwing on non-owned requests, and asserting none occurred, would turn this into a real check.

### Informational

- **`audit-fixture.ts` ~210–215: repeated ceremony validation.** `validateDeckCeremony` now runs on every `initialProposalContext`: session creation, the public, private and cross-check replays, the re-replay inside `reconstructPrivateSeats`, and historical-accusation recursion. If the ceremony check is expensive, this adds noticeably to the 600 s beta budget.

## Confirmations

**Observer mutation and aliasing**
- The callback receives a fresh `Map` of `privateState()` copies, so mutating it cannot reach the driver.
- The audit side only hashes the frozen `privateView`, keeps hex strings, and never keeps object references.

**Coverage and order**
- Both sides record or check at seq 0 and after every entry, including entries with no input.
- The cross-check runs only after the LocalGame replay and the terminal-result comparison have succeeded, so every expected hash exists.
- If an expected hash were missing, the check fails (`!expected`).
- `size` equality plus a lookup for each seat forces the key sets to be identical.

**Genesis**
- A missing hash at genesis gives `processingFailure(0, …)`.
- A mismatch at genesis gives `auditError.seq === 0` via `details.seq`.

**Failed history**
- A public-replay failure, an incomplete master set, or a LocalGame violation all return before the cross-check.
- The partially filled `privateHashes` is then discarded unused.
- The existing "false private draw" test still produces its LocalGame violation first, so the new check never pre-empts it.

**Classification**
- `audit-private-state` appears in both processing lists (~319 and ~373).
- The result is `complete: false`, no seat is accused, and `finalHiddenVictoryPoints` stays `null`.

**Leakage and authority**
- No new master access. The callback sees only the seats whose masters were supplied and that `verifyRevealedMaster` already accepted.
- Error details carry only `seq`.
- `AuditReport` exposes only `{ seq, code }`.

**Secret disposal**
- A failing, throwing or seq-0 callback still reaches `dispose()` in `finally`.
- In the audit, the masters are also zeroed in the outer `finally`.

**No reduced scope**
- Every earlier check is still present in `audit.ts` and `private-replay.ts`.
- The fixture replaced success-only stubs:
  - The genesis stub became real ceremony validation.
  - Removing the always-succeeding `verifyCommand` can only be equal or stricter. I cannot confirm from these files whether its absence enables a built-in check.

## Residual limits

- **Engine independence is only partial.** Both sides use the same `input.engine`. Independence comes from different drivers and private-data paths, not different engine code:
  - LocalGame uses `applyAllPrivates`, frozen-index steal selection, and decoding with the master.
  - The driver uses per-seat `applyPrivate`, steal openings, and hand-commitment checks.
  - If `applyAllPrivates` is built on `applyPrivate`, a bug in shared private logic shows up identically on both sides and goes undetected. The new test works only because it makes the two paths diverge.
- **Snapshots are provisional.** A callback at seq *j* runs before the beacon-history and opening checks for later entries. A local divergence at *j* would therefore mask a real driver-detected violation at *k > j*. The result would be `complete: false` rather than an unattributed violation. That is conservative, but the diagnostics are weaker.
- **The seat sets are assumed equal.** The comparison assumes `genesis.config.seats` matches `genesis.seats`; `missingSeats` uses one and `privateHashes` uses the other. If they ever differ, every audit fails closed.
- **Keep the stored hashes internal.** They are unsalted hashes of low-entropy hand and card state, so they could be recovered by dictionary attack if exposed. They must stay out of reports and logs, as they currently do.
- **The ceremony check is not exercised everywhere.** `private-replay.test.ts` still uses a success-only `verifyCommitments`, so these changes do not exercise ceremony validation on that path.
