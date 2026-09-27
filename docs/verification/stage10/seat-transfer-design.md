# Certified seat transfer and recovered-seat return

Deferred beyond the first friends-playable multiplayer beta. This is a draft design, not an implementation contract. The pinned read-only review in `seat-transfer-review-raw.md` found open storage, cancellation and authentication questions; resolve those before implementation.

This is an implementation design for [stage 10, sections 3.4 and 5](../../10-persistence-reconnection.md). No transfer entry or runtime exists yet. The existing `membership` payload accepts only `recovery-authorize` and `recovery-activate` in `recovery-membership.ts`; a saved genesis device binding cannot authorize a later device by itself.

## Current invariants to retain

- `SeatAuthorities` is replay-derived. Its `usedPublicKeys` reserves retired voting keys, `activatedAt` identifies the controller generation, and `carriedOperations` binds old in-flight proof IDs to exact certified anchors (`authority-types.ts`, `authority.ts`). The original genesis master and encryption commitments never change.
- An old voter set certifies its membership entry. The new set takes effect at the following height; `proposal.ts` derives voters from active human controllers. Recovery already increments the crypto and authority epochs together and checks a fresh replacement key before activation (`recovery-membership.ts`).
- Genesis `onlineStart` binds each device identity to an independent game voting key (`online-bindings.ts`). `online-game-transport.ts` currently holds that mapping for the whole session. `WebRtcTransport.freezeRoster()` forbids adding a new device after the ceremony. Both need a certified route-update path before a destination can send game frames.
- `IndexedDbProtocolJournal` stores the certified entry and next-height consensus safety in one transaction and binds the journal to a separate voting-key record (`indexed-db-protocol-journal.ts`). `online-game.ts` holds a per-game writer lease and restores only a verified journal. A destination must not import the source's voting key or safety tuple.
- `reconstructPrivateSeats` verifies a complete certified prefix and each supplied original master against genesis, then replays the requested private perspectives. `loadRecoveredHost` also checks the exact durable head before returning a driver. A private hand snapshot alone is never an authority or an import.

## Signed evidence and replayed state

Add `transfer-authorize`, `transfer-activate` and `transfer-cancel` to a bounded, strict `membership.change` variant. Keep a replayed `TransferState` with at most one pending authorization, current human `devicePeer` routes, and a bounded completed-ref cache. Seed routes only from validated genesis `onlineStart`; legacy non-online genesis has no device route. The certified log remains the authority for old controller and route history. If a required completed recovery or prior transfer has fallen out of the cache, replay that certified prefix and check its entry hash. Never treat cache pruning as erasure of identity evidence, and fail closed if the prefix is unavailable. Cap pending and cache counts, statement bytes, and affected seats; use `parseCanonical` strict schemas as recovery does. Do not accept a caller-supplied route map.

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
  returnIntent?: {
    signer: 'last-human-device' | 'last-human-game-key';
    sig: string;
  };
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

Use separate signature domains for device binding, destination game-key possession, each bot replacement key, owner intent, last-human return intent, and current-human approval. Each signs the whole authorization statement, including its anchor, sequence limit, epoch, destination and affected bot list. The certified authorization entry still names its exact current parent. Validate the destination device against every **other** seat's current route, and reject equality with any game key. Reject a destination game key that equals any device identity, current or reserved voting key, or another replacement key. The destination voting key must be generated on the destination device, independent of every original master. A live owner's current-game or current-device intent permits a new destination device. For return, a last-human game-key intent permits a new device; a last-human device-key intent permits only that same certified device identity. A new device without that game-key intent needs unanimous current-human approval. The ordinary old-set certificate and destination readiness are still required, so neither an old identity backup nor a master alone grants a vote. The destination transfer-encryption key is independent and never becomes the seat's immutable genesis encryption key.

For `live`, `seat` must be a current active human and `recovery` must be null. Its `replacements` must be that human plus **all** current active bots with `hostSeat === seat`; each bot gets a fresh key, and `newHostSeat` remains the same human seat. For `return`, `seat` must be an active recovered bot. `recovery.authorization` names the final amendment recorded by that completed recovery. Follow its certified `previous` links back to the root authorization with `previous === null`. Require `seat === root.statement.departedSeat`; a hosted bot cannot claim the human's return. Read the last human game key and certified device route at the **root authorization's parent**, before it froze the seat. Do not infer either identity from genesis.

The root recovery's replacement seats form the candidate set. Replay every later certified ownership transition for each candidate. Later recoveries of their human host may move the entire bot group to a new host; a live re-key of that host changes keys but retains bot ownership. Both preserve return eligibility. This version forbids bot-only ownership transfers, including while recovery is pending. If a future certified transition moves one candidate to a different owner, mark it ineligible for this return. At authorization, require each remaining candidate to be an active bot in the returning seat's current host chain. The return transfers that entire eligible set, including the returning seat, in seat order with fresh keys and `newHostSeat === seat`. Recompute it from certified history and current authority, never the message's list or genesis hosts alone. Reject a game result or pending recovery/transfer, key reuse, invalid host, mismatched controller generation, or an expired anchor. During a pending transfer, the authorization remains the only disclosure permission; later game entries may advance the head, but each activation check must bind the new exact parent. As with recovery, carry only exact old beacon/deck/count/steal operations across the activation epoch; new artifacts use new keys.

`transfer-authorize` is certified by the **current** voter set but does not change that set or its epoch. It records a private-delivery permission for this destination. The old human can still vote and command until activation, so no two- or three-human game loses quorum during preparation. The destination cannot vote or command. For a voluntary live move, the current owner's game-key intent and the ordinary current-quorum certificate suffice. No separate human-approval packet is required. If the voting key is lost but the current certified device still holds the masters and its journal, that device may sign `ownerIntent` and the private package; the other current voters still have to certify the authorization. If both owner keys are lost, this version does not perform a live transfer: the current protocol has no certified `SEAT_OFFLINE` record and no general lawful source for that human's private masters. A future quorum-approved key-loss path would need explicit local approval by a current quorum, certified absence, and a verified authorized source for every affected master. A four-human game may instead use recovery and then return; a two- or three-human game waits if its old quorum cannot sign.

For a recovered return, proof of the original master is _not_ identity proof because recoverers know it. Prefer a narrow return-intent signature from the last certified human device route before the root recovery authorization, or that human game key retired by the recovery. That owner may have acquired the seat through an earlier transfer, so genesis device and game keys alone are not the rule. A retired key verifies **only** this intent domain and never votes or signs commands. If neither key survives, require explicit approval signed by **every current active human controller** over the exact destination and authorization statement; the absent recovered human is a bot and is not an approver. No timeout, bot, master-possession check or imported save substitutes for that approval. In all paths, the consensus certificate is still required.

The approval and intent signatures bind `anchor` and `validUntilSeq`, not the moving entry parent. Require `validUntilSeq` to be at most `anchor.seq + 64`; authorization must occur at or before that height. Replay the interval from the anchor and reject any authority epoch, affected controller generation, device route, recovery, transfer or terminal-result change. A cancelled authorization cannot be replayed because its proposed keys stay reserved. The authorization's consensus certificate still binds its exact entry parent. This permits human approvals to survive ordinary game entries without authorizing a different destination or controller generation.

Persist the destination game and bot signing keys and the device binding under its writer lease **before** releasing any possession signature. On certification, `transfer-authorize` reserves those keys in `usedPublicKeys`, as recovery authorization does. Cancellation never makes them reusable. A missing key after a crash requires cancellation and a fresh authorization with fresh keys.

Compute `checkDigest` with a new domain-separated hash over canonical `{genesisDigest, authorization, parent, publicStateHash, cryptoStateHash, authorityStateHash}` from the certified activation parent; replay independently recomputes it. This digest is public and contains no hand, master, escrow share or private-state hash. The destination signs the activation statement with its new game key **only after** durable import, verified replay and private reconstruction at that exact parent. Each fresh bot key signs its own check. Persist each exact signed check before sending it; retry the same bytes, and re-verify and sign for a new parent only if no activation was certified. This differs from the authorization signatures, which prove key possession only. The old voter quorum certifies `transfer-activate` at the next height. Its `stateHash` is unchanged for a live move; a return applies the engine's reserved `SEAT_STATUS {status:'active'}` and checks the resulting hash (`engine.ts` already accepts `active`). Replay atomically records the new authority, route and transfer state; increments authority and crypto epochs; and sets `activatedAt` to the activation entry. The old human voting and command key, and the old bot command keys, are invalid starting at the following height. The destination begins signing votes or commands only after it has installed that certificate and the next-height safety record.

`transfer-cancel` names the exact pending authorization and current certified parent. The current voter set certifies it without changing epoch or controllers. It clears only pending transfer state and future disclosure permission; already disclosed secrets cannot be recalled. This version has no transfer amendment. A failed destination requires cancel followed by a fresh authorization. Reject `recovery-authorize` while any transfer is pending, including one for a different seat; cancel first. Reject transfer authorization while recovery is pending. Recovery authorization removes the departed human's gameplay route when it freezes the seat, while retaining that historical route in the certified prefix for a later return.

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

For a voluntary live move the old device supplies its own human/bot masters. For a recovered return, an authorized current recoverer may supply already recovered masters only after the certified `transfer-authorize` and the return-intent or unanimous-approval rule above. If a current host transfers, include every hosted bot's original master; otherwise do not activate a half-hosted bot set. The old holder's original master derives its immutable genesis decryption key, so genesis escrow shares can be read and validated again; do not rotate genesis `masterPub` or `encryptionKey`. Any cached `recovery-private` record remains scoped to its original authorization and recipient and is not transplanted as a new authoritative record.

Import under an exclusive destination writer lease. First parse size-bounded canonical save records and the signed authorization; verify the genesis entry, all contiguous certified entries and certificates, current epoch/controller generation, exact authorization parent, and source package signature. Decrypt into owned buffers, verify each master against the genesis master point, beacon tip, deck lock keys and immutable encryption key with `verifyRevealedMaster`, then call `reconstructPrivateSeats` on **every affected seat** through the current certified head. Check the reconstructed public hand commitments and any pending draw/steal/beacon state by that replay. Recheck journal head, safety height and authorization after each asynchronous store operation. A snapshot may speed rendering but cannot replace replay. A missing/corrupt share, master, proof, safety record or entry leaves the destination read-only with no readiness signature.

Persist the new destination voting key and bot keys, device binding, verified private package and pending transfer ref under immutable pending-store keys. The current `IndexedDbProtocolJournal` has one active voting-key binding per game, so it cannot hold these keys in its active journal yet. Add an isolated pending journal/binding under the same writer lease; validate and import its contiguous certified prefix there. It owns fresh, inert safety state and cannot submit votes. After activation, one IndexedDB transaction verifies the exact certified transition and promotes the pending binding and next-height safety record to active, archiving the old binding and safety bytes without reusing them. The same-device return is allowed only when the old binding belonged to the human key retired by the named certified recovery or transfer. Reject any other existing local binding; never overwrite it by assertion. A partial import can resume validation from disk but cannot enable voting until the activation certificate and exact head are present. On a stale imported save, sync and replay newer certificates first; if they show its key retired, keep it read-only and wipe working copies. If the latest certified head cannot be established, do not sign merely because a local save ends before the transfer.

## Routing, retirement and crash order

Before authorization, a destination joins through a separate authenticated transfer bootstrap scoped to the game and proposed destination, using server signaling or a manual code with **any** connected current human. This connection carries only transfer evidence and sealed private delivery. It does not expand the frozen game roster or accept game frames. After certified activation, derive the device-to-game map from validated genesis bindings plus replayed transfer entries. Add a `WebRtcTransport` method that replaces frozen peers only when given the already verified transfer transition and its exact parent; add a corresponding atomic map swap in `OnlineGameTransport`. Until then, current peers drop destination gameplay frames. At activation they stop mapping the old device to the retired game key, stop its session signing, and disconnect its game route. Existing device links may remain for unrelated lobby control, but they confer no game authority. Hosted bot commands route through the new human device and fresh bot keys.

The old device first durably records its signed authorization request. It sends the sealed private package only after checking the certified authorization and persisting the exact sealed packet in an immutable outbox. A crash before authorization leaves the old controller unchanged. A crash after authorization allows exact-byte retransmission; the destination still cannot vote. A crash after private import but before readiness reloads and re-verifies the same immutable package and journal. A crash after readiness but before activation does not promote the new key. If the destination goes offline after signing readiness, the old quorum may still certify activation. The old key retires at that certificate, even if the destination has not seen it; play pauses until the destination restores. Four-human games may later use certified recovery. Two- and three-human games have no such recovery, so loss of the destination key may leave the game permanently paused. Show that risk before activation. The destination cannot reuse source safety bytes to fill the gap. It must fetch the activation certificate, verify the full intervening prefix, and durably initialize its own next-height safety record before signing a vote or command. A crash after activation but before either UI updates is resolved by certified replay. A stale backup or concurrent old tab may still possess the old secret, but current-epoch peers reject its votes, proposals and commands. Local cross-tab writer leases protect each device; certified key retirement protects across devices.

## Implementation boundaries and tests

1. Add `transfer-types.ts`, `transfer-membership.ts`, `transfer-readiness.ts`, and focused transition/replay tests beside recovery. Extend the strict membership union, proposal validation and replica submission only after independent transition tests pass. Recovery authorization must reject pending transfers and clear a departed human's active gameplay route. Share exact carried-operation derivation with recovery. Extend `LogContext`/replay with `TransferState` and current certified device routes; keep `authority.ts` as the signer source.
2. Add a bounded signed/encrypted private package helper and a `TransferPrivateStore` with immutable writes. Reuse `verifyRevealedMaster` and `reconstructPrivateSeats`, including final head/safety reread and disposal. Add storage import transaction and key-binding tests, never a generic caller-asserted restore flag.
3. Add pending transfer bootstrap and certified route updates to p2p and the web game transport. Change `openOnlineGame` to derive owned seats, keys and routes from certified current authority rather than genesis ownership alone. Wire old-device shutdown and destination activation through the serialized replica and writer lease. The browser must show explicit return approval and the irreversible privacy note from section 3.4.
4. Test wrong game/anchor/expiry/epoch, reused voting key, forged device or last-human intent, master possession without identity approval, missing eligible bot, a bot transferred elsewhere, altered sealed package, stale authorization, old-key vote after activation, destination vote before activation, and frozen-operation carry. Include a prior certified seat transfer and a recovery amendment before return; authenticate against the human at the root recovery authorization's parent, and reject return to a hosted bot. Test owner-signed live transfer with only the ordinary quorum certificate, and owner-device intent when the game key is lost. Reject live transfer when both owner keys and the authorized master source are missing. Test unanimous current-human approval for return without a surviving last-human key, excluding the departed bot. Test cancel then recovery, reservation of cancelled keys, two-/three-human quorum pause, and four-to-three return with all three old voters and the next four-voter quorum. Inject crashes at every durable write/sign/send boundary, including loss before possession signature and destination-offline activation, and restore both devices. Test stale imports, same-device pending-binding promotion, pruned caches with intact certified history, missing historical prefix, and two-tab contention. Exercise server and manual transfer bootstrap without admitting a pending device to gameplay.

The chosen policy is one voluntary owner signature plus the current quorum certificate for a live transfer. A return carries its whole currently eligible bot set atomically. Recovered-master possession grants no voting authority.
