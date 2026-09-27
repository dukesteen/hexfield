# Browser resume implementation review

I did not use tools, as the review prompt requested. All line references point into the attached bundle.

**Verdict:** One issue blocks this delta: H1, a game-identifier grammar mismatch in the IndexedDB journal. It is the same defect class as the earlier M1 and has the same 1-in-32 rate. The tests miss it because every resume and startup test injects `MemoryProtocolJournal`. M1 and M2 are availability bugs. They should be fixed before browser acceptance because a refresh test is likely to hit M1. I found no path that signs or sends ceremony output before the original authority is restored. I also found no path that replaces keys or an existing journal.

## High

### H1. The IndexedDB journal rejects game ids that begin with `-` or `_`

**Where:**

- `packages/storage/src/indexed-db-protocol-journal.ts:50-56` checks the id against `/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/`.
- `apps/web/src/session/online-game.ts:200-202` constructs the journal without an injected runtime.

**Sequence:**

1. The game id is 22 base64url characters, as `GAME_ID` in `online-game-records.ts:26` shows. Its first character is `-` or `_` with probability 2/64.
2. Every human signs genesis. On each device, `OnlineStartup` saves the record and calls `openOnlineGame`.
3. `new IndexedDbProtocolJournal(genesis.gameId, …)` throws `Journal gameId is invalid`. Startup enters `error`.
4. Retry repeats the same failure. Resume fails the same way.
5. The game is certified but no device can ever open it.

**Fix:** Accept the full base64url alphabet as the first character of a journal id. `LOCK_PATTERN` in `indexed-db-byte-store.ts:7` already does this. Journal ids are IndexedDB keys, not lock names, so no namespace concern applies.

Add a fake-IndexedDB journal regression that uses an id starting with `_`. Also check the name grammar in `acquireGameWriterLease(genesis.gameId, …)` (`online-game.ts:185`). It is outside the bundle and would fail the same way if it reuses `KEY_PATTERN`.

## Medium

### M1. A failed first open makes the saved game impossible to resume

**Where:**

- `online-startup.ts:382-402` saves the record before opening the game.
- `online-game.ts:185-187` acquires the game lease.
- `online-game.ts:297-300` enforces `restore-only`.

**Sequence:**

1. On a fresh start, `saveOnlineGameRecord` adds the game to the catalogue.
2. `openOnlineGame` then fails before `P2PSession.create` initializes the journal. The lease-contention case in `online-startup-retry.test.ts:191` reaches this state. A refresh during `opening` also does.
3. The user closes the tab instead of pressing retry.
4. The lobby controller state is lost, so the fresh path cannot be re-entered.
5. Resume throws `The certified online game journal is missing`, permanently. The other players wait on this device indefinitely.

**Fix:** On resume, allow first initialization only when the key binding `online-game/${digest}/keys` is also absent.

- `IndexedDbProtocolJournal` writes the binding, genesis and consensus in one transaction. `load()` already returns `null` only when all of them are absent, and throws when the binding exists without the journal.
- A device cannot have voted without that binding, so this replaces no safety record.
- Keep `restore-only` for every other combination.

If you prefer strict `restore-only`, at minimum add the game to the catalogue only after the journal is initialized. Otherwise the home screen lists a game that cannot be opened.

### M2. Leaving the resume loading screen leaves a kept room running

**Where:**

- `OnlineGameScreen.tsx:33-37` calls `keep()` as soon as the room resolves.
- `room-registry.ts:179-187` treats `cancel()` as a no-op once the room is kept.

**Sequence:**

1. The user opens `/online/game/<id>`. The room resolves and is kept.
2. The loading screen shows while the ceremony replays and the journal opens.
3. The user leaves with browser back or any link. The loading screen has no blocker; `useBlocker` exists only in `OnlineGameInstance`.
4. The effect's `cancel()` does nothing. The room keeps the lobby and game leases and the signaling connection.
5. The room then opens the game in the background. Hosted bots vote and act with no UI.

**Fix:** Do not call `keep()` for resume opens. Reference counting already covers StrictMode double mounts, and in-game navigation is blocked or closed explicitly. Alternatively, close the resume room on unmount while `room.getGame()` is null.

## Low

### L1. A full catalogue blocks new games after consent

After 128 saved games, `addToCatalogue` throws (`online-game-records.ts:254`). No deletion UI exists. `saveOnlineGameRecord` then fails in `opening` on every retry, so the 129th consented game never opens on that device.

**Fix:** Make catalogue insertion non-fatal for opening, or add eviction.

### L2. One unreadable pointer hides every saved game

`listOnlineGameRecords` throws on any missing or schema-invalid pointer (`online-game-records.ts:326-328`). A future `genesisSchema` change would hide all saved games at once.

**Fix:** Skip and report failing entries individually.

### L3. Post-consent disputes are not bound to the certified envelope

`#acceptDisputePacket` (`online-ceremony.ts:1149-1168`) accepts any dealer-signed envelope for the pair. After consent, only a dispute over the envelope committed in the certified genesis actually discloses that game's share.

This does not increase attacker power. A malicious holder can already halt the game with a valid false complaint against the real envelope. Binding makes the "genuine disclosure" halt exact.

**Fix:** When the lifecycle reports consenting or completed, require the envelope hash to match the draft or genesis escrow transcript.

## Rechecked and sound

- **Replay ordering.** `start()` subscribes, then replays. Messages received during replay queue behind `start`. The validation step is queued after them, and `OnlineStartup` awaits `flush()`, which covers it. `result()` and `#broadcast` stay suppressed until validation. Restore fails on any missing packet, record or completion, and never produces a new slot.
- **Evidence handling.** Saved `escrow-invalid` evidence on a completed ceremony returns `consented` and does not block. A saved or late `escrow-dispute` sets `locallyConsented` and emits `disputed`. Startup then halts, including during the replay inside `advance()`. The abort signal stops an in-flight `openOnlineGame`.
- **Abort/consent race.** Consent reserves the registry entry under the ceremony lock before signing. `#abortUnsafe` and `#acceptInvalidPacket` retire only through `escrow.abort()` under the same lock order (attempt lock, then ceremony lock). A consented attempt therefore cannot be CAS-retired, and restore's `status === 'active'` requirement holds.
- **Room resume.** `OnlineRoom.open({kind:'resume'})` loads the existing identity and the fully verified record. It checks roster membership, takes the original lobby lease id, freezes the roster before `start()`, and wires no discovery. `OnlineStartup` requires the freeze, agreement and start pins byte-exactly and loads material with `loadOnly`.
- **Duplicate opens and close.** Resume opens are deduplicated by key and by `startup.gameId`. A different room or lobby with the same code is rejected. Close failures still release the lease and the store in `finally`.

## Missing coverage (not bugs)

- No test runs the real `IndexedDbProtocolJournal` or writer lease on the startup or resume path. H1 escaped for this reason.
- The resume trace uses two humans. A three-human resume would replay non-empty escrow accepted/ACK slots from a durable store.
- No test covers a crash or lease failure between saving the record and initializing the journal (M1).
- No test covers navigation away from the resume loading screen (M2).
- Resuming a game that already has a saved dispute only shows the halted message; no public board is shown. This belongs to the separately tracked recovery UI.

## Before browser acceptance

1. Fix H1. Add a fake-IndexedDB regression for journal and lease names that start with `_` or `-`.
2. Fix or explicitly decide M1 and M2.
3. In Chrome, run one refresh during `opening` and one refresh mid-game through `OnlineRoom.open({kind:'resume'})`, and record the wall-clock restore time against the three-second target. Replay re-verifies the full transcript, so measure it rather than assume it.
