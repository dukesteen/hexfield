# Cheat candidate delivery review

Read-only security and correctness review. Tools are disabled. Review only the supplied source. Do not claim to run tests.

The prior follow-up is included. Check its N1 nonce-gap, N2 historical-parent hash and proposal budget, N3 stale detached-context fixes, and the corrected T1/T2/T3 regressions. The count bound now imports MAX_HAND_RESOURCE_COUNT. A malformed signed steal ephemeral point is attributed only after the owner signature passes.

The new live slice adds CHEAT_CLAIM and CheatCandidateStore. Review persistence before gossip/proposal, exact retry after restart, first objectively valid retained claim per seat/kind, certified deletion after journal commit, authenticated relay identity versus actual offender, work budgets before historical proof replay, and priority during owed crypto work. Check the live test commits an actual next deck pass after a finding. A store is scoped to one game and local replica. Memory stores are test doubles, not browser persistence.

This slice does not yet capture invalid artifacts automatically, add invalid-crypto proposer accusations, expose findings in the UI, or move historical replay into incremental worker jobs. Those remain planned. Current replay uses bounded per-peer request budgets and a small checked-parent cache but may synchronously replay a full certified prefix. Distinguish those known integration gaps from defects in the implemented slice.

Report concrete remaining defects, their traces, minimal fixes, and discriminating regressions. If the fixes hold, say so. No actual game secrets or credentials are included.
