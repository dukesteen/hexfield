# Certified seat transfer and recovered-seat return

The first friends-playable multiplayer beta shipped without seat transfer. This document specifies the next implementation in phases; none of its transfer entries or runtime paths exist yet. The first pinned read-only review is in `seat-transfer-review-raw.md`. The storage and identity choices below resolve its open questions, pending a follow-up review.

This is an implementation design for [stage 10, sections 3.4 and 5](../../10-persistence-reconnection.md). No transfer entry or runtime exists yet. The existing `membership` payload accepts only `recovery-authorize` and `recovery-activate` in `recovery-membership.ts`; a saved genesis device binding cannot authorize a later device by itself.

## Current invariants to retain

- `SeatAuthorities` is replay-derived. Its `usedPublicKeys` reserves retired voting keys, `activatedAt` identifies the controller generation, and `carriedOperations` binds old in-flight proof IDs to exact certified anchors (`authority-types.ts`, `authority.ts`). The original genesis master and encryption commitments never change.
- An old voter set certifies its membership entry. The new set takes effect at the following height; `proposal.ts` derives voters from active human controllers. Recovery already increments the crypto and authority epochs together and checks a fresh replacement key before activation (`recovery-membership.ts`).
- Genesis `onlineStart` binds each device identity to an independent game voting key (`online-bindings.ts`). `online-game-transport.ts` currently holds that mapping for the whole session. `WebRtcTransport.freezeRoster()` forbids adding a new device after the ceremony. Both need a certified route-update path before a destination can send game frames.
- `IndexedDbProtocolJournal` stores the certified entry and next-height consensus safety in one transaction and binds the journal to a separate voting-key record (`indexed-db-protocol-journal.ts`). Its sole binding is currently under `online-game/<genesisDigest>/keys`; a mismatched binding makes `load()` fail. `online-game.ts` acquires a writer lease named with both game and current voter key. That does **not** serialize an old and a new voter generation on the same origin. Transfer needs a separate staging store and a game-wide promotion lease. A destination never imports the source's voting key or safety tuple.
- `reconstructPrivateSeats` verifies a complete certified prefix and each supplied original master against genesis, then replays the requested private perspectives. `loadRecoveredHost` also checks the exact durable head before returning a driver. A private hand snapshot alone is never an authority or an import.

## Signed evidence and replayed state

Add `transfer-authorize`, `transfer-activate` and `transfer-cancel` to a bounded, strict `membership.change` variant. Keep a replayed `TransferState` with at most one pending authorization, current human `devicePeer` routes, and a bounded completed-ref cache. Seed routes only from validated genesis `onlineStart`; legacy non-online genesis has no device route. The certified log remains the authority for old controller and route history. If a required completed recovery or prior transfer has fallen out of the cache, replay that certified prefix and check its entry hash. Never treat cache pruning as erasure of identity evidence, and fail closed if the prefix is unavailable. Cap pending and cache counts, statement bytes, and affected seats; use `parseCanonical` strict schemas as recovery does. Do not accept a caller-supplied route map.

This version supports one seated human controller per device per game. A browser already bound to a different seat's active journal cannot import another seat as an active controller; moving multiple local seats needs a separate design. The signed `validUntilSeq` bounds **certification of the authorization**, not the lifetime of a certified pending transfer. Once certified, pending persists until an exact-ref activation or cancel. No network timer or local deadline changes that state.

The authorization statement is the exact canonical signed object below. `EntryRef` is `{seq,hash}`. `mode` distinguishes an active-human move from an activated recovered bot returning to human control. `anchor` is an immutable certified intent anchor. The entry may have a later parent, within the signed sequence limit, if no controller, route, epoch, recovery or transfer state relevant to this seat changed since the anchor.

```ts
interface SeatTransferAuthorizationStatement {
  protocol: 'seat-transfer-v1';
  genesisDigest: string;
  anchor: EntryRef;
  validUntilSeq: number; // no more than anchor.seq + 64
  mode: 'live' | 'return';
  seat: Seat;
  currentController: {
    publicKey: PeerId;
    kind: 'human' | 'bot';
    activatedAt: EntryRef;
    hostSeat: Seat;
  };
  recovery: { authorization: EntryRef; activation: EntryRef } | null;
  // Required only for return; authorization is the final recovery amendment.
  nextEpoch: number; // current epoch + 1 at activation
  destination: {
    devicePeer: PeerId;
    gamePeer: PeerId; // fresh Ed25519 voting/command key
    transferEncryptionKey: string; // fresh nonidentity group point
  };
  replacements: readonly {
    seat: Seat;
    oldPublicKey: PeerId;
    newPublicKey: PeerId;
    newHostSeat: Seat;
  }[]; // exact affected set, seat order; first is the human seat
}

interface SeatTransferAuthorization {
  kind: 'transfer-authorize';
  statement: SeatTransferAuthorizationStatement;
  destinationDeviceSig: string;
  destinationGameSig: string; // key possession, not private-state readiness
  replacementKeySigs: readonly SeatSignature[]; // possession of fresh bot keys
  ownerIntent?: {
    signer: 'current-game' | 'current-device';
    sig: string;
  }; // live mode only
  returnIntent?: { signer: 'last-human-game-key'; sig: string };
  humanApprovals?: readonly SeatSignature[];
}

interface SeatTransferActivationStatement {
  protocol: 'seat-transfer-activation-v1';
  genesisDigest: string;
  authorization: EntryRef;
  parent: EntryRef;
  nextEpoch: number;
  destinationDevice: PeerId;
  destinationGame: PeerId;
  replacements: readonly {
    seat: Seat;
    oldPublicKey: PeerId;
    newPublicKey: PeerId;
    newHostSeat: Seat;
  }[];
  checkDigest: string;
}

interface SeatTransferActivation {
  kind: 'transfer-activate';
  statement: SeatTransferActivationStatement;
  destinationCheck: string;
  replacementChecks: readonly SeatSignature[]; // one per fresh bot key
}

interface SeatTransferCancel {
  kind: 'transfer-cancel';
  genesisDigest: string;
  authorization: EntryRef;
  parent: EntryRef;
}
```

Use separate signature domains for device binding, destination game-key possession, each bot replacement key, owner intent, last-human return intent, and current-human approval. Each signs the whole authorization statement, including its anchor, sequence limit, epoch, destination and affected bot list. The certified authorization entry still names its exact current parent. Validate the destination device against every **other** seat's current route, and reject equality with any game key. Reject a destination game key that equals any device identity, current or reserved voting key, or another replacement key. The destination voting key must be generated on the destination device, independent of every original master. A live owner's current-game or current-device intent permits a new destination device. For return, the last certified human **game key** may sign a narrowly scoped intent even after retirement; it cannot vote or command. If that key is lost, every current active human controller must approve the exact authorization statement, whether the destination reuses the old device identity or is new. A device identity backup or recovered master never authenticates the returning human on its own. The ordinary old-set certificate and destination readiness are still required. The destination transfer-encryption key is independent and never becomes the seat's immutable genesis encryption key.

For `live`, `seat` must be a current active human and `recovery` must be null. Its `replacements` must be that human plus **all** current active bots with `hostSeat === seat`; each bot gets a fresh key, and `newHostSeat` remains the same human seat. For `return`, `seat` must be an active recovered bot. `recovery.authorization` names the final amendment recorded by that completed recovery. Follow its certified `previous` links back to the root authorization with `previous === null`. Require `seat === root.statement.departedSeat`; a hosted bot cannot claim the human's return. Read the last human game key and certified device route at the **root authorization's parent**, before it froze the seat. Do not infer either identity from genesis.

The root recovery's replacement seats form the candidate set. Replay every later certified ownership transition for each candidate. Later recoveries of their human host may move the entire bot group to a new host; a live re-key of that host changes keys but retains bot ownership. Both preserve return eligibility. This version forbids bot-only ownership transfers, including while recovery is pending. If a future certified transition moves one candidate to a different owner, mark it ineligible for this return. At authorization, require each remaining candidate to be an active bot in the returning seat's current host chain. The return transfers that entire eligible set, including the returning seat, in seat order with fresh keys and `newHostSeat === seat`. Recompute it from certified history and current authority, never the message's list or genesis hosts alone. Reject a game result or pending recovery/transfer, key reuse, invalid host, mismatched controller generation, or an expired anchor. During a pending transfer, the authorization remains the only disclosure permission; later game entries may advance the head, but each activation check must bind the new exact parent. As with recovery, carry only exact old beacon/deck/count/steal operations across the activation epoch; new artifacts use new keys.

`transfer-authorize` is certified by the **current** voter set but does not change that set or its epoch. It records a private-delivery permission for this destination. The old human can still vote and command until activation, so no two- or three-human game loses quorum during preparation. The destination cannot vote or command. For a voluntary live move, the current owner's game-key intent and the ordinary current-quorum certificate suffice. No separate human-approval packet is required. If the voting key is lost but the current certified device still holds the masters and its journal, that device may sign `ownerIntent` and the private package; the other current voters still have to certify the authorization. If both owner keys are lost, this version does not perform a live transfer: the current protocol has no certified `SEAT_OFFLINE` record and no general lawful source for that human's private masters. A future quorum-approved key-loss path would need explicit local approval by a current quorum, certified absence, and a verified authorized source for every affected master. A four-human game may instead use recovery and then return; a two- or three-human game waits if its old quorum cannot sign.

For a recovered return, proof of the original master is _not_ identity proof because recoverers know it. Replay the certified prefix to the root recovery authorization's parent and use that seat's **last human game key** for the narrow return-intent signature. That key may have been installed by an earlier transfer; genesis keys are not a fallback. The old certified device route is historical evidence for transport and same-device import, but its identity key cannot sign a return intent. A retired game key verifies **only** this intent domain and never votes or signs commands. If the key is lost, require explicit approval signed by **every current active human controller** over the exact destination and authorization statement; the absent recovered human is a bot and is not an approver. That fallback is a deliberate social trust decision by the surviving humans, not cryptographic proof of a person's identity. No timeout, bot, master-possession check or imported save substitutes for that approval. In all paths, the consensus certificate is still required. Four-human recovery can remove only one active human under strict quorum, so this fallback has at least three current-human approvers; two- and three-human games cannot reach recovered return.

The approval and intent signatures bind `anchor` and `validUntilSeq`, not the moving entry parent. Require `validUntilSeq` to be at most `anchor.seq + 64`; authorization must occur at or before that height. Replay the interval from the anchor and reject any authority epoch, affected controller generation, device route, recovery, transfer or terminal-result change. A cancelled authorization cannot be replayed because its proposed keys stay reserved. The authorization's consensus certificate still binds its exact entry parent. This permits human approvals to survive ordinary game entries without authorizing a different destination or controller generation.

Persist the destination game and bot signing keys and the device binding under its writer lease **before** releasing any possession signature. On certification, `transfer-authorize` reserves those keys in `usedPublicKeys`, as recovery authorization does. Cancellation never makes them reusable. A missing key after a crash requires cancellation and a fresh authorization with fresh keys.

Compute `checkDigest` with a new domain-separated hash over canonical `{genesisDigest, authorization, parent, publicStateHash, cryptoStateHash, authorityStateHash}` from the certified activation parent; replay independently recomputes it. This digest is public and contains no hand, master, escrow share or private-state hash. The destination signs the activation statement with its new game key **only after** durable import, verified replay and private reconstruction at that exact parent. Each fresh bot key signs its own check. Persist each exact signed check before sending it; retry the same bytes, and re-verify and sign for a new parent only if no activation was certified. This differs from the authorization signatures, which prove key possession only. The old voter quorum certifies `transfer-activate` at the next height. Its `stateHash` is unchanged for a live move; a return applies the engine's reserved `SEAT_STATUS {status:'active'}` and checks the resulting hash (`engine.ts` already accepts `active`). Replay atomically records the new authority, route and transfer state; increments authority and crypto epochs; and sets `activatedAt` to the activation entry. The old human voting and command key, and the old bot command keys, are invalid starting at the following height. The destination begins signing votes or commands only after it has installed that certificate and the next-height safety record.

`transfer-cancel` names the exact pending authorization and current certified parent. The current voter set certifies it with the ordinary strict threshold, without changing epoch or controllers. Any current voter may propose cancellation; a person can also choose it when the destination is silent. No automatic timeout makes that choice, and no special absence proof is required. It clears only pending transfer state and future disclosure permission; already disclosed secrets cannot be recalled. This version has no transfer amendment. A failed destination requires cancel followed by a fresh authorization. Activation and cancellation both require the same exact pending ref and parent: whichever is certified first clears pending, making the other invalid on replay. Agreement cannot certify conflicting entries at one height. If the old voter quorum is gone, neither path can proceed. Reject `recovery-authorize` while any transfer is pending, including one for a different seat; cancel first. Reject transfer authorization while recovery is pending. Recovery authorization removes the departed human's gameplay route when it freezes the seat, while retaining that historical route in the certified prefix for a later return.

The old three-human set after a four-to-three recovery needs all three votes to certify a return. The restored four-human set has quorum three; its intersection with the old three is at least two voters. No destination vote is counted on the activation height. In a two- or three-human live transfer, the old strict quorum must remain available through activation. If it is not, the game waits; no local import changes membership.

## Private delivery and destination import

Authorization is a disclosure gate, not an instruction to reveal a master publicly. The source creates a small canonical package containing the original 32-byte master for every affected seat, plus any non-derivable locally held escrow opening needed for that seat. Historical public genesis escrow envelopes and certified entries travel separately. The sealed envelope has this shape; its signature covers every outer field, including the sealed bytes:

```ts
interface TransferPrivateEnvelope {
  protocol: 'seat-transfer-private-v1';
  genesisDigest: string;
  authorization: EntryRef;
  sourceParent: EntryRef;
  sourceSeat: Seat;
  sourceSigner: {
    kind: 'current-controller' | 'certified-device';
    publicKey: PeerId;
  };
  destinationDevice: PeerId;
  destinationGame: PeerId;
  affectedSeats: readonly Seat[];
  nonce: string; // fresh 32-byte random value, encoded
  sealed: SealedPayload;
  ciphertextHash: string;
  sourceSig: string;
}
// Strictly validated after decryption, never placed in a log or public save:
interface TransferPrivatePlaintext {
  protocol: 'seat-transfer-private-plaintext-v1';
  authorization: EntryRef;
  affectedSeats: readonly {
    seat: Seat;
    master: Uint8Array; // original scalar, not a voting key
    escrowOpenings: readonly Uint8Array[];
  }[];
}
```

Seal it to `transferEncryptionKey` with a fresh private seed and a domain-separated context covering every outer field except `sealed`, `ciphertextHash` and `sourceSig`. Hash the canonical sealed payload, then sign the complete envelope without `sourceSig`. Verify `sourceSigner` against the certified controller or device route at `sourceParent`, and require the authorization to be pending there. A live owner's certified device may sign if its game key was lost; a recovered return may use a current human recoverer who lawfully holds the original masters. No arbitrary peer becomes a source merely by knowing a master. Existing `seal` has a 4 KiB plaintext limit and explicitly provides confidentiality only, so require the outer signature, ciphertext hash, strict plaintext schema and post-decryption commitment checks. Reject rather than truncate an overlong package. Do not store or send plaintext in the public log, room messages, diagnostics, QR, or a public export.

For a voluntary live move the old device supplies its own human/bot masters. For a recovered return, a **current human controller** may supply them only if replay proves that controller was an authorized recoverer for the named completed recovery and its durable `recovery-private` records cover the exact affected set. A later certified live transfer of that recoverer may carry this custody forward only through an authenticated private import; current bot hosting alone is not proof of custody. If no lawful current source has every master, the return waits. Send the package only after the certified `transfer-authorize` and return-intent or unanimous-approval rule above. If a current host transfers, include every hosted bot's original master; otherwise do not activate a half-hosted bot set. The original master derives the immutable genesis decryption key, so genesis escrow shares can be read and validated again; do not rotate genesis `masterPub` or `encryptionKey`. Any cached `recovery-private` record remains scoped to its original authorization and recipient and is not transplanted as a new authoritative record.

Import under an exclusive destination writer lease. First parse size-bounded canonical save records and the signed authorization; verify the genesis entry, all contiguous certified entries and certificates, current epoch/controller generation, exact authorization parent, and source package signature. Decrypt into owned buffers, verify each master against the genesis master point, beacon tip, deck lock keys and immutable encryption key with `verifyRevealedMaster`, then call `reconstructPrivateSeats` on **every affected seat** through the current certified head. Check the reconstructed public hand commitments and any pending draw/steal/beacon state by that replay. Recheck journal head, safety height and authorization after each asynchronous store operation. A snapshot may speed rendering but cannot replace replay. A missing/corrupt share, master, proof, safety record or entry leaves the destination read-only with no readiness signature.

Persist the new destination voting and bot keys, device binding, sealed package, verified reconstructed private state and pending transfer ref under an immutable **staging namespace** keyed by `(gameId, authorization hash, destination game key)`. Staging contains a validated certified prefix and no vote or safety record. Do not construct an `IndexedDbProtocolJournal` with the new binding while the active journal still belongs to the old key: its current load/initialize contract forbids that. The destination signs readiness only after its staging write is durable, then rereads the authoritative head and authorization. A crash can reload staging but must repeat replay, master checks and head checks before reusing its exact signed check.

Add a storage-specific `promoteTransfer` transaction across the existing `games`, `entries`, `consensus`, `bytes` and staging stores. It takes the fully verified activation certificate, exact destination staging ref, expected active journal head/binding (or explicit absence), and fresh next-height safety bytes produced for the **new** key at activation height + 1. It rechecks all stored values inside the transaction and either installs the full contiguous verified prefix plus activation, fresh safety and active binding together or changes nothing. A fresh-device import requires genesis, entries, safety and active binding all absent; any partial journal or unrelated binding fails. A same-device return/re-key requires the existing binding's device, seat, key and certified generation to equal the last human controller retired by the named recovery or transfer. It appends missing certificates to that journal and replaces the active binding and safety in the same transaction. Keep only an inert hash/public ref of the retired record; delete its stored signing secret and old safety bytes. No source safety tuple is copied into the new signer. If the same-device source session is still running, it must drain and release its active writer lease before promotion.

The current writer lock includes the voter key, so an old and new key obtain different locks for one game. Add a **game-wide active-journal lease** for every online session and promotion, while staging uses an authorization-scoped lock and separate keys. Acquire locks in one documented order; a failed acquisition leaves staging inert. The IndexedDB compare-and-swap is still required because Web Locks do not coordinate another device or a stale imported backup. Under the game-wide lease, update `IndexedDbProtocolJournal` to read only the promoted active binding and reject archived bindings for voting. A partial staging import can resume validation from disk but cannot enable voting until the activation certificate and exact head are present. On a stale imported save, sync and replay newer certificates first; if they show its key retired, keep it read-only and wipe working copies. If the latest certified head cannot be established, do not sign merely because a local save ends before the transfer.

## Routing, retirement and crash order

Before authorization, a destination joins through a separate authenticated transfer bootstrap scoped to the game and proposed destination, using server signaling or a manual code with **any** connected current human. This connection carries only transfer evidence and sealed private delivery. It does not expand the frozen game roster or accept game frames. After certified activation, derive the device-to-game map from validated genesis bindings plus replayed transfer entries. Add a `WebRtcTransport` method that replaces frozen peers only when given the already verified transfer transition and its exact parent; add a corresponding atomic map swap in `OnlineGameTransport`. Until then, current peers drop destination gameplay frames. At activation they stop mapping the old device to the retired game key, stop its session signing, and disconnect its game route. Existing device links may remain for unrelated lobby control, but they confer no game authority. Hosted bot commands route through the new human device and fresh bot keys.

The old device first durably records its signed authorization request. It sends the sealed private package only after checking the certified authorization and persisting the exact sealed packet in an immutable outbox. A crash before authorization leaves the old controller unchanged. A crash after authorization allows exact-byte retransmission; the destination still cannot vote. A crash after private import but before readiness reloads and re-verifies the same immutable package and certified prefix. A crash after readiness but before activation does not promote the new key. A newer certified parent invalidates the old signed check; the destination replays, rebuilds private state, durably signs a new exact-parent check, and retries those bytes. If it loses staged keys or private material, the old quorum certifies `transfer-cancel`; a retry uses a fresh authorization, keys, encryption point and package. Cancelled keys remain reserved and the previous disclosure remains irreversible. A pending transfer blocks recovery until cancelled. In two- or three-human games where the old quorum is gone, cancellation and recovery may both be impossible; the game waits under strict agreement.

If the destination goes offline after signing readiness, the old quorum may still certify activation. The old key retires at that certificate, even if the destination has not seen it; play pauses until the destination restores. Four-human games may later use certified recovery. Two- and three-human games have no such recovery, so loss of the destination key may leave the game permanently paused. Show that risk before activation. The destination cannot reuse source safety bytes to fill the gap. It must fetch the activation certificate, verify the full intervening prefix, and durably initialize its own next-height safety record before signing a vote or command. A crash after activation but before either UI updates is resolved by certified replay. A stale backup or concurrent old tab may still possess the old secret, but current-epoch peers reject its votes, proposals and commands. Local cross-tab writer leases protect each device; certified key retirement protects across devices.

## Phased implementation and ownership

1. **Certified state, protocol package.** Add `transfer-types.ts`, `transfer-membership.ts` and `transfer-readiness.ts` with strict bounded schemas, signature domains, key reservation at authorization, exact-parent readiness, cancel and activation. Extend `types.ts`, `log.ts`, `replay.ts`, `proposal.ts` and `replicated-log.ts` to replay `TransferState` and a certified human device route alongside `SeatAuthorities`; `authority.ts` remains the signer source. Refactor `recovery-membership.ts` only to reject pending transfers and remove a departed human's active route while preserving its certified history. Keep completed refs and used-key reservations bounded; if storage prunes a cache, the validator must retrieve and verify the exact certified historical prefix or fail closed. No authority transition is inferred from local storage. Prove old-set certification, next-height new voting, cancellation, key reservation, recovery amendments, carried frozen operations and the three-to-four quorum intersection in focused protocol tests before connecting private delivery.
2. **Durable staging and atomic promotion, storage package.** Add `transfer-import-store.ts` for immutable authorization-scoped pending keys, signed checks, sealed package and validated-prefix bytes; add a specific `promoteTransfer` operation to `indexed-db-protocol-journal.ts` that compares and writes the active journal, binding and fresh safety in one IndexedDB transaction. Extend `game-writer.ts` with a game-wide active-journal lease; retain an authorization-scoped staging lease so same-device preparation does not block the old active session. A pending destination has no `ProtocolJournal` voter interface. Exercise fresh-device empty-store promotion, same-device retired-binding promotion, unrelated/partial binding refusal, old secret deletion, stale head, failed transaction and two-tab races with fake IndexedDB. Define and test how fresh safety is initialized at the certified activation head; never deserialize an old safety tuple into the new signer.
3. **Private preparation and import, protocol plus web session.** Add `transfer-private.ts` for the bounded signed sealed package, exact source custody, master verification and all-seat reconstruction. Add a serialized transfer participant in `apps/web/src/session/` using the existing durable byte store, replay policy and journal. It signs possession only after fresh keys are durable, sends private data only after certified authorization, and signs readiness only after the exact-parent private import is durable and rechecked. Replaying a cancelled or superseded authorization yields no packet or check. Keep old and new signing keys in separate records; the package and public save never contain the old voter key. Tests cover tampering, missing custody, recovery amendment ancestry, prior human transfer, changed parent, crash/restart and failed writes.
4. **Transport and live session handoff, p2p plus web session.** Add a transfer-only authenticated bootstrap to `packages/p2p`; it cannot enter the frozen gameplay roster. Extend `online-game-transport.ts` with an atomic route swap driven by a validated certified transition, not a caller-supplied map. Update `online-game.ts`, `online-startup.ts` and the session registry to restore current authority and device route from the certified prefix, derive owned bots from it, close an old local controller on activation and open the destination only after storage promotion. The current genesis-only material, `botHost` and fixed-map assumptions are explicit work items. Old frames/votes fail after the new epoch; destination frames fail before it. Exercise server and manual reconnect to any current peer, late certificates, destination-offline activation and stale old tabs.
5. **User flow and acceptance, web features plus protocol fixtures.** Add the export/import, live transfer, cancel/retry and recovered-return UI. Show the two-/three-human permanent-pause risk before activation and the return privacy warning. The return screen must show whether the last human game-key intent is available or unanimous current-human approval is needed; no master-possession shortcut. Run one bounded real certified transfer and one return with an earlier transfer plus recovery amendment, including same-device and fresh-device imports. Keep a public trace of entry refs, votes and audit outcome without private keys or masters.

The chosen policy is one voluntary owner signature plus the current quorum certificate for a live transfer. A return carries its whole currently eligible affected bot set atomically. Recovered-master possession grants no voting authority.
