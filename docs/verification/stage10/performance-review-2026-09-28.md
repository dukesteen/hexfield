# Performance review, 2026-09-28

This is a read-only design review, not a review of the implementation now being
developed. Claude Opus 5.5, medium effort, completed successfully in 161,620 ms.
The invocation ran in plan mode with tools and MCP disabled; stderr was empty.
The prompt, exact source manifest, raw JSON response, stderr capture and empty
MCP configuration are retained in the [review evidence archive](performance-review-2026-09-28-evidence.tar.gz),
SHA-256 `161c6686a6c0ce148b16cda7c03cb6eff145842ba7ceda81067eff8d609e9515`.
The review manifest pins the inspected protocol, codec, audit and profile files.

## Recommendations

1. **Live agreement path:** retain the canonical context stamp as a string and
   use exact string equality for context comparisons. Canonical encoding's
   UTF-8 conversion is injective for its well-formed output, so this can preserve
   the existing validation and fail-closed call points while avoiding per-byte
   callback comparisons. The review considers the safety argument strong and
   the size of the speedup medium-confidence; measure it in the same bounded
   profile before drawing performance conclusions.
2. **Audit path:** consider fusing the omniscient engine observer and the
   independently reconstructed per-seat observer over one freshly validated
   certified-prefix pass. Both algorithms must still execute for each entry,
   and the implementation must preserve error precedence and report semantics.
   A private internal API should derive prior/next contexts from its own
   validation; no public caller-supplied “already verified” flag is acceptable.
   A differential report oracle, replay-count check and failure-precedence
   cases are required before accepting this change.
3. **Encoding cache:** an identity-scoped cache for codec-owned frozen
   immutable data may help if extended to certified head data. Genesis-only
   caching is likely a small gain. The reviewer flags in-place mutation risks,
   `Uint8Array` subtrees and cache export reachability; it recommends measuring
   stamp cost by top-level field before deciding whether to implement this.

The review also recommends measuring audit jobs as started and completed
separately, since current timing counters can omit work that has started but has
not finished. This is particularly relevant to scenario 5's timeout artifact.

These are design recommendations only. The checkpoint string-stamp change is
under implementation, and the audit work is planned separately. The reviewer
did not inspect or approve those final diffs, and this document does not claim
that either change is complete or measured. It does not approve any public
caller-supplied context bypass.
