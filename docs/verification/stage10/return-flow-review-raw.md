# Review: certified bot-takeover return patch

**Verdict:** I found no security defect in the visible code that would let the wrong party return a seat. There is one concrete liveness defect in `startTransfer` that should block merge. One wipe pattern needs a check, and it becomes blocking if `validateMaterial` aliases context data. Several behaviours depend on files that aren't in this bundle; I list those separately and don't treat them as clean.

---

## Blocking

### 1. `startTransfer` rejects before a cancelled attempt can be cleaned up (liveness)
In `apps/web/src/session/online-room.ts`, the new check runs before the existing cancelled-attempt cleanup:

```ts
if (snapshot.invite.body.seat !== seat || snapshot.invite.body.mode !== mode)
  return Promise.reject(new Error('Another transfer attempt is already open'));
if ((snapshot.phase !== 'cancelled' && ...) || snapshot.busy) ...
void this.transfer.close();
```

- **Cancelled attempt blocks the other kind.** A live attempt in phase `cancelled` with `!busy` used to be closed on the next `startTransfer`. It now blocks any return attempt, and a cancelled return attempt blocks live.
- **Fix:** close cancelled, non-busy attempts first. Only reject a mismatched seat/mode when the existing attempt is still active.

Two related problems:

- **`transferOpening` ignores the target.** `if (this.transferOpening) return this.transferOpening;` returns an in-flight open for a different seat or mode. Compare the target, or reject.
- **Saved invites can orphan all transfers.** `OnlineTransferBrowser.openSource` now throws `'Saved transfer invitation differs from this game and seat'` when the saved current invite's `mode` or `seat` differs. Before this patch that couldn't happen within one game, because seat was always `game.seat` and mode was implicit.
  - Suppose a saved `return` invite outlives its eligibility: the seat was returned, re-hosted, or dropped out of `returnableSeats`.
  - The return button disappears, and every live `startTransfer` then fails in `openSource`. The reverse also applies.
  - **Needed:** a path to cancel or discard a saved invite with no certified pending authorization, or confirmation that one already exists outside this bundle.

### 2. `wipePrivate(owned)` deep-zeroes an object you may not fully own (conditional, integrity)
In `online-transfer-destination.ts`, the `#returnIntent` `finally` block recursively zeroes every `Uint8Array` reachable from `owned`, the output of `validateRetiredTransferBinding`, which comes from `validateMaterial(value, masterContext, …)`.

- **Risk:** if `validateMaterial` copies or references any byte arrays from `masterContext` into the result, this wipe corrupts `this.#bootstrap.replay.context.log` in place. Examples would be completed deck commitments, which the doc comment says the master context "supplies".
- **`decoded` is safe.** It is a fresh `canonicalDecode` result that you own, and valibot passes the same `Uint8Array` references through, so wiping `decoded` already covers the parsed secrets.
- **Fix:** drop `wipePrivate(owned)`, or wipe only the known secret fields, such as `seats[*].signingKey`.
- **Also note:** if `signingKey` is a string, none of these wipes affect it.

---

## Should fix (non-blocking; the validator stops misuse, but the UI offers attempts that are bound to fail)

### 3. `returnableSeats` doesn't match the validator
Compare `packages/protocol/src/p2p-session.ts` with `transfer-membership.ts:142-162`:

| Condition | Validator | `returnableSeats` |
|---|---|---|
| Which root | **Last** root for the seat (`toReversed().find`) | **Any** root (`returnRoots.some(...)`) |
| Seat position | `eligible[0]?.seat === statement.seat` | Not checked |
| `finalAuthorization` | Must equal `statement.recovery?.authorization` | Requires `!== null` |

Consequences:
- **Stale root:** a seat whose older root is activated but whose last root isn't would still show a return button.
- **Ordering:** a seat that isn't first in its root's eligible list would show a button that can never certify.
- **Null authorization:** seats whose recovery legitimately has a null `finalAuthorization` would be hidden.

Mirror the validator's exact predicate. Ideally, share one helper between the two.

### 4. The return confirm path does no local pre-check
In `online-transfer-exchange.ts` `confirm()`, `approved = offer` for return. The source never verifies these against its current certified state before the user confirms and it submits:
- the `returnIntent` signature
- that `statement.recovery` matches the last root
- that this device is still the host

Security holds because the protocol validator checks all of this. The cost is that a host change or re-recovery between open and confirm surfaces only as a certification failure after confirmation. A worker `validateReturnOffer` check before `awaiting-confirmation` would fix this.

### 5. The destination reserves scope before checking eligibility
In `prepareOffer`, `#replace(... scope ...)`, `phase = 'offered'` and the fresh credentials all happen before `#returnIntent` runs. A device that isn't the former human therefore leaves a persisted, reserved `return` scope that can never succeed. Run the root and device checks from `#returnIntent` before reserving.

---

## Verified as sound in the visible code

- **Retired key provenance.**
  - The size cap (16 KiB) is checked before `canonicalDecode`.
  - The installing generation is found by certified replay (`key !== previous && key === root.lastHumanGameKey`, plus the genesis case).
  - `validateRetiredTransferBinding(decoded, installed, current)` enforces the same genesis, `installed.head.seq <= current.head.seq`, and an active human with a route.
  - It then cross-checks `owned.devicePeer === root.lastHumanDevice` and `human.peerId === root.lastHumanGameKey`.
- **Stale or replayed returns.** The intent signs the full statement under `TRANSFER_RETURN_INTENT_DOMAIN`, which includes the destination's new keys and recovery ancestry. The validator requires the last root and a currently active bot seat. After activation the new key becomes the next root's `lastHumanGameKey`, so an old intent can't be reused against a later recovery.
- **Invite mode binding.**
  - `mode` is in the signed `bodySchema` (a strict picklist).
  - The domain and protocol are bumped to v6, so v4 invites can't be reinterpreted.
  - `openSource` compares the saved invite's `mode`.
  - The record store binds `offer`/`approved` `statement.mode` to `body.mode`.
  - The source requires `offer.statement.mode === options.mode`, with `returnIntent` only for return and never for live, and no `ownerIntent` or `humanApprovals`.
- **Live guard.** `mode === 'live' && seat !== game.seat` is rejected.
- **Host-only admission.** It is gated both locally (genesis human, engine status `bot`, worker `returnableSeats`) and by the validator's host constraint.

---

## Can't be assessed from this bundle (please confirm)

1. **Destination mode propagation.** `TransferDestinationScreen.tsx` and the destination construction of `DestinationTransferExchange` aren't shown. If `invite.body.mode` isn't passed through, the fallback `this.options.mode ?? 'live'` makes every return fail. Consider making `mode` required in `CommonOptions`, since the optional default fails open to `live`.
2. **Recovery fields in the return statement.** Check that `deriveScope(..., 'return')` fills `statement.recovery` with the last root's `finalAuthorization` and `activation`.
3. **Submission path.** Lines 390 and later of `retryNow` aren't shown. Check that the return authorization is actually submitted when `authorizeLiveTransfer` is skipped, and doesn't wait on a worker-side record that only live mode creates.
4. **Private disclosure ordering.** Check that the source sends the sealed bot and seat private package only after the authorization is certified, which is when the validator has checked `returnIntent`, and never on `bootstrap` or before confirm.
5. **Post-activation erasure.**
   - The retired key in `online-game/<genesisDigest>/keys` must be replaced or erased when the same device is promoted. If it survives under a different key namespace, a later second recovery finds the older key, `human.peerId !== root.lastHumanGameKey`, and returns can never succeed again.
   - The host must also erase its bot secret for the returned seat.
6. **Same-device promotion.** The former human's device still holds the old game record and may have an `OnlineRoom` open, possibly via `room-registry.ts`. Confirm that promotion stops or blocks that room, and doesn't race it on the same storage keys.

---

## Optional

- `#returnIntent` replays the whole certified prefix on every `prepareOffer` call. Consider caching the result per bootstrap head.
- `installed = next.log` assumes the replay hands out immutable per-step contexts. If contexts are mutated in place, validation fails because the human is no longer active: a liveness problem, not a security one. A targeted test would pin this down.
- In the `OnlineGameScreen` effect, `returnSeats` isn't reset when `room.returnableSeats` is absent, and buttons stay visible while `transferStatus.pending` is set.
