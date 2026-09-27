# Multiplayer product checks — 2026-09-27

This checkpoint follows the redesign merge. The milestone remains open; the
checks below do not stand in for unrun browser, network or performance acceptance.

## Reconnection and QR codes

The reconnect panel initially shows the known missing players and allows the
transport to retry automatically. After a 30-second connection attempt, it offers
manual codes, listing only missing human devices from the current certified route
map. A manual room with no connected peer and no signaling server can offer codes
immediately because it has no automatic signaling route. Returning peers reset the
UI fallback. This timer changes no quorum, voting or recovery rules.

Every displayed QR code uses `InvitationCode`. Clicking its dedicated button opens
a larger native modal. Close, Escape and backdrop dismissal restore focus to the
trigger. Closing this modal does not dismiss a surrounding reconnect or transfer
dialog; a regression reproduced that nested-dialog bug before the fix. Copy,
share and invitation text controls remain separate.

Seven focused QR/reconnect tests pass. A single isolated native Chrome check on
the local development app verified the QR modal at 1365×900 and 390×844. Its bounds
were respectively 680×674 and 358×466, within the viewport. Escape restored focus
to the trigger. This is a layout and interaction check, not a physical camera scan.

## Departure safety

`packages/protocol/src/p2p-departure.test.ts` passes two integration tests using
real signed two- and three-human games. The remaining peers make no progress
without their required voter, release no recovery shares, and cannot request a
takeover after 200 seconds of virtual absence. The returning player resumes the
same certified prefix and a subsequent legal move commits. The two-human case
also restarts all peers from their durable records.

The focused test took about 28 seconds. It does not establish browser restart
latency or the separate four-human takeover-to-audit requirement.

## Takeover controls

The signed lobby configuration exposes vote/automatic mode and the delay, including
never. It explains the irreversible disclosure of the recovered player's secrets.
The default is vote after 120 seconds, matching the stage-10 design. Games with
two or three humans still wait for a required player to return.

The game offers a request only after the worker's read-only eligibility check
passes. Approval applies to the exact current candidate and disappears if its
player reconnects. Protocol admission repeats the authoritative checks. See the
[Claude review disposition](takeover-product-review-disposition.md), including the
43 passing focused product/worker tests. No browser takeover completion is implied.

## Browser transfer investigation

The three-context native Chrome test exposed a real integration fault: the worker
entry point omitted transfer requests from its ingress allowlist. Direct runtime
tests had bypassed that boundary. Both WebRTC links authenticated, but the source's
bootstrap-export request never reached the worker runtime. The test was kept
bounded and the browser contexts closed normally; Firefox and WebKit were not run.

The corrected entry point accepts all 13 transfer request kinds, validates their
bounded bodies, and uses an exhaustive request-kind map so another RPC cannot be
silently omitted. Seven entry-point tests pass. In native Chrome, a 52,578-byte
bootstrap crossed the authenticated channel, the destination validated it and
returned its signed offer, and the source reached confirmation.

The immediate confirmation was correctly refused because initial deck setup was
still pending. A later native trace established that setup completes at certified
head 5 after the protocol retry, around nine seconds. The original test assumed
the source owned the first turn and then read a duplicate Vite module registry;
neither observation establishes a production startup stall.

The corrected [native v5 test](native-transfer-acceptance.md) passes in 21.6
seconds. The survivor and destination certify activation, reconnect their new
authenticated link, accept a legal move from the new device and finish at matching
heads. Reloading the old source refuses to restore its retired signing key. The
frozen source composition and narrower scope are recorded in that note. Certified
cancellation also passes in 46.7 seconds, including receipt, continued source play
and durable cancelled destination reload after correcting the terminal-reopen UI.

## Current-version recovered game

The [seed-4 v5 run](recovered-v5-acceptance.md) passes in 95.42 seconds within
the unchanged 120-command/180-second bounds. It certifies recovery, completes a
three-point game and obtains complete clean audits from all three survivors.
Dice and card derivation are unchanged. The fixture records the owner's private
development-card receipt at the deal commit, before a later victory claim can
consume that slot.

Seat 0 is disconnected before survivors open their sessions. This establishes a
complete recovered game on v5, but does not establish mid-game browser departure,
the default ten-point game, or separate equality of all final head hashes.
The fixture uses the built-in verified protocol checks and success-only optional
application policy callbacks. The note records the exact source hashes, artifact,
test policy and scope. The expensive scenario remains opt-in through
`CP2P_RECOVERED_AUDIT_RUN=1`.

## Finished-game metadata

`online-game-history.ts` stores a separate bounded outcome record. It is never
used to authorize resume or voting. Writes pin the original terminal result and
its certified head, reject conflicting or regressing heads, and store hidden
scores only after a complete clean audit of that exact terminal and final head.
Input schema validation happens before any write.

`openOnlineGame` finds the terminal head during its existing verified restore
replay, or observes the first live terminal state. Its subscriber serializes and
deduplicates metadata writes. Closing stops the subscriber, disposes and flushes
the session, drains metadata writes, then closes the journal and game writer.
Metadata errors produce a generic warning or the caller's error callback without
affecting protocol authority.

The home query loads outcomes separately from certified start pointers. A damaged
outcome does not hide the resume link; it is marked unavailable and excluded from
statistics. Pending and failed audits never contribute hidden scores or aggregate
statistics. Leaving the game invalidates the list after close completes, and home
mounts also refetch it.

The outcome/writer tests pass eight cases. This is not a real browser
endgame-to-home acceptance trace. Saved history now offers verified public replay
export, read-only opening and confirmed local removal. Its activity record marks
unfinished games inactive after 30 days without changing resume authority. The
metadata and interaction tests cover failed exports, busy deletion and damaged
display records. General save import with optional private material is separate
work; public replay export alone does not satisfy it.

The [saved-history checkpoint](saved-history-checkpoint.md) records the passing
20.4-second native Chrome export, replay, reload and removal check, including
mobile layout. It also records the worker boundary, deletion guarantees and
focused tests. It does not substitute for an endgame-to-home audit trace.

## Combined checks

The final focused QR/reconnect/game-screen/history group passes 19 tests. The
production web build, complete production/test type checking and dependency
boundaries pass. Type-aware lint and formatting pass on the owned checkpoint
files. The in-progress transfer E2E diagnostic is excluded from that checkpoint;
the unrelated untracked redesign kit and the user's expansion-plan documents are
untouched. No deployment or complete M-C/M-D acceptance is implied.
