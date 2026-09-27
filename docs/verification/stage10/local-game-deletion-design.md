# Local online-game deletion boundary

Deletion is a local-device operation. It does not revoke a peer's copy or an exported public archive.

## Atomic admission barrier

`packages/storage/src/database.ts` upgrades `cp2p` to version 3 and adds `deletedGames`. `deleteOnlineGameData` takes the same active-game Web Lock as a live journal, then the saved-game catalogue lock, and commits one strict IndexedDB transaction across the tombstone, journal stores, and byte store. The immutable marker binds the game ID to its original genesis digest. It is retained in both `deletedGames` (journal admission) and `bytes` as `online-game-deleted/<gameId>` (the app's supplied-store check). Journal initialization, reads, safety writes, commits, and transfer promotion check the tombstone in their own transaction. Transfer staging, readiness, and cancellation writes use the same transactional guard.

The saved start record and pointer are checked against the requested game ID and digest before deletion. A catalogue entry is removed atomically. Repeating deletion with the same digest returns `already-deleted`; attempting to reuse the game ID with another digest fails. App save/load/list read the marker through the caller's `EscrowCeremonyStore`, so memory-backed tests do not consult an unrelated global database. Production browser and worker callers use the shared IndexedDB byte store.

## Cleanup inventory and limits

The transaction removes the game's journal state and entries, saved start and pointer, outcome/activity metadata, and known game-scoped private slots: signing/master credentials, readiness checks, recovery private shares, transfer imports, and transfer destination credentials. Device identity and the device-wide escrow lifecycle index remain. Ceremony attempt/manifest/draft/packet records, recovery release records, and genesis-consent records remain as permanent anti-equivocation evidence; deleting them could permit a later ceremony to reuse an already-consumed reservation. Transfer outbox/protocol records whose keys are opaque are also retained. The current schema has no safe game index for those records, so this implementation does not claim that every legacy private byte is erased.

The tombstone blocks local journal initialization, resumption, and transfer staging for this game ID. It is not a global revocation mechanism and does not make an untrusted imported file authoritative. Any future full-save import path must consult the same tombstone before creating a journal.
