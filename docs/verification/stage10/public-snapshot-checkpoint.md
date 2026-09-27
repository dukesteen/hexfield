# Public snapshot cache checkpoint

Date: 2026-09-27.

The online session offers a detached public snapshot to storage after applying
every hundredth certified commit. The cache is optional. Synchronous and
asynchronous cache failures cannot escape the hook or change the certified
commit verdict.

IndexedDB version 4 adds `snapshots`, keyed by `[gameId, seq]`. A write checks the
stored genesis digest, the exact durable entry hash, the 100-entry interval and
the deletion marker in one transaction. It retains the latest three snapshots.
Closing the online session drains snapshot writes before closing the journal and
releasing its writer lease. Game deletion removes snapshots in the same
transaction as its permanent deletion marker and journal cleanup.

A read takes a context produced by independent full certificate replay. It
compares the cached bytes with the canonical snapshot derived from that context
and returns the derived value. It never decodes an untrusted cached snapshot.
No restore, membership or voting path obtains authority from this cache.

The focused checks cover scheduled writes, retention, reopen, altered replay
state, missing or mismatched durable heads, a deeply nested corrupt cache,
deletion, migration and cache-write failures. Storage fixtures establish these
boundaries; they do not claim to produce one hundred signed commits. A browser
trace crossing that commit boundary remains separate acceptance work.

This change does not encrypt live private storage or accelerate restore by
skipping certificate replay.

## Validation

- Snapshot, deletion, byte-store and hook tests: 20 passed in 1.37 seconds.
- Snapshot-store tests after the byte-comparison correction: 3 passed in 1.73 seconds.
- Existing journal and transfer-store suites after the migration: 36 passed in 20.64 seconds.
- Storage, protocol and web TypeScript builds, test typecheck, scoped type-aware
  lint and formatting, and dependency checks passed.
