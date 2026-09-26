# Committed hands foundation review response

The read-only [review](step4-foundation-review.md) found no high-severity defect
in this foundation. The [manifest](step4-foundation-review-manifest.json) identifies
the exact packet reviewed; it predates the fixes and extra tests below. The final
source manifest in the [local checkpoint](step4-foundation-local-checks.md) covers
the resulting source. This checkpoint does not enforce hand proofs in consensus.

## Corrections

- Parse public commitment movements through the strict canonical schema before
  reading any fields. Null and accessor-bearing inputs return failures without
  invoking getters.
- Reject zero-count public transfer effects. Zero-count monopoly reveals remain
  explicit and valid.
- Document that conservation alone cannot establish the original transfer
  endpoints or order, or detect omitted gross legs whose net change is zero.
  Effects must come from the local engine, not a peer-supplied list.

## Added evidence

Engine tests now cover counter-offer confirmation, Year of Plenty with a partial
bank, production shortages with multiple recipients, and hook-adjusted development
card costs. They compare the relevant private changes as well as effects. Existing
coverage includes setup grants, road costs, public trades, monopoly zero and
positive reveals, draws, card plays, victory reveals and timeout discards.

The accounting checker now runs over two retained golden histories: all development
card types and the hidden-VP win. The histories and expected hashes are unchanged;
no new random-game batch was added. Targeted fixtures also check actual hidden
and named steal transitions and monopoly with uncertain bounds. Those synthetic
fixtures demonstrate accounting, not complete legal peer histories.

Commitment tests cover nonzero blindings, malformed group encodings, wrong rosters,
noncanonical scalars, missing and extra opening fields, negative/fractional counts,
foreign owners, and arithmetic debits below zero. The last case explicitly shows
that arithmetic alone does not authorize spending.

## Required in the next integration

Derive gross debit obligations from parent bounds before incoming credits. Reject
all verified `STEAL_RESULT` inputs until Step 5, including named-resource steals.
Require deck evidence for slot identities and count-opening evidence for every
requested monopoly reveal, including zero. Detach effect objects before using
asynchronous proof production or hashing proof contexts. Apply identical validation
to ordinary commands, timeout delegates, admission, voting and accusations.

The limits remain specific to the base game. Other modules need reviewed resource
and effect contracts before verified mode enables them. Hidden-transfer proofs,
other-owner trade proof delivery, escrow and final audit remain unfinished.
