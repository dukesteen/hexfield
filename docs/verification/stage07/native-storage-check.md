# Native browser storage check

Passed in the existing Chrome session on 2026-09-27 using the development-only `/dev/storage-smoke.html` harness at localhost:5187. The [source manifest](native-storage-manifest.json) was captured before the successful run and all five hashes remained unchanged afterward. No browser process was launched for this check.

The rendered result reported:

- PASS atomic first write and CAS across two workers
- PASS native IndexedDB reopen preserves committed bytes
- PASS native Web Locks serialize both ceremony callbacks
- PASS native escrow storage check complete

Two Web Workers use independent connections to the native same-origin IndexedDB database. The check requires exactly one winner for concurrent insert/CAS attempts, closes and reopens connections, and verifies that native Web Locks exclude concurrent ceremony callbacks. It uses random namespaced test records, with no actual game secrets. This is evidence for cross-worker concurrency and connection reopening in Chrome; it does not claim tab-crash, power-loss, mobile or cross-browser verification. Unit tests separately cover transaction abortion after a successful write request.
