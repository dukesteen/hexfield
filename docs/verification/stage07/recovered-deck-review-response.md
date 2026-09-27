# Recovered deck receipt review

**No blocking finding in the supplied source.** The fix closes the reported failure: seat3's owner decode, later play or claim, and audit all read the roster stored on the slot at the certified deal. Nothing mints new authority from that roster. The items below are hardening points and gaps I cannot see from the supplied files.

## What checks out

- **Provenance of the roster.** The only production writer is `completeDeckDeal` (`deck-ledger.ts`). It receives signers resolved in `validateCryptoTransition` from the authority at the deal's parent, and it stores them only after `completeDeckDraw` has verified every unlock against them. `revealDeckCards`, `prepareCommand`, `committedEntry` and `privateDataFor` read `slot.unlockSigners` from the replayed ledger (`after.crypto` or `next.log.crypto`), never from a peer.
- **Retired signers cannot author new artifacts.**
  - `unlockSigners` is only consulted to re-verify unlocks already stored in an immutable ledger receipt.
  - Every new deal re-resolves signers at the current epoch.
  - A controller in `pending-recovery` blocks the deal (`artifactSigner` → `authority-pending`).
  - Steal and count artifacts are unaffected.
  - Reveal proofs are signed by the owner's command and bound by DLEQ to `receipt.point`. They do not rely on the unlock signers for authority.
- **Carried operations.** A draw frozen before the membership change stays valid through `permitsFrozenOperation`. Its unlocks are then verified against the key active at the deal. An unlock signed by seat0's retired key before replacement but certified after it is rejected. That is correct, though it has a liveness consequence (see uncertainty 1).
- **Stale versus historical keys.** Your test shows that a later replacement's roster fails `deck-unlock-signature` on the historical receipt. The per-step seat check in `verifyDeckUnlockPrefix` and `signDeckUnlock` prevents a roster from being shifted onto different seats.
- **Mutable aliasing.** `completeDeckDeal` returns the result of `validateDeckLedger`, which re-parses the ledger canonically. So the caller's `signers` array is not retained. Consumers treat `unlockSigners` as read-only.
- **Audit.** `privateDataFor` uses the post-deal slot's roster. Before the fix, a `deck-unlock-signature` failure would have been recorded as a violation with `seat: null`; now it should not occur.

## Non-blocking hardening

1. **Optional `signers` still defaults silently to the genesis keys.** This silent default is exactly the bug class that caused the original failure. The exported functions affected are `verifyDeckUnlockPrefix`, `verifyDeckUnlock`, `signDeckUnlock`, `completeDeckDraw`, `decodeDeckCard`, `proveDeckReveal` and `verifyDeckReveal`.
   - Any production caller that forgets the argument will verify against genesis keys and fail only after a replacement.
   - Suggestion: make `signers` required everywhere. Give the fixtures an explicit `genesisUnlockSigners(operation)` helper instead of relying on `undefined`.
2. **`validateDeckLedger` checks roster shape but never checks the keys themselves.** It uses `key32Schema` but never calls `parsePeerId` on `unlockSigners[].publicKey`.
   - Failure sequence: a restored ledger (or a key32 value that is not a valid peer ID) passes validation. `verifyDeckUnlockPrefix` then calls `parsePeerId(signers[step].publicKey)` and throws instead of returning a `Result`.
   - `decodeDeckCard` calls `verifiedReceipt` outside any `try`, so the throw escapes the function. The callers happen to catch it: the driver reports `verified-deal-decode` or `deck-reveal-proof`, and audit reports `audit-private-input`. Those codes misclassify the cause.
   - Suggested fix: call `parsePeerId` inside the existing `try` in `validateDeckLedger`, or wrap the signature check.
3. **The roster is not cross-checked against the receipt during shape validation.** A hand-built or restored ledger can hold any seat-ordered roster whose generations are below `deal.seq`.
   - This is safe for card correctness, because the DLEQ proofs pin the dealt point regardless of signatures, and snapshots are hash-checked against replay.
   - The code comment "only certified replay makes a ledger authoritative" is the real guarantee here. Keep it that way: never restore a `CryptoContext` from storage without replaying.

## Uncertainties (code not supplied)

1. **Unlock production after replacement.** `prepareDeckUnlock` / `deck-outbox` takes no `signers` argument in the tests and rejects non-genesis keys with `deck-outbox-key`. I cannot tell how the replacement device signs seat0's unlock.
   - There may also be a stale-record case: a per-seat, per-position CAS record already holds an unlock signed with the retired key for a draw that was carried across membership. The store would then return that stale record forever, and the deal could never certify.
2. **Other callers of the deck helpers that may omit `signers`.** Not supplied:
   - `private-replay.ts` (`reconstructPrivateSeats`)
   - cheat-proof verification of unlocks or reveals (`verifyCheatProof`)
   - the session-layer unlock collector and proposal builder
   - hosted-bot unlock signing

   Grep for every non-test call of the functions listed in hardening item 1 and confirm each one passes a resolved or stored roster.
3. **Persistence migration.** `slotSchema` is strict, so any persisted `CryptoContext` or snapshot written before this change now fails validation. Snapshot hashes also change. The certified `stateHash` is unaffected, because it covers only engine state. Confirm that load falls back to a full replay and that mixed-version peers are not comparing snapshots.

## Suggested regression tests

1. **Ledger level.** Use a deck with at least three participants. Freeze a draw at seq A, replace seat0 with activation at seq B > A, then deal at seq C > B.
   - Seat0's unlock signed with the retired key is rejected. The replacement key is accepted.
   - `validateDeckLedger` round-trips the resulting ledger.
   - A second replacement of seat0 at seq D still lets `revealDeckCards` verify the old slot.
   - A new deal after D rejects the key from B.
2. **Roster validation cases.** `validateDeckLedger` rejects: `generation.seq === deal.seq`, duplicate keys, seats out of order, and an invalid peer key (returned as a `Result`, not thrown). The current ledger tests only exercise a single-owner deck with `[]` signers, so none of this roster validation is covered.
3. **Outbox.** A carried draw where seat0's outbox record predates the replacement. Assert the new controller can still produce an unlock that certifies.
