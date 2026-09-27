# Transfer ownership review disposition

The read-only review is pinned by `transfer-ownership-review-manifest.sha256`.
It covers the corrected private-transfer helpers, durable destination credentials
and per-seat runtime release. The browser game factory was outside that input;
it is included in the separate resume review.

1. A transferred host's formerly-human bot needs its original beacon source.
   `openOnlineGame()` constructs and seeds `beaconSources` for every active
   bound bot with a certified original chain, using its imported original master.
   Only genesis bots without a chain skip this step. Missing human-chain sources
   fail closed in the replica. The reviewer did not have this caller. A real
   recovery followed by host-transfer test now passes with that source and
   rejects a missing source. It also exposed a shared-store collision: human
   and bot contributions at one transfer generation used the same beacon outbox key.
   The slot now includes the seat number, with no old-slot fallback. The two
   transfer-session tests and eight beacon-contribution tests pass.
2. `P2PSession.restore()` requires its supplied bot keys to match current active
   ownership. Silently dropping a wrong supplied key would hide corrupt caller
   material. The browser first validates the complete durable binding against the
   human key's installing generation, then filters current authority, key and
   host before passing `botKeys`. That filtering is present in `openOnlineGame()`;
   the review's claim that no caller can do it does not apply. The real
   recovered-bot transfer test rejects a stale supplied bot key and restores
   both owned private hands with current keys. The browser-factory regression
   also passes after a later recovered-human return. It restores the host from
   its installing binding and denies private access to the returned seat.
3. The codec's `fromBase64UrlInternal()` allocates a plain `Uint8Array`, so decoded
   secret slices cannot be Node Buffer views in this implementation. The two
   credential-copy sites now use explicit `new Uint8Array(...)` for consistency
   with the owned-buffer contract. This is not a reproduced aliasing bug.

The review confirmed early signature authentication, source-parent replay,
independent master copies, named return-custody filtering, exact immutable outbox
retry and ownership-specific release. Recovery cannot begin while a transfer is
pending. Signing uses deterministic Ed25519. Blinding values are scalars, not
mutable byte arrays. Cleanup covers owned working buffers; it cannot erase what
an earlier holder learned, and browser credential retirement remains part of the
unfinished transfer orchestration.
