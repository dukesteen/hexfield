Three findings. Tools were disabled, so references are by function rather than line.

---

### 1. Restored sessions keep secrets for seats that certified history has since taken away — Medium
**Where:** `openOnlineGame` in `apps/web/src/session/online-game.ts`, specifically `masterFor`, `stealSource`, the `createDriver` hand and deck factories, and `masterReveal.loadOwnedMaster`.

`activeMaterial` is filtered by current certified ownership. However, `masterFor` and `loadOwnedMaster` search the full `material` list. On restore, that list is the installing-generation binding, which `loadActiveOnlineResume` must return unfiltered so the binding re-encodes byte-identically.

**Counterexample:**
1. Device D becomes the transfer destination for seat 0. Recovered bot seat 2 is hosted by seat 0 at that point, so it is in D's binding.
2. Later, seat 2's human returns: `transfer-activate` with `mode: 'return'`, whose replacement `oldPublicKey` is D's seat-2 bot key.
3. In a live session, `onMembershipCommitted` wipes seat 2's signing key, master and provider. That part works.
4. D's worker restarts. `validateTransferOwnedMaterial` against the installed context accepts seat 2 again, and `material` holds its signing key and master for the whole session.
5. `botKeys` and `beaconSources` correctly drop seat 2. But:
   - `loadOwnedMaster(2)` still returns a copy of a master that now backs another human's active seat.
   - `masterFor(2)` still feeds `createHandSecretSource` and `stealSource`.
   - The raw `deckSource` handed to `VerifiedSessionDriver` bypasses the new `P2PSession.createDeckSource` `keys.has(seat)` guard.

So secret lifetime differs between a live session and a restored one. `OnlineStartup.material` also retains the same set while a failed open sits in the error phase.

**Minimal fix:** After `journal.load()` has proven the binding and `activeMaterial` is computed:
- Zero every `material` entry that is neither `local` nor in `activeMaterial`.
- Back `masterFor` and `loadOwnedMaster` with that filtered set, returning null or throwing for any other seat.

---

### 2. A source device that misses the final activation COMMIT can never learn it, and keeps re-admitting its retired key — Medium
**Where:** `GameKeyTransport.advanceCertifiedHistory` in `online-game-transport.ts`, combined with `loadActiveOnlineResume`.

**Counterexample:**
1. There are four humans. A, on device DA, live-transfers seat 0 to DA′.
2. B, C and D certify the activation. A's vote isn't required, or A voted and then briefly lost its link.
3. Each of B, C and D broadcasts COMMIT on the old routes (DA is offline, so it's lost) and then swaps routes.
4. When DA reconnects over its still-frozen WebRTC link:
   - `receive` drops every DA frame, because `deviceToGame.get(DA)` is undefined.
   - No peer can `send` to A's old key.
   - No resume or catch-up exchange can deliver the activation entry.
5. A's journal ends before the activation. So both worker `initialize` and `OnlineStartup` admit A's old key as the active route and return DA in `peers`.
6. `openOnlineGame` then opens a signer that holds seat 0's signing key and master, plus its hosted bots' masters, indefinitely. The "release transferred material" step never runs.

Consensus safety holds, because quorums intersect and A's frames are dropped. The problems are stale-generation self-admission, permanent secret retention and a stuck UI.

**Minimal fix:** On a route swap, keep the removed (old device → old game key) pairs as a bounded "retiring" set. These pairs never count in `peers()` and never deliver inbound messages. Allow exactly one kind of send to them: when that device comes online, or sends any frame, push the COMMIT for the membership entry that retired it (plus the suffix if needed). Drop the pair after N heights.

---

### 3. Removing a device route does not re-check the replica's own retirement — Low
**Where:** `onMembershipCommitted` in `online-game.ts`, combined with the commit path in `ReplicatedLog`.

`settleMembership` resolves a local `submitTransfer` or recovery promise with success before the routing hook runs. If the hook then fails with a non-retired error, the replica halts after reporting success to the submitter, and the routes stay un-swapped until restore.

This is contained by the halt, and a restore rebuilds routes from the journal, but the UI gets a success followed by a halt.

**Minimal fix:** Run the hook before `settleMembership`, or resolve the membership intent only after a successful route swap.

---

### Worth confirming (not counted as findings)
- **Binding buffer ownership:** `openOnlineGame` zeroes `keyBinding.bytes` right after constructing `IndexedDbProtocolJournal` and before `journal.load()`. `loadActiveOnlineResume` keeps `bytes` alive until after `journal.close()`. The two call sites assume different buffer ownership, so one of them is wrong unless the constructor copies the bytes.
- **Test gap:** the transferred-resume test's `createJournal` seam ignores the binding. The byte-identical re-encode of a promoted binding in `openOnlineGame` is therefore never exercised against the real journal.
