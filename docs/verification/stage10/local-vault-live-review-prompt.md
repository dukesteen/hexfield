# Local vault live integration review

Review the pinned source-only patch for the optional browser local vault. Tools and MCP are disabled. Do not infer behavior from runtime secrets or saves; none are included.

Focus on concrete release blockers in:

- lock/unlock and cross-tab lease ordering, especially room/worker opening or closing during a lock;
- stale generation and absent identity handling, with no plaintext fallback or silent key remint;
- non-extractable key handoff to the protocol worker and one-shot full-save/public-archive workers;
- every protected byte-store and journal consumer reached by these app paths, including nested private-export inventory;
- whether storage operations or worker requests can continue after key disposal, or whether the controller can wait forever on its own closer.

Treat the repository's injected worker/store factories as test seams. The attached diff and new controller source are the review boundary. Give file/line evidence for each actionable finding, explain a realistic trigger and smallest safe correction. Distinguish a confirmed defect from a limitation needing a wider app integration. Do not propose changing consensus, certified replay, or wire protocol.
