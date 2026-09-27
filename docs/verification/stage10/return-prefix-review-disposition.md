# Return promotion review disposition

The initial and follow-up reviews are pinned in `return-prefix-review-manifest.json` and `return-prefix-followup-manifest.json`. Their raw responses remain unchanged.

Promotion now validates the retained local certified prefix independently, then compares signed entry hashes to the imported prefix. Different valid quorum certificates over one signed entry can coexist. Storage keeps the existing certificate wrappers and appends only the missing suffix. It repeats this validation inside the IDB write transaction against the exact loaded bytes.

An original device may have missed its removal while closed. At its saved head, promotion requires either valid active consensus safety bound to the named old key or a valid retired marker if that key has already left the replayed voter set. A retained `decision` or `unappliedCertificate` must match the imported next signed entry. Conflicting certified decisions fail without changing the journal or binding.

The game-wide lease is present on both sides. `openOnlineGame` acquires `acquireActiveGameWriterLease(gameId)`. `IndexedDbProtocolJournal.promoteTransfer` acquires that same lease before its transaction and releases it after completion. The transaction replaces the old binding and installs internally generated fresh safety. An old writer's height and revision CAS cannot overwrite it.

The destination precheck uses the exact certified recovery activation reference to select the retired key, matching storage. Decoded safety buffers remain intact until validation finishes, then cleanup wipes them. No key is revived by return; only the certified fresh controller receives authority.

Focused regressions cover pre-removal active and post-removal retired journals, alternate valid quorum wrappers, a different valid signed entry at the same height, a conflicting next-height decision, and invalid active safety. The reviewed stale-answer concern is handled by signaling envelope v2 and the separate signed answer-to-offer review.
