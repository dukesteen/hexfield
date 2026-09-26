# Stage 07 Step 3 live deck and private-session review

I reviewed only the supplied source and did not run any tools. The packet has no line numbers, so references use `file` → `symbol`.

**Summary:** I found no critical or high-severity safety defect in the live deck path.

- Built-in deal and reveal verification cannot be overridden by the optional policies.
- Proof seeds do not repeat across different challenges.
- Card identities do not reach other peers.
- The findings below are liveness, robustness and hygiene problems, followed by unsupported later-work failure modes and test gaps.

## Findings

### M1 — Listener or automatic-input exceptions after a successful private apply halt the replica as `commit-application`

**Where:**

- `p2p-session.ts` → `open` → `replicaOptions.onCommit`
- `replicated-log.ts` → `persistCommit` (the `try`/`catch` around `onCommit`)

**Trace:**

1. A CARD_DEALT or command certifies. The journal commit succeeds and `applyCommit` succeeds, so the driver state and `P2PSession.context` both advance.
2. `emit(validated.events)` then calls a subscriber that throws. The same happens if `maybeAutomatic` → `engine.getAutomaticInput` throws "Multiple modules requested an automatic input".
3. The exception escapes `onCommit`. `persistCommit` reports `halted/commit-application`, disposes the replica and throws.
4. Pending submits resolve `replica-outcome-unknown` and the peer stops voting. The public and private state were in fact consistent.

`maybeAutomatic` also runs `prepareCommand` synchronously inside the serialized commit. That includes full receipt verification and DLEQ proving, so it adds latency to every commit.

**Fix:** Throw from `onCommit` only when `applyCommit` fails. Wrap each listener call and `maybeAutomatic` in their own `try`/`catch`. Preferably, defer `maybeAutomatic` with `queueMicrotask` so it runs outside `persistCommit`.

### L1 — A transient deck-store error permanently disposes a live replica

**Where:**

- `replicated-log.ts` → `prepareDeck`, which calls `failClosed` on any `prepareDeckUnlock` failure
- `deck-outbox.ts`, where the outer `catch` returns `deck-outbox-write`

**Trace:**

1. A draw is active.
2. `putIfAbsent` for the reservation or the unlock throws a transient error, such as an IndexedDB abort or quota error.
3. The replica is disposed mid-game.
4. Restore re-runs the same path, and the test shows it fails while the error persists.

Retrying is safe here. The reservation is written before signing, records are immutable, and unlock bytes are deterministic. Only integrity failures prove anything is wrong.

**Fix:**

- Treat `deck-outbox-write` and store exceptions as retryable. Report the status, leave `preparedDeckPrefix` unchanged, and let the next pulse retry.
- Keep fail-closed behaviour for `deck-outbox-position`, `-record`, `-key` and `-source`.
- The beacon path has the same shape; decide both together.

### L2 — Private application does not enforce continuity with its own last-applied head

**Where:**

- `verified-session-driver.ts` → `committedEntry`, which checks `entry.prevHash` only against the caller-supplied `before`
- `p2p-session.ts` → `open` and `applyCommit`

**Trace:**

1. `P2PSession.open(restore)` loads the journal and replays private state up to head _h_.
2. `ReplicatedLog.restore` then loads the journal a second time. If another writer (for example, a second tab) appended _h+1_ in between, the replica starts at _h+1_.
3. The next `onCommit` passes `previous = h+1`. The driver accepts _h+2_ without ever applying _h+1_.
4. A missed CARD_DEALT might be caught later by the slot checks, but a missed public-count change may not be.

**Fix:**

- In the driver, record the last applied head hash and require `before.head` to match it.
- In `P2PSession`, assert that `replica.getContext().log.head` equals its own replayed head after open.
- In `applyCommit`, assert that `previous.log.head` equals `this.context.log.head`.

### L3 — `P2PSession.open` leaves copies of the human and bot secret keys in memory

**Where:** `p2p-session.ts` → `open`, the calls `identityFromSecret(options.secretKey).peerId` and `identityFromSecret(key).peerId`.

**Trace:** `ReplicatedLog` zeroes `identity.secretKey` after each `identityFromSecret` call, which implies the call returns a copy. These two call sites never zero that copy. This happens on both the success and failure paths, including the `session-bot-key` rejection. It undercuts the claim that keys are cleared on disposal.

**Fix:** Keep the identity object and zero its `secretKey` in a `finally` block, following `checkLocalKey`.

### L4 — The driver's owned-seat set is not tied to the session's keys

**Where:**

- `p2p-session.ts`: `createDriver(engine, genesis, clock)` receives no owned-seat set
- `verified-session-driver.ts` constructor

**Trace, two misconfigurations:**

- **Hosted bot omitted.** If the factory leaves out a hosted bot, the replica still signs that bot's unlocks, but the bot's hand is never decoded. `validate` then fails with `seat-not-controllable`.
- **Unkeyed seat included.** If the factory includes a seat this peer does not host, the first CARD_DEALT to that seat fails to decode after certification, because the real factory has no secrets for it. That halts the peer and breaks restore permanently.

**Fix:** Have `P2PSession` pass the key-derived seat set (human plus verified bots) to `createDriver`. Alternatively, have it verify at open that `driver.privateState(s)` is non-null exactly for `keys`.

### L5 — A contribution for a not-yet-certified operation is dropped

**Where:** `replicated-log.ts` → `receive` → `DECK_CONTRIB`, where the operationId mismatch returns `success`.

**Trace:**

1. Peer B certifies BUY_DEV_CARD first, signs step 0 and broadcasts it.
2. Peer C has not yet committed that entry, so C discards the message.
3. After committing, C waits up to one 2 s pulse before it can sign step 1.

This is safe but adds avoidable latency.

**Fix (optional):** Retain one bounded, unverified future contribution per sender and re-offer it after the next commit. Alternatively, rebroadcast your own prefix after a peer's COMMIT.

### L6 — Proof verification is repeated on every offer

**Where:** `replicated-log.ts` → `offerAvailableInput` and `candidate`, both calling `deckDrawCandidate`, plus `deriveCandidate` → `completeDeckDeal`.

**Trace:** Each pulse or reconnect re-runs `completeDeckDraw` (up to 5 DLEQ and signature checks) at least three times. It also runs repeated `validateDeckLedger` passes and reloads storage for every local participant. Reconnect churn through `onPeerChange` amplifies this.

**Fix:** Cache the complete candidate keyed by `(operationId, prefix length)`, and cache the local "prepared" result.

## Unsupported later work (real fail modes, not defects in this step)

- **Hidden steal involving a local seat.** `STEAL_RESULT` with `resource: 'hidden'` fails _after_ certification, and restore fails the same way, so the session is permanently bricked. The test policy admits STEAL, and `driveToDraw` avoids it deliberately. Until sealed steals land, reject this earlier or gate it at the lobby.
- **No system inputs from the driver.** `VerifiedSessionDriver.next` always returns `null`. Monopoly `REVEAL_COUNT` and `TIMEOUT` are never produced, so a Monopoly play stalls and turn timers are never enforced.
- **Departed seats block draws.** Every draw needs every seat's unlock, including bots and departed humans. One departed seat blocks all later draws, and claims are blocked while a draw is pending. This belongs to escrow and membership work.

## Checked and not found defective

- **Optional policies cannot override deck checks.**
  - CARD_DEALT is always handled in `validateCryptoTransition`, and `verifySystem` is never consulted for it.
  - `entryInput` is bypassed there, but `completeDeckDeal` parses the input with the strict `dealInputSchema`, so a `card` field is still rejected.
  - `revealDeckCards` runs before `verifyCommand`, which can only add rejections.
  - While `decks.active` is set, every non-control input fails `deck-pending`.
- **No proof-seed reuse.**
  - The reveal seed context (genesis, epoch, anchor, seat, nonce, command, slotId) determines every input to the DLEQ challenge, because the statement, draw and identity are all fixed by the slot.
  - The unlock seed `{operation, step}` covers its whole challenge as well.
  - Unlock points are deterministic, so an equivocated unlock variant cannot fork the receipt.
  - A same-nonce retry at a new parent produces a new seed.
- **Stale, relayed and honest traffic is not penalised.**
  - Stale operations are ignored without a strike.
  - An honest relay cannot be struck. The operationId pins the frozen operation, verification is pure, and relays verify before storing.
  - Honest SUBMITs are not struck during a crypto-pending draw, because local `submit` rejects the command before broadcast.
- **Restore and disposal behave correctly.**
  - After restore, a stored unlock is re-emitted once the prefix reaches its step, and the chain rebuilds from step 0.
  - A disposal during an await cannot misuse a zeroed key, because `prepareDeckUnlock` copies the key before its first await.
- **No card identities leak.**
  - DECK_CONTRIB, CARD_DEALT, events and statuses carry no card identity.
  - An uncommitted PLAY_DEV_CARD SUBMIT discloses only what `command.card` already declares.

## Verification gaps

1. **The fixture's `createDeckSource` holds every seat's master.** The "non-owner sees `null`" assertion is enforced only by the key gate. Nothing proves a replica or driver lacks foreign secrets. Give each host a factory that holds only its own seats and hosted bots.
2. **Invalid DECK_CONTRIB paths are untested.** Missing cases: an invalid longer prefix causing a strike, exact retries staying cheap, disconnection after five variants, and stale or future operations ignored without a strike.
3. **Driver failure after public commit is untested.** Missing assertions: the replica halts, the journal keeps the entry, restore fails the same way, and no private state is published. Also missing: listener and automatic-input exceptions (M1).
4. **Store edge cases are untested.** Missing cases: `putIfAbsent` returning `false` with a matching or mismatching winner, a lost acknowledgement (write committed but threw), a corrupt reservation, and a stored unlock replayed against a relayed prefix.
5. **Several live scenarios are not covered by the two-human network test.** Missing:
   - three or more humans, so third-party relay is exercised;
   - consecutive local bot unlockers;
   - a second draw at position 1;
   - a control entry between the draw request and CARD_DEALT;
   - a six-seat draw.
6. **Reveals are never produced live.** No test drives `P2PSession.submit` → `prepareCommand` → a certified PLAY_DEV_CARD or automatic CLAIM_VICTORY through a live replica. Coverage today is replay-level only, in `deck-log.test.ts`.
7. **Key zeroisation on dispose is not asserted**, for either `ReplicatedLog` or `P2PSession`.
