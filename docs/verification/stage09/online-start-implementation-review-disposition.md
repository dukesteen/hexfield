# Online start implementation review disposition

The [Claude response](online-start-implementation-review-response.md) reviews the
files pinned in the [manifest](online-start-implementation-review-manifest.json).
The review used source and deterministic test code, with tools disabled. The user
has approved Claude reviews. Browser resume implementation began after the review
snapshot and needs a separate follow-up review.

## Confirmed storage finding

M1 is reproduced. `IndexedDbByteStore.withCeremonyLock` rejected both `_` and `-`
as the first character of a valid base64url ceremony identifier. Two regressions
failed with `IndexedDB record key is invalid` before the fix. The lock validator
now permits these characters without changing the lock namespace or names of
previously valid locks. Record-key validation and size limits are unchanged.
All 11 byte-store tests pass, including atomic writes, cross-connection locking,
database migrations, malformed records and the absence of browser Web Locks.

## Coordinator and startup follow-up

The coordinator corrections for M2 and L2 distinguish publicly invalid-envelope
evidence from an actual secret disclosure after consent, and discard packets
from unrelated devices or the wrong slot owner without retiring the attempt.
Their focused regressions passed. L1 now loads the durable manifest under the
attempt lock before retiring escrow. A recorded consent or completion prevents
retirement; a restart can finish the attempt write after escrow retirement
already committed. The interrupted-write regression passes. Startup now installs
its approved agreement after the device roster freezes successfully and checks
the exact freeze hash before pinning the agreement. Its retry regression passes.

Saved-game resume now requires existing credentials, a bound voting journal,
the exact saved ceremony result and all prior ceremony records. It checks stored
disputes before activation. The coordinator also subscribes before replay and
withholds its result until messages received during replay have drained; a real
signed-dispute regression proves that no ready notification escapes this check.
The browser startup awaits that drain before opening the game.

The [resume checkpoint](../stage10/browser-resume-checkpoint.md) records the
current implementation and bounded local checks. This resume delta still needs
its follow-up review and actual browser integration checks. This document is not
a completion or release claim.
