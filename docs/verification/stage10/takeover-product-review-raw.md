Reviewed the diff and new files. Concrete findings below, ordered by severity. Line numbers for new/rewritten hunks are counted from the diff context since no absolute line numbers are given for new files.

## High

**Stale recovery candidate can still be approved after the departed seat reconnects**
`apps/web/src/features/online/RecoveryPanel.tsx`, guard clause (~lines 75–80):
```js
if (
  policy.afterSeconds === 'never' ||
  (!takeoverAvailable && !candidate) ||
  (missing.length === 0 && !candidate)
)
  return null;
```
This only suppresses the panel when `missing.length === 0` **and** `candidate` is falsy. If `candidate` is still set (e.g. store hasn't cleared it yet) but the seat has already reconnected (`missing` no longer contains it), the Approve/Decline UI still renders. This is reinforced by `candidateName` (~lines 84–87) explicitly falling back to a generic "Seat N" label when the departed seat isn't found in `missing` — i.e., the code anticipates this state and displays the approval UI anyway instead of hiding it. Nothing here cross-checks `candidate.preview.departedSeat` against the live `missing` set before offering an approve action. Even if the certified layer re-validates on submit, the UI shouldn't invite approval of a takeover for a seat that (from this device's view) is no longer missing. Recommend also gating `choice` on `missing.some(m => m.seat === candidate.preview.departedSeat)`.

## Medium

**Hardcoded "4 humans" gate doesn't generalize to actual player counts**
- `apps/web/src/features/online/OnlineGameScreen.tsx` (~lines 275–283):
```js
const canInitiateTakeover =
  currentHumans.length === 4 &&
  missingHumans.length === 1 &&
  game.seat === Math.min(...currentHumans.filter((seat) => seat !== missingHumans[0]?.seat));
```
- same file (~line 450): `takeoverAvailable={currentHumans.length === 4}`
- `apps/web/src/features/online/OnlineConfiguration.tsx` (~line where `humanCount < 4` warning renders)

Both the initiate-gate and the "takeover available" flag are hardcoded to exactly 4 total human seats. This changeset also touches `docs/11-module-framework-5-6-players.md`, so games with 3, 5, or 6 human seats exist. For any of those, `currentHumans.length` can never equal 4, so the entire takeover-initiation UI silently never appears — not because a quorum rule was correctly evaluated, but because of a literal `4`. I'm not suggesting loosening any quorum check — just flagging that this constant should be verified against whatever the real (e.g. 2/3-of-humans) threshold is meant to be, since right now it looks like a leftover fixed assumption rather than a derived quorum.

**Default `TakeoverPolicy` silently changed from disabled to active-by-default**
`apps/web/src/session/online-room.ts` (~line 381): host-created lobbies now default to
```js
takeover: { mode: 'vote', afterSeconds: 120 },
```
replacing the previous `{ mode: 'vote', afterSeconds: 'never' }` (test expectation updated to match in `online-room-manual.test.ts` ~line 130). Every new lobby now has certified vote-based takeover enabled out of the box after 120s instead of requiring explicit host opt-in. That's a real change to the default disclosure/security posture (bot key material becomes requestable by default). Worth confirming this default flip was intentional and that hosts see the disclosure copy before this applies, rather than it being an incidental side effect of adding the feature.

**Can't confirm from this diff that the signed takeover policy actually reaches `game.genesis`**
`apps/web/src/features/online/OnlineLobby.tsx` (~lines 336–341) forwards the policy: `room.lobby?.configure(config, seed, takeover)`, and `OnlineGameScreen.tsx` (~line 447) later trusts `game.genesis.takeover` as the source of truth. The diff only shows the call site and the `GameSession`/type signature changes (`packages/protocol/src/session-types.ts`) — `LobbyController.configure`'s implementation and however `genesis` is assembled/signed aren't in this diff. This needs separate verification that `takeover` is part of whatever gets certified/signed at genesis, not just plumbed through local lobby UI state — otherwise peers could silently disagree on the policy actually in force.

## Low

**Auto-mode never re-surfaces the private-material disclosure**
`apps/web/src/features/online/RecoveryPanel.tsx`: the `onlineTakeoverDisclosure` paragraph only renders inside the vote-mode approval block (`{choice && statement !== declined && (...)}`). For `policy.mode === 'auto'`, players only see `onlineTakeoverAutoWaiting` — no disclosure at the point where an automatic takeover would actually happen. The only other place this copy appears is `OnlineConfiguration.tsx`'s unconditional `<p>` after the fieldset, shown once at config time (and only to whoever is viewing the lobby then). Worth confirming there's a disclosure moment closer to actual auto-execution for players who joined after configuration.

**Eligibility polling doesn't pause once a candidate exists**
`RecoveryPanel.tsx` (~lines 45–74): the polling effect's dependencies (`canInitiate`, `policy.mode`, `policy.afterSeconds`, `targetSeat`) don't include whether `candidate` is already set. It keeps calling `canRequestTakeover` every 2s even while another peer's request is pending a vote, since the request UI itself is separately hidden by `!choice`. Not a security issue — just unnecessary continuous RPC traffic. Cleanup/cancellation on unmount itself looks correct (`active` flag + `clearInterval`, matches the "eligibility refresh stops when the panel closes" test).

**Worker RPC validation for `canRequestTakeover`** (`online-protocol-worker.ts` ~lines 110–113) looks consistent with the existing `requestTakeover` pattern (`seat()` check + `onlyKeys` restriction) — no issue found there, but authorization enforcement itself lives in `requireSession()`/replica code not shown in this diff, so I can't audit further without inventing that context.
