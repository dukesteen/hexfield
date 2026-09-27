# Transfer resume review disposition

The read-only review is pinned by `transfer-resume-review-manifest.sha256`.
The following corrections remain local and do not enable the unfinished browser
transfer flow.

1. Confirmed: a restored installing-generation binding could retain working
   secrets for a bot that subsequently returned to its human. After verifying the
   exact journal binding, `openOnlineGame()` now wipes inactive material copies and
   backs every master/proof-source callback with current owned material only.
   The live membership hook removes entries from that same map. A failed
   transferred `OnlineStartup` open now disposes its material immediately; retry
   rereads the verified durable binding. The real recovery, host-transfer and
   human-return regression opens the surviving host through `openOnlineGame()`
   with its original installing binding. It proves the returned seat has no
   master or usable deck/driver source while the host retains its own access.
   The focused test passes in 8.4 seconds.
2. Confirmed: dropping the retired route also prevented a source that missed the
   activation commit from syncing its retirement. The transport now retains at
   most six retired routes for 128 certified heights. These routes permit only
   certified history requests and responses plus a one-shot retirement notice.
   They cannot send commands or votes and are excluded from active peers. The
   replica requests history after attaching its listener and retries on its
   existing pulse, with ten-second request deduplication. The transport test
   deliberately delivers the notice before the listener exists, then checks
   filtered catch-up traffic. The real session regression restores the replaced
   player immediately before its missed activation, with a survivor already
   online and no new notice. Automatic sync installs activation, wipes its old
   private hand and persists retired safety. Reopening the old key fails.
   Proposed destination keys cannot use this route. Complete replacement of
   every survivor visible to an old save still needs the separate public
   bootstrap flow; this checkpoint does not claim that case works.
3. Membership command settlement now runs after the routing hook, while the
   final certified commit broadcasts under the old routes first. An expected
   local retirement settles successfully. A hook failure disposes the replica
   and reports an unknown outcome instead of successful handoff. The existing
   four-replica test checks successful commit, hook and settlement ordering. It
   also injects a hook failure after certification, verifies the committed
   journal, and requires `replica-outcome-unknown` from the waiting submission.

The final transfer-session file passes all three tests, the beacon-contribution
file passes all eight, and the four-replica transfer test passes. Production and
test typechecks, scoped type-aware lint, formatting and diff checks pass after
these final regression additions.

The IndexedDB journal constructor owns its binding bytes. Its copy now uses
`new Uint8Array` explicitly, including Node Buffer callers. The fake-IndexedDB
regression mutates the caller's bytes before journal initialization and checks
that the original binding persists. The transferred-startup test still uses a
memory journal; end-to-end promotion through the browser factory remains part
of the future user-flow acceptance, separate from storage transaction tests.
The journal file passes all 17 tests, including both plain bytes and Node Buffer
callers, in 1.61 seconds wall time.
