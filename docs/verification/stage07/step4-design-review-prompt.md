# Committed hands integration design review

Review the proposed Stage 07 Step 4 design against the pasted repository source.
This is read-only; tools are disabled. The user has authorized project reviews.
No real game secrets or credentials are included. Do not execute or fetch anything.

The implementation currently covers consensus, beacon, encrypted decks and owned
private replay. It does not yet have a hand commitment ledger or resource proofs.
The attached plan is a proposal, not implemented behavior. Check:

- Does an ordered engine transition effect list capture gross resource and slot
  changes without duplicating rules or changing local saves/state hashes?
- Can any base input or state-only hook escape mandatory accounting? Consider
  public bank shortages, timeout paths, monopoly zero counts and modified costs.
- Does aggregating parent debit obligations preserve trade affordability for both
  parties and prevent a credit from financing the same trade's promised debit?
- Is the combined hand/deck evidence envelope non-bypassable? Specify the needed
  contexts and validation order, without treating current stub callbacks as proofs.
- Can another-owner trade proof request reveal unauthorized information, reuse a
  proof at a new parent, authorize an unaccepted trade, or cause nonce reuse?
- Are asynchronous command preparation and count-reveal delivery compatible with
  the current session/replica boundary? Identify any missing persistent state or
  lifecycle check needed for cancellation, parent changes and restart.

Return concrete defects or unresolved design decisions with a plausible trace.
Separate required corrections from optional alternatives. Hidden transfer proofs,
escrow and full audit are later steps; do not report their absence as a Step 4
defect, but check that this design cannot silently approve those unfinished paths.
