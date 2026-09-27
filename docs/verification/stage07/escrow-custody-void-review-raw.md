# Review: certified `recovery-void` proposal

I used only the supplied excerpts and ran no tools, as you asked. Findings are ordered by severity. Each is labeled as either a **defect**, which the cited source shows, or a **decision**, which is a product question left open.

## 1. Publishing the scalar exceeds the documented exposure and weakens other seats (decision; the cross-seat part is shown in source)

**The contract.** `docs/07-fair-randomness-hidden-info.md:226` and `docs/10-persistence-reconnection.md:92` limit exposure to *recoverers*. The proposal keeps read-only sync and export after the void, so the scalar would reach every journal copy, every full-save export and every later reader.

**The cross-seat effect.**
- The test fails at `master-beacon-tip` (`genesis-secrets.ts:94`). That check runs after the encryption-key check passes (`:73`). So the published scalar does reproduce seat 0's encryption key.
- `docs/07:222` says genesis keeps sealed shares, and a recovered encryption key opens them.
- Anyone holding the log could therefore open seat 0's escrow share of seats 1–3.
- Every original holder's share is required (`recovery-release.ts:381`, `docs/07:221`). With one share public, one fewer colluder is needed against each other dealer's master.
- If seat 0's lock keys are consistent, they also become public, which reduces the locking layers that protect other players' dealt cards.

Recoverers already learn all of this. The added exposure is to people outside the game.

**A mitigating precedent.** An end-of-game reveal already accepts a public master string (`genesis-secrets.ts:57-61`). In that case, though, every seat reveals together; a void would reveal only one.

**Smallest safer alternative:** a certified, unattributed `recovery-void`.
- It carries no scalar.
- It is bound to the genesis digest, the exact parent, the `history.pending` ref and a fixed reason.
- The current voter quorum certifies it, the same way as the existing "vote to end the game early" (`docs/07:215`).
- It records `seat: null`, following `audit-types.ts:9`.
- Each honest recoverer keeps a local "custody mismatch" flag against the dealer, following the local `CHEAT_PROOF` history model.

This ends the pending state without publishing anything. It does not give anyone new power, since a quorum can already end a game early. Publishing the scalar for public attribution would then be an explicit, separately approved policy.

## 2. Nothing in the current code treats a void as terminal (defect in the proposal as specified)

Every terminal gate keys on engine state or on `pending`:
- `recovery-membership.ts:215` checks `state.result`.
- `p2p-session.ts:188` and `:1601` set `complete` only when `state.result` exists, and `running` otherwise. So after a void, `maybeAutomatic` (`:1606-1610`) would keep scheduling bot and automatic proposals.
- `log.ts:155-159` blocks gameplay only while `recovery.pending` is set:
  - If the void clears `pending`, gameplay resumes.
  - If the void keeps `pending`, the log still accepts `seat-online` (`log.ts:174`), transfer changes (`:196`) and new authorization amendments (`recovery-membership.ts:249`).

**Needed:**
- A replay-installed terminal record, such as `LogContext.void`, containing the void ref, the dealer (for attributed voids only) and the reason.
- A check on that record at the top of entry validation, before `log.ts:155`. Reject everything except any read-only kinds you choose to keep.
- A third session status, `void`, distinct from `complete`.
- The void entry must preserve `stateHash`, as cheat-proof entries do (`log.ts:259-261`).
- The audit must report `ok: false` and `terminal` pointing at the void, with no engine winner.

## 3. The recoverer no longer has the scalar when it would need it (defect)

- On a mismatch, `produceRecoveryCheckFromShares` wipes the masters in `finally` (`recovery-check.ts:101-103`).
- `persistRecoveryPrivate` runs only after `reconstructPrivateSeats` succeeds (`:215-242`).
- So after `master-beacon-tip` there is no retained scalar, and nothing in the excerpts retains the releases either.

The proposed entry therefore needs a new path that re-runs `recoverAuthorizedMaster` (`recovery-release.ts:370-422`) from retained releases just before signing, with its own wipe discipline.

Encoding the scalar into a canonical entry also creates an unwipeable string. The comment at `genesis-secrets.ts:51-52` deliberately avoids that for non-public masters. This is acceptable only if finding 1 is approved.

## 4. `verifyRevealedMaster` cannot classify faults as it stands (defect for the proposed use)

- **Ordering.** The derivations for the encryption key and beacon tip (`genesis-secrets.ts:66-98`) run before the deck context is validated (`:100-117`). The shuffle and lock checks then loop over every card. The proposal's "cheap checks first, context errors are not owner faults" rule needs the ledger/genesis-digest and `nextPass` checks moved ahead of any HKDF.
- **Classification.** Owner-fault codes share a single `Result` namespace with context and input errors:
  - context and input errors: `master-deck-context`, `master-deck-pending`, parse failures and the bare `catch` at `:135`;
  - owner faults: `master-encryption-key`, `master-beacon-tip`, `master-shuffle-key` and `master-lock-key`.

  Replay should allowlist exactly those four owner codes and treat everything else as non-attributable.
- **Silent skip.** `if (chain)` at `:86` skips the beacon check when a seat has no chain. That is correct, but "no chain" must never turn into a beacon attribution.
- **Ledger source.** Pass the certified parent's `crypto.decks` (the value flowing through `log.ts:236`), never session state, so every replica derives the same verdict.

## 5. Attribution and binding details (defects if omitted; one open decision)

- **Attribute the right key.** Name the genesis owner key (`genesis-secrets.ts:45`, `owner.publicKey`), not the seat's current controller. A fresh-key transfer may have moved seat 0, and the genesis dealer signed `masterPub`, the tip and the keys.
- **Bind to the exact pending authorization.** Resolve it with `find` on `history.pending` (`recovery-membership.ts:244-248`). The dealer seat must be in that authorization's `replacements`. With several affected seats, one void covering the first failing seat is enough; state that explicitly.
- **Epoch (open decision).** `validateRecoveryTransition` requires `nextEpoch === epoch + 1` (`:233`). A void should be epoch-neutral and certified by the *current* voter set, so it needs its own statement schema and parent check rather than reusing that path.
- **Existing preconditions.** Keep `decksReady` (`:209`) and the transfer-pending rejection (`:217`) in force for the void.

## Recommendation

Implement the scalar-free, unattributed certified void from finding 1, together with the terminal gating in finding 2. Treat public attribution (findings 3–5) as a follow-up that goes ahead only if the takeover disclosure policy explicitly allows publishing the scalar.
