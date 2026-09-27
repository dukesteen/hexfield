# Seat-transfer design review brief

Review the supplied design and pinned source excerpts as text only. Tools are disabled. Do not claim to run code or inspect files beyond the supplied input. No real saves, device identities, keys, escrow shares or browser storage are included.

Check the proposed two-step transfer and recovered-seat return against current authority, recovery, voting, device binding, storage and private replay contracts. Focus on:

- Whether a return intent authenticates the last certified human owner even after an earlier seat transfer, without treating recovered master possession as identity.
- Whether the live lost-key and return-without-key approval rules are possible under the current quorum and exclude the absent bot.
- Exact affected-bot derivation across recovery, pending changes, later ownership changes and bounded history caches.
- Old-set/new-set voting safety, destination readiness before activation, retirement before any destination vote, and destination disconnection after readiness.
- Private package integrity, replay/import checks, writer safety, stale saves and crash points.

Report only concrete defects or ambiguities with a trace, affected design section, and minimal correction. Separate current-source limitations from flaws in the proposed design. Say when a claim cannot be checked from the supplied excerpts. Do not suggest production edits or broader implementation work unless a specific flaw requires them.
