# Hexfield startup foundation review

**Verdict: no blocking issue within the stated scope.** The mandatory checks are in place:

- New verified genesis must carry `onlineStart`, and it runs before the policy callback.
- Protocol v2 is enforced at admission.
- Device-to-seat ownership, bot-host translation, the ordered roster, cross-seat key uniqueness and fixed-mode binding are all enforced.
- The journal installs the key binding atomically.

There are two medium issues (one confirmed, one conditional on code I can't see) and several low ones.

Line numbers are approximate, counted from the pasted files, so they are marked ≈.

## Medium

### M1. Game transport trusts caller-supplied agreement and bindings instead of the certified `onlineStart`

**Where:** `apps/web/src/session/online-game-transport.ts` ≈L40–60, in `createOnlineGameTransport`.

**Problem:** The device↔game routing map comes from `options.agreement` and `options.bindings`. These are only compared to genesis on:

- `config`
- `ceremonyNonce`
- `seats`
- `masters`

`genesisSeats` contains no device identities, and bindings have no game-key proof of possession. So a different, fully valid agreement plus bindings can produce byte-identical `genesisSeats` while mapping honest game keys to other devices.

**Failing trace:**

1. An attacker controls sybil devices D0′ and D1′.
2. The attacker builds a lobby state with the same `lobbyId`, names, colours, config and nonce, with D0′ and D1′ seated. Both ACK it.
3. D0′ and D1′ sign bindings that claim the honest game keys G0 and G1, plus the certified F0 and E values. These points are public in genesis.
4. `verifyGameSeatBindings` passes, because nothing requires the device to own `gamePeer`. `sameValue(genesis.seats, genesisSeats)` also passes.
5. If this pair reaches the wrapper, traffic addressed to G0 is routed to D0′. Frames from D0′ are delivered as `from = G0`.
6. The genesis carries a different `freezeHash` in `onlineStart`, but it is never compared.

Signed gameplay payloads limit this to eclipse/DoS and misattributed unsigned traffic. It is still a hole in the wrapper's stated invariant.

**Fix:** Derive the map from the admitted genesis only, for example `validateGenesisOnlineStart(validatedGenesis.genesis)`. Better, have `validateGenesis` return the `VerifiedOnlineStart` inside `ValidatedGenesis`, and remove the `agreement`/`bindings` options. At minimum, require `sameValue(options.agreement, genesis.commitments.onlineStart.agreement)` and the same for `bindings`.

**Test gap:** The transport fixture forges `ValidatedGenesis` with no `onlineStart` and `signatures: []`. No test covers an alternate agreement that yields identical seats.

### M2 (conditional). One-nonce ↔ one-freeze is not durable, and seed shares are not bound to the freeze

**Where:**

- `packages/protocol/src/lobby.ts`: `ackedAttempts` and `startedNonces` are in-memory fields (≈L330), checked in `ackFreeze` (≈L560).
- `packages/protocol/src/genesis-seed.ts` ≈L113: the share context is `{ceremonyNonce, seat}`.
- `shareCommit` omits both `freezeHash` and `gamePeer`.

**Failing trace:** This assumes `prepareCeremonyMaterial` returns persisted material keyed by nonce, not by `freezeHash`. That is the natural crash-resume design.

1. A hostile host freezes state S1 with nonce N, and the victim ACKs.
2. The ceremony reaches seed reveal, and the victim's share becomes public. The host then aborts.
3. The victim reloads, so `ackedAttempts` is empty.
4. The host reopens and freezes S2 with the same nonce N. The victim ACKs, since the nonce-conflict check is gone.
5. The same master and nonce produce the same share. The host already knows the victim's share before committing its own, so it controls `genesisSeed` (the board).
6. The same reuse would also expose deck, beacon and escrow derivations keyed by nonce.

**Fix:**

- Put `freezeHash` (and `gamePeer`) in the `deriveBytes` context and in `shareCommit`.
- Persist nonce → freezeHash before emitting an ACK, or key ceremony material by `freezeHash` and refuse a second freeze for a seen nonce.
- Whether this is exploitable today depends on `prepareCeremonyMaterial`, which I did not see.

## Low

### L1. `signVerifiedGenesis` can consent to a body that admission will reject

**Where:** `packages/protocol/src/genesis.ts` ≈L45–70.

**Problem:** It never checks `protocolVersion === PROTOCOL_VERSION` or `engineVersion === ENGINE_VERSION`. The schema accepts any number: the existing test gets `version-mismatch` for 99, not a schema error. Bindings check their own `protocolVersion` field, never `body.protocolVersion`.

It also skips the engine-side admission checks:

- `createGame` / invariants
- empty hands
- deck catalogue vs engine decks
- colour uniqueness

**Failing trace:**

1. A host sends a final draft labelled `protocolVersion: 1`, with otherwise valid transcripts.
2. An honest peer irreversibly consents.
3. `validateGenesis` then fails with `version-mismatch`.
4. Per the plan, post-consent the peer cannot return to the lobby or release masters. This is a liveness trap, and it produces a signed "v1" verified consent.

It is only reachable if the final draft isn't compared field-by-field against the locally pinned manifest, or if `deckCeremonyId` doesn't cover the versions.

**Fix:** Add the version checks to `signVerifiedGenesis`. Better, factor the structural and engine checks out of `validateGenesis` and run them before consent.

### L2. Journal key binding is only checked on read paths

**Where:** `packages/storage/src/indexed-db-protocol-journal.ts`, `saveSafety` ≈L230 and `commit` ≈L260.

**Problem:** Both transactions omit `BYTE_STORE` and never re-check the binding. If the key record is removed or replaced after `load`/`loadSafety` (for example by a forget-game path in another tab), votes and commits still advance under the old key.

**Fix:** When `#keyBinding` is set, include `BYTE_STORE` in these transactions and verify `matchesKeyBinding` before writing.

### L3. A throwing listener in the game transport breaks delivery

**Where:** `online-game-transport.ts`, `receive` ≈L200 and the peer-change fan-out ≈L100.

**Problem:** One throwing subscriber stops delivery to the remaining listeners. It also propagates into the shared device transport's dispatch, which can starve its other subscribers (ceremony, lobby).

**Fix:** Wrap each listener call in try/catch, as `LobbyController.emit` already does.

### L4. Freeze agreement ACK order is not canonical

**Where:** `lobby.ts`, `verifyLobbyFreezeAgreement` ≈L285.

**Problem:** It accepts ACKs in any order and returns them sorted. `onlineStart.agreement` inside the genesis digest is hashed raw, so the same consent can have several genesis encodings. This isn't exploitable, since humans sign one exact digest, but it contradicts the plan's "sorted by seat".

**Fix:** Reject unless the `acks[i].body.peer` order matches the human seat order.

### L5. `initialize` doesn't compare the existing genesis to the supplied one

**Where:** `IndexedDbProtocolJournal.initialize`.

**Problem:** On an existing journal it returns `false` without comparing the stored genesis entry to the argument. The same `gameId` implies the same body, but not the same entry `sig`/`sequencer` bytes. A caller treating `false` as "my entry is installed" could diverge.

**Fix:** Compare `entryHash` (or the bytes) and throw on mismatch.

## Assumptions and missing context (not findings)

- **Key knowledge not proven.** Bindings carry no proof of knowledge for `gamePeer`, `masterPub` or `encryptionKey`. That is safe only if escrow and deck proofs bind F0/E to knowledge of the master, and nothing aggregates `masterPub`s (rogue-key risk). I couldn't see `validateGenesisEncryption`, `validateGenesisMasters` or the escrow code.
- **Deck ceremony ID contents.** `deckCeremonyId(body)` is assumed to exclude `genesisSeed`, `createdAt` and all commitments, per the plan. Otherwise the seed hash could be ground.
- **Key-record placement.** `initialize` refuses if the key record already exists. So the ceremony must not persist the voting-key record under `recordKey` before journal initialization, which seems to conflict with "`prepareCeremonyMaterial` persists before disclosure". This is an integration concern.
- **Out of scope as instructed.** I did not report the commit-before-reveal ordering, last-revealer bias, or UI display of `seedMode: fixed` to guests.
