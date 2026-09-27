# Seat-transfer design follow-up review

Review the attached design and pinned source excerpts as text only. Tools are disabled. The earlier raw review identified thirteen issues; the revised design tries to resolve them. Do not treat the design as implemented, infer omitted APIs, or claim to have inspected files beyond the supplied input. No actual game save, identity, voting key, master, escrow share or network credential is included.

Look for concrete safety or liveness defects in:

- Same-device return and fresh-device import under one active IndexedDB journal binding, separate inert staging, a game-wide active lease, and an atomic promotion that never copies old signing/safety bytes.
- Destination possession signatures, exact-parent private readiness, activation while the destination is offline, certified cancellation and retries when an authorization or staged material fails.
- Authentication of the last certified human after a prior transfer and a recovery amendment. Master possession and a copied device identity must not grant a human vote.
- Current-voter certificates across epoch changes, pending recovery exclusion, affected bot ownership, route swaps, stale exports, and old-key rejection.
- Whether each implementation phase names the source packages and tests needed to enforce its claim.

Report only findings with a trace, affected design passage and minimal correction. Separate design defects from current-source limitations and claims the excerpts cannot prove. Do not suggest weakening strict quorum or substituting a copied old voter key.
