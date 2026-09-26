# Stage 07 Step 3 deck integration plan (proposed, incomplete)

This is a design for connecting the existing shuffle, lock, draw, reveal and durable-outbox helpers to the certified game log. It is **not an implementation or acceptance report**. Current verified sessions have a beacon context but no certified deck ledger. A permissive `verifyCommitments`, `verifySystem` or `verifyCommand` callback must never stand in for the mandatory deck checks below.

## Ceremony and genesis boundary

The base development deck has 25 distinct physical identities: 14 knight, 5 victoryPoint, and 2 each of roadBuilding, yearOfPlenty and monopoly. The canonical identity **order** and card-type mapping must come from the agreed base module, not a peer-supplied table; the same rule applies independently to every configured deck. The deck definition's participants must equal every signed genesis seat and public key in seat order, **including bots**. Beacon participants remain human-only; that rule does not apply to the deck. The deck's `ceremonyId` must be derived from the frozen, signed pre-genesis manifest, not accepted merely as an arbitrary matching string.

The preferred reconciliation of [Stage 07](../../07-fair-randomness-hidden-info.md) and [Stage 09](../../09-lobby-and-game-setup.md) is:

1. Before anyone signs genesis, the ceremony collects all ordered, signed shuffle and lock passes. Every participant replays the complete transcript with `replayDeckSetup`, checks the canonical catalogue and roster, and obtains the same final locked deck. `prepareDeckPass` persists a seat's immutable pass before that seat sends it.
2. Signed genesis commits the canonical definition and an ordered, domain-separated hash of each complete pass, with an optional final setup-state hash. The final genesis digest cannot appear in a ceremony pass proof because it commits those passes. The passes bind the earlier `ceremonyId` instead.
3. The first **non-control cryptographic work** after genesis carries those **already fixed** passes individually as state-preserving `crypto/deck-pass` payloads. Replay checks each pass cursor and committed hash before `applyDeckPass`. Certified proposer-exclusion controls and term replacement may intervene without changing that cursor or the frozen request. No gameplay entry, including START_SEAT, is accepted until the setup fold is complete. The START_SEAT beacon request can remain frozen at its genesis anchor, but its contribution producer must not reveal any chain link before deck readiness. The Stage 09 ceremony order must change explicitly: collect and verify deck passes **before the final genesis draft is signed**, then certify those exact passes afterward. Its current wording calling them `system` entries also needs correction because there is no engine system input for a deck pass.

**Unresolved ceremony API requirement:** A list of hashes in genesis commits bytes but does not prove those bytes are available or valid. The current `GenesisPolicy.verifyCommitments` callback cannot establish this as a protocol guarantee when supplied by a permissive caller. The Stage 09 ceremony must provide a durable, bounded transcript store and a mandatory built-in pre-sign verification path: all prospective human genesis signers must obtain the exact pass blobs, check their hashes and run the complete proof fold before signing. A missing or invalid blob aborts the ceremony. On restore, the journal's certified first entries supply the same bytes; a partial prefix remains setup-incomplete and cannot vote for gameplay. This store/ceremony API has not yet been designed or implemented.

The wire cap is 256 KiB **per message**. Measure the worst-case 25-card six-seat pass inside its complete entry, proposal and certificate envelopes, not just the raw proof bytes. Packing every proof into the genesis entry would contradict the bounded-pass rule and could exceed the cap. The genesis hash list is small, but it must not be represented as if it were already a verified proof transcript.

## Replayable public deck ledger

Extend `CryptoContext` in `crypto-context.ts` with a detached, serializable deck ledger. A minimal shape is:

```ts
interface DeckLedger {
  definition: DeckDefinition;
  passHashes: readonly string[];
  setup: DeckSetupState;
  nextPass: number;
  nextPosition: number;
  activeDraw: { request: DeckDrawRequest; operation: DeckDrawOperation } | null;
  slots: readonly {
    slotId: string;
    seat: Seat;
    position: number;
    receipt: DealtDeckCard;
    deal: { seq: number; hash: string };
  }[]; // only unrevealed slots
}
```

This is a proposed internal shape, not a wire authority. Initialize it from the signed definition in `initialProposalContext`, fold certified pass entries into `setup`, and never import a peer snapshot as authority. `replayCertifiedPrefix` reconstructs it; `snapshotFromContext` only caches and compares the derived value. `consensusContextHash` already includes `crypto`. Keep the existing engine-only `entry.stateHash`; adding a crypto hash to the same entry and deriving an operation anchor from that entry's hash would create a cycle.

When a certified BUY_DEV_CARD creates the engine's `draw` pending, `captureCryptoPending` freezes the operation at **that certified entry hash**. It must require a complete setup, the exact deck/seat/slot request, `pending.remaining === 25 - nextPosition`, `state.decks.dev.drawn.length === nextPosition`, and no active draw. Control entries preserve the frozen request. `freezeDeckDraw` validates a derived operation, but does not itself establish that the request was certified or the position unused; the ledger must do both. Until a deal commits, no new draw or unrelated command can replace the request.

For a certified `CARD_DEALT`, derive the operation from the frozen ledger and verify the entire ordered signed unlock chain with `completeDeckDraw`. The public input must omit `card`. Check that its seat, deck and slot match the engine pending, its position equals `nextPosition`, and the slot has not appeared before. Only after successful engine apply, invariants and state hash does the prospective ledger increment `nextPosition`, retain the verified receipt for the owned unrevealed slot, and clear `activeDraw`. Rejected proposals consume nothing. A later control or retry cannot reroll or advance the position. The public receipt contains no card identity.

## Mandatory pre-vote proofs

The built-in checks belong on the `validateNextEntry` path used by proposal validation, before `engine.apply` and before anyone signs a vote. The current `entryInput` checks a public `CARD_DEALT.card` leak, but a future `validateCryptoTransition` handled branch can bypass `entryInput`; the built-in deck branch must repeat that leak check. A generic `verifySystem` success must not allow a missing, stale, substituted or incomplete `deck-draw-v1` receipt.

For `PLAY_DEV_CARD` and `CLAIM_VICTORY`, first run `validateSignedCommand` (signature, exact head, nonce, public engine validation). Then require signed command evidence under a fixed deck-reveal protocol. Derive the reveal context from the verified command's game/genesis, seat, nonce, exact parent and **entire command**, not from evidence supplied by the sender. Look up each still-owned, unrevealed slot and its certified receipt in the ledger, verify its DLEQ with `verifyDeckReveal`, and compare the proved physical identity's card type to `PLAY_DEV_CARD.card`. A victory claim requires exactly one distinct matching proof for every claimed slot and every proved type must be victoryPoint. Missing, extra, reused, foreign, already spent and wrong-type proofs fail. A generic `verifyCommand` may impose additional obligations, but cannot override a deck failure. A successful prospective transition removes only the revealed slots after engine apply. These command paths must still run normal signed-command and policy validation; marking them `handled` and skipping `entryInput` would be unsafe.

## Candidate, durable contribution and private flow

`types.ts`/`schemas.ts` need the bounded `crypto/deck-pass` payload and fixed proof protocol identifiers. `replicated-log.ts` needs a deck contribution inbox and candidate priority while setup/draw is pending, alongside its beacon inbox. The source of an operation is the local certified ledger and engine pending, never a peer packet. Setup passes use `prepareDeckPass`; draw unlocks use `prepareDeckUnlock`, which reserves a setup/position/seat before returning signed bytes. Both stores must survive restart and copy stored bytes. The setup pass cursor must complete before ordinary command candidates or beacon results are proposed; authenticated control entries can intervene without resetting it. `prepareBeacon` must defer outbound START_SEAT reveals until deck readiness despite the request already being frozen. If a contribution is unavailable, the fixed operation waits or follows the separately certified recovery path; it never chooses a new card.

`P2PSession.submit` currently signs evidence-less commands. Its verified private driver needs a **producer** method that builds reveal evidence from the local slot receipt, deterministic deck secret source and exact command parent/nonce before `signCommand`. This method is not a verifier and cannot authorize a peer command. The automatic CLAIM_VICTORY path must use the same producer. On a certified CARD_DEALT, `SessionDriver.committedEntry` decodes the card only for its owning local/hosted-bot seat with `decodeDeckCard`, then updates private slots. On restore, `P2PSession.open` replays certified entries through that same callback and deterministic source; no provisional hand is published. `ReplicatedLog.persistCommit` already journals the certificate before invoking `onCommit`; a private decode failure must halt that client without rolling back certified public history.

## Files and compatibility checks

Expected existing-file changes: `genesis.ts` (built-in signed definition/hash-list checks), `types.ts` and `schemas.ts` (deck-pass payload/proof identifiers), `crypto-context.ts` (ledger, pending and transition fold), `log.ts` (non-bypassable deal/reveal verification), `replay.ts` (genesis initialization and incomplete-setup replay), `replicated-log.ts` and `messages.ts` (bounded contribution gossip/candidates), and `p2p-session.ts` (proof production/private certified replay). The engine needs a public canonical base deck catalogue API derived from `DEV_CARD_COUNTS`; protocol code should not duplicate a peer-editable card list. `journal.ts` need not gain a second authority if certified entries and outbox records persist correctly.

Existing verified-base fixtures in `beacon-log.test.ts`, `beacon-replica.test.ts`, `genesis.test.ts` and `log.test.ts` currently use beacon-only or opaque commitments. They must migrate to a valid base deck definition and signed pass commitment/fold, or use a genuinely deck-free test engine. Do not add a `skipDeck` flag to verified base sessions. `beacon-state.test.ts` can continue testing its pure state helper without claiming full genesis acceptance. Stub simulation and local hotseat retain their existing plaintext draw path.

Meaningful integration tests should reject wrong catalogue/roster/ceremony ID, absent or reordered committed passes, gameplay before setup completion, wrong pending or repeated position, duplicate slot, forged or missing CARD_DEALT chain, callback-approved false PLAY_DEV_CARD/CLAIM_VICTORY proofs, and a control between draw request and result. Replayed certified history must produce the same ledger and owner-only card identity; snapshots cannot supply a different one. A six-seat 25-card worker benchmark should verify the documented setup latency target separately; repeated full proof-fold verification on every vote would miss it.
