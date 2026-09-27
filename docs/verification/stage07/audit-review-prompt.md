# Audit and live recovery review

Review the supplied source read-only. Tools are disabled. Do not claim to run
tests. The user has authorized all Claude reviews. The bundle contains source,
design and deterministic test fixtures, with no credentials or real game secrets.

Focus on the recent audit and reveal implementation at commit `24b7296`, including
its integration with the prior live recovery checkpoint. Trace concrete attacks
and lifecycle races through the supplied code. Report actionable findings with
file/function references, severity, failure sequence, minimal correction and a
regression that distinguishes the defect. Separate demonstrated defects from
questions that require omitted source. Do not turn unfinished product features
into implementation bugs.

Check these boundaries:

- A master can be disclosed only after a durably certified game result, by its
  original owner or an authorized recoverer. F0 matching is distinct from the
  remaining derived-key consistency checks. Invalid input must not falsely accuse
  the original owner.
- Reveals bind the exact genesis and first result. Retries and accepted packets
  survive restart without signing a new promise or accepting stale authority.
  Incoming storage errors and observer errors must remain recoverable. Disposal
  during asynchronous work must not return or retain master buffers.
- Exact private replay audits draws, steals, resource conservation and victory
  claims against the certified history. Missing input, proof failure and cheating
  have distinct report meanings. A recovered seat still uses its original master.
- Recovery restores command authority and private state only after the certified
  transition. Retired keys cannot resume voting, and bot continuation must not read
  another player's private hand.
- The session runs audits separately from the certified engine result, cancels
  stale workers and erases owned buffers. A worker failure must allow explicit
  retry without a new game entry. Check report/head correlation and late replies.

Existing verification: the full check passed static gates and 1,121 tests, with
one browser-adapter test failing under Node because ErrorEvent was unavailable.
The corrected test environment passes all five adapter tests. A later disposal
race fix passes all four reveal tests. Static checks and build pass on the final
source. The full suite was not rerun after these scoped corrections. No real
browser audit worker or complete recovered-game audit has been verified yet.

Known remaining work includes the production online lobby and session wiring,
automatic cheat consequences, adversarial acceptance, and the proof-performance
target. The current reveal transport requires the sending peer to be the signed
publisher and does not relay accepted reveals. Assess whether that creates an
additional durability/liveness defect. A dedicated F0-matching but otherwise
inconsistent-genesis terminal fixture is also still absent.

End with a short assessment of whether the current checkpoint is suitable to
integrate into the online flow, and list the essential fixes first. Do not label
milestones C or D complete.
