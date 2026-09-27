# Online genesis ceremony: implementation plan

This is an implementation contract, not completion evidence. The first vertical slice is a two-human base game with two hosted bots over the existing authenticated device WebRTC mesh. It must end with a signed verified genesis entry, durable deck transcripts, and a game-key `P2PSession`. Escrow shares, fixed-board selection, and larger human rosters use the same contract but need separate follow-up tests.

## Authority and immutable inputs

The lobby's `LobbyFreezeAgreement` is the sole configuration input. Add a pure `verifyLobbyFreezeAgreement` that validates the canonical `starting` state, exact non-open/ready seats, protocol and engine versions, and one device-key signature from every seated human over the same state hash, lobby ID, host epoch and ceremony nonce. Sort ACKs by human seat. Persist the full agreement before generating keys. `OnlineCredentialStore.layoutHash` includes the local device ID and is only a local storage pin; the common `freezeHash` is `toHex(hashValue(agreement.state))`.

The device mesh stays authenticated with device keys throughout the ceremony. Its roster freezes to the seated human _device_ identities after the agreement. Server room snapshots remain discovery advice. Each local seat obtains an independent fresh game signing key and master from `prepareCeremonyMaterial`, which persists them before disclosure. The device signs one `online-seat-binding-v1` body per owned seat:

```ts
type GameSeatBindingBody = {
  protocol: 'online-seat-binding-v1';
  freezeHash: string; // lowercase 64-hex state hash
  ceremonyNonce: string; // canonical 32-byte base64url
  seat: Seat;
  devicePeer: PeerId; // original lobby device identity
  gamePeer: PeerId; // fresh independent game key
  masterPub: string; // F0 = master scalar * G
  encryptionKey: string; // derived from master, nonce, seat, gamePeer
};
```

The signature domain is `online-seat-binding-v1`, under `devicePeer`. Reject a binding unless the frozen human owns that device seat or the frozen bot's host is that device. Require one binding per seat in exact order, unique game keys/master points/encryption keys, and the bot's genesis `botHost` to equal its host human's **game** key. The final genesis carries the agreement and bindings in a strict `commitments.onlineStart` section, so certified replay can verify that device consent led to this exact game roster. A host-selected `createdAt` is informational but must be fixed in the exact final draft before any consent.

## Seed and manifest hashes

Add `DERIVATION_LABELS.genesisSeed` with value `genesis-seed`. For original seat `i`, derive a 32-byte share with `deriveBytes(master, genesisSeed, { ceremonyNonce, seat: i }, 32)`. This can happen before the collective ceremony ID exists. Its commit is:

```ts
toHex(
  hashValue({
    domain: 'cp2p/v1/genesis-seed-commit',
    ceremonyNonce,
    seat: i,
    share: toBase64Url(share),
  }),
);
```

Each game seat signs `{protocol:'genesis-seed-v1', freezeHash, ceremonyNonce, seat, commit}` under domain `genesis-seed-commit-v1`. Collect all signed commits before accepting _any_ reveal. Then each seat signs the same scope plus its canonical `share` under `genesis-seed-reveal-v1`. Check each reveal against its prior commit. Compute `genesisSeed = toBase64Url(hashValue({domain:'cp2p/v1/genesis-seed', ceremonyId, shares: orderedBase64urlShares}))`, where seats are in genesis order. Persist exact commit/reveal packets before forwarding; wrong, duplicate-conflicting, or missing shares retire the pre-consent attempt. A fixed board needs an explicit `seedMode:{kind:'fixed',seed}` in the frozen lobby state and an exact fixed-mode final transcript; do not infer fixed mode from a caller-supplied `genesisSeed`.

The initial frozen manifest is a `GenesisBody` with the frozen config, ordered game seats, nonce, `security:'verified'`, F0 commitments and derived encryption keys. A canonical placeholder `genesisSeed` is acceptable **only inside the pre-seed escrow coordinator**: `deckCeremonyId` excludes the seed, `createdAt`, beacon tips, deck commitments, escrow transcript and `onlineStart`. Never sign this placeholder as final genesis. Once all game public keys, F0 and encryption keys are pinned, `deckCeremonyId` is stable. Derive beacon tips with `createBeaconSecretSource(master,{ceremonyId,seat})`, and deck definitions with `genesisDeckDefinitions(manifest)`; these do not create a hash cycle. The final body includes the real seed and all transcripts, but retains the same ceremony ID.

The current genesis validator has no seed proof at all. Add strict `validateGenesisSeed` and `validateOnlineStart` to mandatory verified genesis signing and admission, including the fixed-mode rule. Because existing verified fixtures omit both sections and no public verified deployment exists, migrate shared fixture builders and their callers together before online release. Do not make these checks optional through `GenesisPolicy.verifyCommitments` or allow a missing section to mean “legacy online”; that would let a hostile host omit fairness evidence. Set the next protocol version for the changed verified wire body and update tests accordingly. If supporting already-saved v1 histories becomes a product requirement, add a separate read-only v1 replay path; new v1 online genesis must never be admitted.

## Durable phases and packets

Use a bounded `online-ceremony-v1` envelope with `{freezeHash, ceremonyNonce, senderDevice, kind, payload, sig}` signed under `online-ceremony-message-v1`; require `senderDevice === Transport.from`, exact current agreement, canonical encoding and a fixed per-kind size/count. Inner bindings, seed packets, deck passes, escrow messages and genesis consents retain their existing role-specific signatures. Persist each exact outgoing packet before synchronous send enqueue. Incoming packets are stored under `(ceremonyId, kind, seat, step)` only after their role-specific proof verifies; exact retries reuse bytes, conflicting bytes fail the attempt. Keep all received deck pass blobs, not just their hashes.

1. **Frozen/keys/bindings:** Persist the agreement; obtain owned material; collect and verify all device-to-game bindings. Compute F0 as `encodePoint(scalePoint(G, scalarFromBytes(master,{nonzero:true})))`. Compute each `E` through `createStealSecretSource(master,nonce,seat,gamePeer).encryptionSecret()`, then dispose the source. No bot host or signing key is inferred from signaling discovery.
2. **Escrow approval/distribution:** Construct `EscrowCeremony` with the locally pinned manifest and `IndexedDbByteStore`, which supplies atomic writes, compare-and-swap and the shared Web Lock. Collect `approveAndSend` approvals from every human. For at least four humans, run `distributeAndSend`, `acceptAndSendAck`, and authenticated dispute handling for every required holder. For two or three humans, `commitments.escrow` is the explicit empty transcript, but still use the coordinator's abort/consent registry. An ACK and private share are durably retained before ACK output. A bad share retires the entire pre-consent attempt; a new attempt needs a new nonce and fresh material.
3. **Seed/decks:** Collect all seed commits, then all reveals. For each canonical deck, replay the fixed participant order: all shuffles, then all locks. `prepareDeckPass` is the existing immutable local outbox. Apply and durably store each verified incoming pass before announcing the next step. Finish with `createDeckGenesisCommitment`; retain the full ordered transcripts for consent, genesis restore and certified setup entries.
4. **Final draft/consent:** Assemble one canonical body containing the exact agreement, bindings, seed transcript, beacon chains, deck commitments and escrow envelope/ACK transcript. Validate it locally. `EscrowCeremony.consentAndSend` runs under the ceremony lock: it checks local accepted ACKs, records the irreversible consenting digest, invokes `prepareGenesisConsent`, and enqueues the exact game-key signature. All human signatures must cover one digest and be sorted by seat. Pre-consent timeout calls `abort()` and cannot retry this nonce; post-consent timeout cannot return to the lobby or release/reuse masters. It waits for exact completion or an explicit disposition, retaining authenticated disclosures.
5. **Genesis/handoff:** Persist the assembled signed genesis, full transcripts and game-key mapping. First human game key signs seq 0 with `signEntry`; every peer validates `validateGenesisEntry` plus mandatory transcript checks. Call `EscrowCeremony.complete` to mark the validated digest while retaining permanent master binding. A post-consent disclosure can leave completion durably recorded but must withhold gameplay-ready output. Initialize the protocol journal from the exact entry before any vote. On restart, load the exact stored draft/consents/transcripts and resume; never silently rebase.

`OnlineRoom` currently owns a `WebRtcTransport` whose `self` and peers are **device** keys; `P2PSession` requires **game** keys. Do not create a second server room with game keys or pass the device transport directly to the session. Root should add a handoff wrapper over the existing authenticated links: `self` and `peers()` expose human game keys, `send` maps a certified game key to its signed device binding, and inbound `from` maps the authenticated device origin to that same game key. The wrapper rejects unmapped devices and survives lobby controller disposal. Transfer the transport, storage and lease ownership to the game lifecycle without closing active links; acquire the game writer lease before releasing the lobby lease.

## File ownership and first acceptance slice

- Protocol foundation: new `genesis-seed.ts` and `genesis-device-bindings.ts` with pure strict validators, mandatory hooks in `genesis.ts`, a pure freeze-agreement verifier in `lobby.ts`, and focused tests. Crypto adds only the named HKDF label. This is the broad fixture-migration checkpoint.
- Protocol ceremony: new `online-ceremony.ts` plus a bounded message schema and immutable received-transcript store contract, composed from `EscrowCeremony`, `prepareDeckPass`, `createDeckGenesisCommitment` and `prepareGenesisConsent`. Tests use two genuine humans and two hosted bots, real signatures/proofs, injected clock and a durable fake store. Crash at each sign/send boundary and restart from identical bytes. A conflicting pass, changed draft, dropped ACK, withheld seed reveal and pre/post-consent timeout get distinct outcomes.
- Web/root handoff: `OnlineRoom` calls the ceremony, owns the game-key transport wrapper, persistent protocol journal and `P2PSession` options. The lobby UI observes phase/status; it never receives master bytes. Test the wrapper's device/game mapping and lost-link reconnect separately before a single native browser start-to-first-turn smoke.

The minimum complete slice excludes optional escrow delivery because it has two humans, but it must still run the all-ACK freeze, signed bindings, seed commit/reveal, all ordered persisted deck passes, durable consent, exact signed genesis, journal initialization, certified deck passes and first playable turn. No simulation genesis signer or in-memory outbox is a production fallback.
