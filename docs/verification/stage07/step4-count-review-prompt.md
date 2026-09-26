# Stage 07 signed Monopoly count delivery review

Perform a read-only security review. Tools are disabled. The packet contains only
listed source, design and tests, with deterministic fixture keys and no real game
secrets or credentials. The user has approved all Claude reviews.

Review this checkpoint's frozen owner-signed Monopoly count delivery. Focus on
concrete safety/liveness defects, proof binding, premature secret responses,
message persistence/retry, certified replay, duplicate consumption, private
publication, and a generic system callback bypass. Prefer focused regressions to
large simulation batches. Separate implemented defects from later-stage work.

The frozen operation is captured at certified Monopoly entry and includes the
complete requested victim roster, owner keys, commitments, resource, actor,
genesis, epoch and anchor. Each victim signs one exact count and Schnorr opening
of C-count*G to H. Zero requires a proof. Later victims reuse their operation and
proof across earlier victims and state-preserving proposer controls. The engine
chooses only victims with public maximum >0. Before secret-dependent production,
the driver checks ownership, current certified head, frozen operation and private
hand openings; a separate master-derived hand source supplies proof randomness.

Count evidence is checked before optional system policy in entryInput. A local
engine transition derives the required count obligation and exact resource
movement before consuming that victim and folding hand commitments. Frozen state
must match the engine pending and each unconsumed commitment. Terminal game state
may close remaining requests without fabricated movements. The count candidate
has priority, but pending counts do not suppress engine-legal victory claims.

The outbox stores immutable signed bytes keyed by operation and victim before
broadcast; retries load and validate the record, including a putIfAbsent winner.
The inbox is disposable and bounded by at most five victims. The replica rechecks
lifecycle/operation/remaining victim after await. P2PSession privately replays the
certified history before opening a restored replica.

Tests include small nonzero-blinding zero/positive proof cases, hostile envelope
and context cases, store retries/races/corruption, and synthetic trusted-parent
validator tests for zero/positive folds, proposer controls and callback bypass.
Those synthetic contexts are explicitly not legal genesis traces. A separate
bounded real two-human/two-bot peer trace uses seed 14 and an actual privately
dealt Monopoly card, handles every requested victim, and checks private folds.
Restoration in that live case is being finalized; judge the code present in the
packet, not this intent. No large random batch or browser launch is involved.

Scope remains unpublished verified mode, not the production online UI. Hidden
steals, other-owner uncertain-trade proof delivery, escrow, audit, durable browser
storage and WebRTC are still pending. All verified STEAL_RESULT inputs fail
closed. Protocol version/legacy command-evidence migration remain explicit gates
before public verified release; the prior ledger review covers that boundary.

Return severity-ranked findings with affected function, a concrete example and a
small correction. Call out claimed tests that do not support their assertion.
