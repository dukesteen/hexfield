# Online start implementation review

Read-only security and correctness review. Do not use tools or edit files. The user has authorized this project review. The attached source bundle is a frozen snapshot with deterministic test keys only; it contains no runtime credentials or private game records.

Review the complete online genesis handoff, with emphasis on:

- Durable reservation of each signed output before transport enqueue, the attempt-lock → escrow-lock order, and cross-tab abort/consent races.
- Exact replay after interrupted writes, restart, dropped private shares or ACKs, and expiry before or after irreversible genesis consent.
- Four-human Feldman share routing, holder-only plaintext access, authenticated and objectively verifiable disputes, and retirement before complaint publication.
- A valid disclosure arriving after `ready`: the coordinator must clear its result, and browser startup must stop an opened game's writes without treating consent as revocable.
- Browser cancellation/close paths, key buffer ownership and wiping, authenticated device transport versus fresh game signing authority, and atomic game journal handoff.

For each confirmed issue, report severity, `file:line`, a concrete sequence that reaches the bug, and the smallest sound correction. Distinguish actual bugs from missing test coverage or assumptions outside the bundle. Do not infer that an attacker controls a legitimate device or game key without saying so. Do not suggest a lower-trust callback or a replay fallback that weakens the verified ceremony. Note any incomplete integration that prevents a full online release, but do not treat separately tracked deployment or UI work as an implementation bug.

The prior startup foundation review disposition is included for context. Recheck its claims only where the current handoff depends on them. Do not assume its findings are still open. If no blocking issue remains, say so plainly.
