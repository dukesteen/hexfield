# Online start implementation review

The bundle has no line numbers, so findings are located by symbol. Line numbers are given only where I could count them reliably.

**Verdict:** I found no break of share secrecy or consent irrevocability. **M1 blocks release.** It makes about 1 in 32 online starts fail with IndexedDB, and those starts cannot be retired. M2 needs a malicious participant and should be fixed before release. The Low items harden durability and are not blocking.

## Medium

### M1. Lock names that begin with `-` or `_` are rejected (release-blocking availability)

**Where:**

- The check: `packages/storage/src/indexed-db-byte-store.ts:6` (`KEY_PATTERN`), applied to the raw id in `withCeremonyLock` through `validateKey(ceremonyId)`.
- The callers that pass a bare `deckCeremonyId`:
  - `EscrowCeremony.#locked`
  - `retireEscrowCeremony`
  - `OnlineCeremony.#sendSlotWithinAttempt`

**Sequence:**

1. The ceremony id is declared as `key32Schema` in the approval, beacon, registry and envelope schemas. That is base64url, so its first character is uniformly one of 64 symbols.
2. When that character is `-` or `_` (a 2/64 chance), `KEY_PATTERN` requires `^[A-Za-z0-9]` and the lock call rejects.
3. `approveAndSend` then returns `escrow-ceremony-lock`. No approval is ever produced, including in one-human games, which still have approvals.
4. Each retry fails the same way until the 20 s timeout. `#abortUnsafe` then calls `escrow.abort()`, which fails in `retireEscrowCeremony` for the same reason. The attempt stays active and in `error`.

The ceremony tests use `MemoryEscrowLifecycleStore` only, which does not validate keys. The encoding of `deckCeremonyId` is outside the bundle, so confirm it. The schemas strongly indicate base64url.

**Fix:** Validate lock ids with their own grammar, or pass them through an injective prefix before checking, for example `validateKey(\`lock/${ceremonyId}\`)`. Add an `IndexedDbByteStore`regression test with a ceremony id that starts with`_`.

### M2. Invalid-envelope evidence after consent suspends a certified genesis that disclosed nothing

**Where:** `online-ceremony.ts`, through this path:

1. `#receiveEscrowPacket`
2. `#publishInvalidEnvelope`
3. `#acceptInvalidPacket` (the `'consented'` branch)

It also involves the early return in `#advance` and `#resumeEscrowDisclosures`.

**Assumption:** The attacker controls a legitimate dealer device key.

**Sequence:**

1. The genesis becomes `ready`.
2. The dealer device signs a new, publicly invalid `escrow-envelope` packet for a holder slot. That holder has already accepted a valid envelope, and the valid envelope is in the certified genesis.
3. `#receiveEscrowPacket` has no consent or prior-slot check. The holder therefore publishes `escrow-invalid` evidence.
4. Every peer's `#acceptInvalidPacket` gets `escrow-ceremony-completed` from `escrow.abort()`. It then sets `#result = null`, adds the evidence to `#disclosureBytes`, and emits `waiting`.

**Effects:**

- `#advance` now returns before the `#result` branch. The sequencer therefore stops retransmitting `genesis-entry`, and any peer that has not yet received it is stranded.
- `OnlineStartup` only halts on `online-ceremony-disputed`. A running game continues, which is correct because no share leaked. A peer between `ready` and activation, however, never opens the game.
- After a restart, `#resumeEscrowDisclosures` restores this non-disclosure as blocking, so no result is ever produced again.

**Fix:** In `#acceptInvalidPacket`, when the lifecycle reports consenting or completed, persist the evidence and optionally broadcast it once. Do not clear `#result` and do not add the evidence to `#disclosureBytes`. Only `escrow-dispute`, which reveals a shared point, should suspend a consented ceremony. Make `#hasSavedDisclosure` and `#resumeEscrowDisclosures` treat `escrow-invalid` as blocking only when the attempt is retired.

## Low

### L1. Abort decisions depend on in-memory `#escrow`, not durable state

`#abortUnsafe` consults the escrow lifecycle only when `this.#escrow` is set.

**Sequences:**

- **(a) Restart after timeout.** When a manifest is pinned and no disclosure exists, `start()` calls `#restoreConsentBarrier` and then `#abortUnsafe` with `#escrow === null`. The attempt is retired, but the escrow registry is not. That breaks the "retire on abort" contract, and the reservations stay `active`.
- **(b) Two instances on one attempt.** The room lease normally prevents this. The barrier check and the retirement take the attempt lock separately. If the other instance consents between them, a consented device retires its own attempt. It then cannot open, or sequence, the genesis it signed.
- **(c) Crash between `escrow.abort()` and the attempt compare-and-swap (CAS).**
  - After the timeout, `#restoreConsentBarrier` returns `escrow-ceremony-retired` as a hard error, and `start()` fails permanently.
  - Before the timeout, the pre-escrow public packets of a retired ceremony are rebroadcast.

**Fix:** Use one locked retirement routine in both `start()` and `#abortUnsafe`:

- If a manifest is pinned, load it and run the lifecycle retirement against it.
- Treat consenting or completed as "consented": set `#locallyConsented = true`, which the current code only emits.
- Treat already-retired as success.
- Then perform the attempt CAS.

### L2. Any authenticated sender can abort a waiting slot, and a failed roster freeze is never retried

`#receive` calls `#abortUnsafe` when a packet's `senderDevice` does not own the slot. It never checks that `from` is a frozen human. `OnlineStartup.advance` sets `this.approved` before calling `freezePeers`. If `freezePeers` throws, `retryFailed` skips it, and the unseated links survive for the rest of the ceremony.

**Fix:**

- Drop, without aborting, packets from a device that is not the slot owner or not a frozen human.
- Assign `approved` only after `freezePeers` succeeds.

## Rechecked and sound

- **Durable before send.** `#outgoing`, `#acceptInvalidPacket` and `#acceptDisputePacket` persist before `#broadcast`. Pre-consent disputes retire before they are published. Replays are deterministic except `created-at`, and that slot is never sent before it is stored.
- **Lock order.** Every escrow lock is taken inside, or independently of, the attempt lock. I found no reverse nesting and no same-name re-entry.
- **Share routing.** Envelopes go only to the holder device, and `#receiveEscrowPacket` rejects envelopes for other holders. Disputes require all of: the holder device, the holder game key, a dealer-signed envelope, and a DLEQ proof.
- **Post-consent escrow send suppression is safe.** Beacon tips need every human, so no device can consent until every human has finished escrow.
- **Startup halt.** The abort signal disposes game transport synchronously. The revoked flag stops activation, lease and journal creation, and retry. Consent is not retired.
- **Prior dispositions.** M1 (certified routing) and M2 (pin before ACK) hold in this handoff.

## Hardening and integration gaps (not implementation bugs)

- **Agreement pin.** `OnlineStartup` pins the agreement under the displayed state's `freezeHash` but never asserts `hash(approved.state) === freezeHash`. Add that check.
- **Disclosure check on open.** `openOnlineGame` does not check durable escrow disclosures. It is safe today only because startup always reruns the ceremony. Refresh/rejoin or saved-game resume must add this check under the game lease.
- **No retirement signal to peers.** A device that has consented waits indefinitely when a peer retires. There is also no user cancel that calls `abort()`.
- **Timing budget.** The 20 s budget covers the whole ceremony from each device's local start. Every packet reruns `#advance`, which re-verifies all envelopes and ACKs through `validateGenesisEscrow`, rebuilds deck commitments, and parses the device registry several times. That registry is never pruned and can reach 16 MiB. None of this has been measured with real WebRTC and a wall clock.
- **Key lifetime.** The ceremony, holding masters and signing keys, stays alive for the whole game. This is already tracked.
- **Test coverage.** Tests use the memory store only. Browser startup is tested with two humans only. There are no tests for post-consent `escrow-invalid`, for a crash between retirement and the CAS, or for two coordinators racing on one attempt.
