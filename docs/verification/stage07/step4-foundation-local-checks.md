# Committed hands foundation

This checkpoint adds the accounting foundation for resource proofs. It does not
yet enforce those proofs in the certified log or expose online play.

The engine now returns ordered accounting effects beside state and UI events.
The effects identify both endpoints of public transfers, preserve gross trade
legs, use actual hook-adjusted costs and production payments, record zero-count
reveals, and identify dealt/revealed card slots. Hidden steals have a separate
opaque effect. Effects remain outside engine state and its hash.

The pure commitment helper validates exact seat and resource dimensions,
canonical group encodings and six-bit counts. Empty hands use identity
commitments. Public additions and subtractions preserve blindings; an owner can
check its private opening against all five public commitments.

The consistency checker projects the declared effects and compares public hand
bounds, bank counts, deck positions and card slots with the prospective engine
state. It rejects inconsistent accounting but does not authorize inputs or prove
private ownership. It also cannot discover completely omitted gross movements
whose net change is zero; handler emission and proof-obligation tests remain
necessary. Resource-changing extension hooks need an explicit effect contract
before verified mode can enable them.

## Verification

The final `pnpm check` passes 772 tests in 134 files with one intentional skip
for the opt-in draw timing benchmark. The test suite takes 116.17 seconds.
Type checks, lint, formatting, dependency boundaries, purity and translations
pass. `pnpm build` passes as well. Golden replays retain their existing state
hashes. The [check log](step4-foundation-check.txt) and
[build log](step4-foundation-build.txt) retain the results.

The [200-file source manifest](step4-foundation-source-manifest.json) has
fingerprint `3105303c0a866cfe8bd86091703fbbd1a0b3281fe987559b3e27c815cf2f9014`.
The read-only [source review](step4-foundation-review.md) found no high-severity
defect. The [response](step4-foundation-review-response.md) records strict input
validation, zero-transfer rejection, clarified consistency limits and added tests.
The final gate includes these fixes.

The checker also replays two existing golden histories (all development card
types and a hidden-VP win), preserving their recorded hashes. The short legal
accounting segment uses ordinary setup, dice production, purchase and deal inputs. Synthetic bounds in the smaller consistency tests are used only to
check arithmetic and rejection behavior, not as evidence for legal peer play.

## Additional deck delivery coverage

Short legal draw traces now cover one human hosting three bots and four human
voters. They compare certified heads, cursor/slot consumption, ordered unlocks
and owned private recovery. The single host also persists the consecutive bot
unlocks. The four-human certificate contains the required three distinct voters;
all three non-drawer seats still contribute their cryptographic unlocks.

The held-active two-human draw injects an invalid longer prefix, repeated copies,
future operations and stale retries after completion. The link remains available
and the original draw still certifies. This tests bounded handling at live ingress;
it does not measure proof-call counts or claim fifth-variant disconnect coverage.

Proposer control while a draw is active is still covered only by the pure log
transition test. Live recovery of an excluded required unlocker depends on later
escrow work. The current base engine supports at most four seats; six-seat proof
and wire-bound tests are separate from these live games.

## Next integration

Add the hand ledger to certified replay, then require the same accounting and
proof verdict during command admission, voting and accusation verification.
Add owner proof production, private-opening checks after commits/replay and
monopoly count-reveal delivery. Hidden steals, trade proof delivery for uncertain
hands, escrow and end-game audit remain later Stage 07 work. Milestones C and D
remain incomplete.
