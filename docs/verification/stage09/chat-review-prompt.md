# Chat and emote security review

Read-only security and correctness review. Do not use tools or edit files. This is a frozen source/test snapshot, with deterministic test keys only and no runtime credentials or private game records. The user has authorized Claude reviews.

Review Stage 09 §6 signed lobby/game chat and quick emotes. Chat is deliberately outside the certified game log and runs over authenticated device WebRTC links. Focus on bounded ingress and serialized work, 5-per-10-second per-sender rate budgets, signature and scope binding, current signed/certified roster authorization including lobby spectators, duplicate handling across restart, persisted local history and mutes, and async/disposal/lobby-to-game races. Check that CP2C chat packets do not leak into lobby, ceremony or gameplay protocol diagnostics. Inspect UI for stale drafts, rapid duplicate sends, muting and scope consistency.

For each confirmed issue give severity, file:line, an executable sequence, and the smallest safe correction. Distinguish security bugs from a documented bounded-history limitation or missing browser evidence. Do not assume a peer can forge another device's signing key. Do not recommend putting chat in the certified log. If no blocking issue remains, say so plainly.
