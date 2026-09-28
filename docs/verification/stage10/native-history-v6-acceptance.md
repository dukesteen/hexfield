# Current-v6 native history and deletion acceptance

**PASS**, 2026-09-28: one fresh installed-Chrome context, 20.8 seconds for the
test and 24.2 seconds for the runner, within the unchanged 90-second cap.
All 439 [pinned source files](native-history-v6-source.json), including the test
and deletion fix, remained unchanged. The [terminal report](native-history-v6-terminal.json)
and [exact log](native-history-v6-trace.log) preserve the result.

The fixture installs a disposable signed four-human protocol-v6 prefix through
sequence 8, with 31-day-old activity metadata. It contains no real user keys or
live session. The UI marks the game inactive, exports HXAR1, opens its public
replay, reloads it and checks the 390×844 mobile view. Cancelling removal keeps
the game. Confirming removal writes the permanent tombstone, removes the saved
game and survives reload. Resaving its original signed start and reinitializing
its journal both reject the deleted game. The independent public replay remains
readable, and importing the downloaded HXAR1 still succeeds. No page errors occur.

The first run failed because the tab's vault controller retained an idle shared
parent lease after settings/replay reads. Deletion requires an exclusive vault
lease, so that parent incorrectly blocked its own deletion. The fix releases
only an idle parent while blocking new acquisitions. It refuses live scopes;
the worker still obtains the exclusive vault and active-game writer leases.
An encrypted vault relocks after this operation and must be unlocked again.
Clear vaults return to ready. A failed status refresh reports an error and can
recover without trapping the controller in busy state or masking an earlier
deletion failure.

An intermediate run reached deletion but the test reloaded during the vault's
busy view: the temporary absence of history items was mistaken for completion.
The final harness waits for the durable tombstone and the page controller's ready
state before reload. Both failed runs retain their exact compressed logs and
source manifests (`native-history-v6-initial-*` and
`native-history-v6-interrupted-*`); neither is acceptance evidence.

The final focused controller, worker-client and storage run passes 22 tests in
2.59 seconds. Shared test TypeScript checking, scoped type-aware lint and
formatting pass. A separate read-only agent review checked the scope/epoch races,
exclusive-lock boundary and error handling; its status-refresh finding was fixed
and covered by a regression before the final native run.

This closes the installed-Chrome inactive-history, confirmed-deletion and local
non-revival checks. It does not claim private-data erasure, live writer contention
across browsers, the mixed-engine/device matrix or every storage interruption
boundary. Global identity, ceremony anti-equivocation records and independent
public replays intentionally remain outside game removal.
