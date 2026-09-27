# Native browser writer lease check

Verified in Chrome on 2026-09-27 through the local storage check page at
`http://127.0.0.1:5187/dev/storage-smoke.html`.

Two dedicated workers shared the browser's native Web Locks manager. The first
worker acquired a game/voter writer lease. The second received the expected busy
result while that lease was held. After the first closed its lease, the second
acquired and closed the same lock successfully.

The page showed all nine PASS lines, including
`native game writer lease excludes a second worker and releases on close`.
The existing IndexedDB insertion, byte CAS, journal initialization, safety CAS,
atomic commit, reopen, and stale-height checks also passed. The source hashes
are recorded in [the manifest](native-writer-manifest.json).

This verifies the native cross-worker lock behavior. It does not prove complete
session integration, process-crash recovery, disk durability after power loss,
or cross-device seat transfer. The journal fixture uses synthetic signed public
records and a placeholder membership payload; no real game secrets are stored.
Milestones C and D remain incomplete.
