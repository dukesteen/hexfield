# Native browser protocol journal check

Verified in Chrome on 2026-09-27 using the local development page at
`http://127.0.0.1:5187/dev/storage-smoke.html`. Two dedicated workers shared
native IndexedDB and Web Locks on the same origin.

All checks passed:

- Exactly one worker won each first-write and byte compare-and-swap race.
- Closing and reopening storage retained the committed bytes.
- Web Locks serialized both ceremony callbacks.
- Exactly one worker initialized the protocol journal and won its safety revision race.
- Exactly one worker committed the certified-entry fixture and next-height safety together.
- Closing and reopening the journal returned that exact entry hash and the winning next-height safety bytes.
- Old-height safety writes and commit retries were refused.

The fixture uses synthetic public signed records and a placeholder membership
payload. This checks storage transactions, not acceptance of a real membership
transition. No real game secrets or private fixture keys were stored or sent to
the workers. The run did not test browser crashes, power loss, quota exhaustion,
multiple devices or complete session recovery. Milestones C/D remain incomplete.

The initial server served an older cached script. After restarting Vite and
allowing dependency optimization to reload the page, the current script showed
all eight PASS messages, ending with `native storage and protocol journal checks
complete`. The storage, page, worker and schema file hashes remained unchanged
across the run; see [the manifest](native-journal-manifest.json).
