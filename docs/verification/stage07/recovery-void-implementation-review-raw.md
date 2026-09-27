# Recovery void review: findings

## 1. A wrong local secret or an unverified share can yield a signed void (missing context; potentially critical)

**Where:** `packages/protocol/src/recovery-void.ts`, `produceRecoveryVoidCheckFromShares`, lines 80-82 and 116-135.

The producer checks the signing key against the certified recoverer key (116-122). It does nothing comparable for `recipientEncryptionSecret`. It also re-parses releases with the schema only (`recoveryReleaseSchema`). It never calls `verifyRecoveryRelease`, never checks `recipientSeat === localSeat`, and never checks that each affected dealer has exactly one release from every original holder. The "complete holder set" gate exists only in the caller (`recovery-participant.ts:277-285`). The function is exported and called directly in `recovery-custody-mismatch.test.ts:227`.

**Counterexample:** Suppose `recoverAuthorizedMaster` does not verify each decrypted share against the dealer's escrow commitment. Then a stale or wrong `encryptionSecret()` produces garbage scalars and a wrong master. `verifyRevealedMaster` then reports `master-*-key`, and an honest recoverer signs and persists a void. The same happens if one holder releases a validly signed wrong share.

**Confirmed vs. missing context:**
- Confirmed: the producer itself lacks these checks.
- Missing context: whether `recoverAuthorizedMaster` (not supplied) already enforces them.

**Smallest fix:** Inside the producer, before reconstruction:
- run `verifyRecoveryRelease(release, context)` on every release;
- require `body.recipientSeat === localSeat`;
- require exactly one release per (affected dealer, original holder);
- derive the public encryption key from `recipientEncryptionSecret` and compare it to the certified recipient key.

Any share-commitment failure must return a non-void error code.

## 2. Honest recoverers are struck for stale-parent checks (confirmed)

**Where:** `packages/protocol/src/replicated-log.ts`, `receiveRecoveryVoidCheck` (1495-1507) and `receiveRecoveryCheck` (1470-1486).

Before striking, these handlers only check digest, `pending`, and sender. `rememberVoidCheck` fails with `recovery-inbox-binding` whenever `statement.parent` differs from the receiver's head (`recovery-inbox.ts:227-235`). That failure goes straight to `strikePeer(from)`.

**Counterexample:**
1. Recoverer A signs a void check at parent P and broadcasts it.
2. The receiver has already committed a `seat-offline` entry and is at P+1, or is still lagging at P-1.
3. The receiver rejects the valid check with a binding error and strikes A.

Repeated retransmits accumulate strikes, and the unanimous void (or activation) can then never form. Compare `receiveRecoveryRelease` (1440-1449), which silently drops out-of-scope packets.

**Smallest fix:** In both handlers, return `success(undefined)` without striking when `check.statement.parent`, `authorization`, or `genesisDigest` differs from the current head or pending ref. Strike only on signature or schema failure for a current-scope statement.

## 3. No durable mutual exclusion between activation and void at the same parent (confirmed gap, low)

**Where:**
- `recovery-void.ts:173-183` writes only the `recovery-void-check/...` slot.
- `recovery-participant.ts:229-250` consults the void slot, and 251-275 consults the check slot.

The producer never checks whether `recovery-check/<same scope>` already exists. Exclusivity relies entirely on reconstruction being deterministic and on the in-memory inbox guard (`recovery-inbox.ts:206, 252`).

**Counterexample:** A recoverer signs an activation check at P, restarts, and receives a different share set. That can happen if finding 1 holds, or through a direct caller. It then signs a void at P too. If the other recoverers sign both as well, the proposer can choose which terminal outcome to certify.

**Smallest fix:**
- In `produceRecoveryVoidCheckFromShares`, fail with `recovery-void-conflict` if `store.load(recovery-check/<scope>)` is non-null before signing.
- Add the symmetric check in `produceRecoveryCheckFromShares`.

## 4. Session and replica paths not gated on void (missing context)

**Where:**
- `p2p-session.ts:1607`: `schedulePrivateTimeout()` runs unconditionally after the void is applied.
- `replicated-log.ts`: `maybePropose` (2207-2218) and `prepareMasterReveals` (1638-1663, including the `coordinator.reveals()` retransmit) are gated only through `offerAvailableInput` (2168).

**Counterexample:** A timer, heartbeat, or retransmit path calls `maybePropose` or `prepareMasterReveals` directly after the void. That would keep proposing entries that can never certify, or broadcast `MASTER_REVEAL` after the void, which violates the "no master reveal after void" policy.

`validateNextEntry:134` blocks certification, but it does not block network output.

**Smallest fix:** Add `if (this.context.log.recovery?.void) return success(undefined);` at the top of `prepareMasterReveals` and `maybePropose`. Make `schedulePrivateTimeout` a no-op when `status.kind === 'void'`.

## 5. The void gate masks stale-entry classification (confirmed ordering, impact depends on callers)

**Where:** `log.ts`, `validateNextEntry`, 134-139.

The `game-void` check runs before `stale-entry` and `missing-ancestor`. Once a node has the void, any lagging peer's proposal for seq ≤ the void's seq is reported as `game-void` instead of `stale-entry`.

**Counterexample:** Suppose the accusation or strike logic (not supplied) treats `stale-entry` as benign but other rejections as proposer fault. Then honest lagging proposers get penalized right after a void.

**Smallest fix:** Move the void check after the two seq checks, so it applies only to `entry.seq === head.seq + 1`.

## What checked out in the supplied code

- **Parent and authorization binding:**
  - `certifyVoid` binds `parent` and `authorization`, requires that `dealerSeat` is an affected seat, and requires the exact recoverers to all sign.
  - It also preserves engine state, leaving `result` null.
- **Terminal gates:** later entries are blocked (`log.ts:134`), and `recovery` is included in the snapshot hash (`replay.ts:238`).
- **Session status:** the session enters `void`, and audit is gated on `complete`.
- **Durable before output:** persistence happens before output, with a head recheck.
- **No secrets in the statement:** it contains no scalar or master.
- **Bounded pre-verification work:** inbound packets are limited by per-peer, per-parent admission.

Not supplied, so not assessed:
- `signedByAll`: whether it rejects duplicate or extra signatures.
- The snapshot-install path.
- `advanceTransferRecovery` for `recovery-void`.
