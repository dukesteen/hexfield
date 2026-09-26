# Deck protocol foundation checkpoint

This checkpoint implements pure Stage 07 Step 3 helpers. Step 3 and Stage 07 are
not accepted. The helpers are not yet wired into certified-log transitions or
live sessions.

The implementation adds:

- Canonical physical card points and ordered, signed shuffle and locking passes.
  Replay verifies all passes before producing a usable deck.
- Deterministic per-deck secret reconstruction from a retained master and full
  definition, with separate position locks and proof roles.
- Ordered signed partial unlocks, owner-only decoding, and public card proofs
  bound to the full command, nonce and parent.
- Immutable outgoing setup and unlock store contracts. Setup refuses a different
  predecessor for the same seat and phase. Every draw participant reserves the
  position for one operation, including the drawer. Retries verify and reuse
  stored evidence; storage failure returns no outgoing contribution.
- Window-4 precomputation within each shuffle helper call. Three original proof
  hashes pin byte compatibility; all 64 rounds and secret-safe multiplication
  remain unchanged.

`pnpm check` passes 687 tests in 121 files, including test typechecking, lint,
formatting, dependency, purity and i18n checks. The raw check log is
`/private/tmp/hexfield-stage07-step3-foundation-final-check.log`. `pnpm build`
passes all workspace packages and the production web build; its log is
`/private/tmp/hexfield-stage07-step3-foundation-final-build.log`. A fixture with
three distinct permutations checks the exact identity at every position. A
separate end-to-end fixture uses real secret providers, independently composes
their permutations, and decodes through a freshly recreated owner provider. The two
context regressions use an explicitly synthetic trusted setup to isolate parent
ordering; the other setup/draw tests generate and verify real proofs.

The [first Claude review](step3-foundation-review.md) identified two missing
durable guards and a raw-versus-validated card-table lookup. The
[response](step3-foundation-review-response.md) records the fixes, attack
regressions and remaining integration requirements. The
[follow-up](step3-foundation-followup-review.md) confirmed the setup guard and
validated-copy fix, then identified a reservation key mismatch across two valid
locked setups under one definition. Reservations now use the definition that
derives the secrets. The exact conflicting-setup test fails with the old key
and passes with the corrected key. Raw local logs are
`/private/tmp/hexfield-deck-outbox-h1-regression.log` and
`/private/tmp/hexfield-deck-outbox-h1-fixed-pass.log`. The
[final correction review](step3-reservation-review.md) confirms that the
follow-up findings are addressed within the documented helper contracts.
The three review packets have retained source manifests. The final source
checks and production build pass after the correction.

The forged shuffle test constructs bit-1 openings for a false output without
using the honest prover. It checks all 24 permutations and finds no bit-0 opening
for that same commitment. Removing the final challenge comparison makes that
test fail by accepting the forgery. The verifier was restored before the full check.
The mutation result is retained locally at
`/private/tmp/hexfield-stage07-shuffle-challenge-mutation.log`.

The [source manifest](step3-foundation-source-manifest.json) records 107 source
and test files in protocol, crypto and codec. Its fingerprint is
`17d0f908f6520f29aeec15413b6b2c581dbbf71c32bcf097eb37fec074468c9a`.

The [Chrome worker diagnostic](step3-chrome-worker.json) does **not** meet the
three-second target. A fresh worker takes about 16.5 seconds for six sequential
25-card signed shuffle passes, and 19 seconds including locking. Each pass is
proved and verified once. Both runs produce the same transcript and state
hashes. The retained [worker source](step3-worker-benchmark.source.txt) and
[bundle configuration](step3-worker-benchmark-config.source.txt) are local
diagnostic inputs, not the eventual automated acceptance test. No Firefox or
WebKit process was launched. The temporary Chrome tab and localhost server were
closed after measurement.

The next integration work must:

- Compare the genesis deck catalogue and roster to the agreed game configuration.
- Fold deck operations, next positions and dealt-slot receipts through certified
  history and replay-checked snapshots.
- Derive outgoing unlocks only from the local certified pending request. A
  peer-provided operation is not permission to decrypt a point.
- Verify `CARD_DEALT`, `PLAY_DEV_CARD` and every `CLAIM_VICTORY` slot before voting,
  even when a generic policy callback would accept them.
- Apply owner identities only after certification and restore them by replay.
- Deliver/retry the ordered contributions over memnet, verify the 50 ms-link
  draw target, and resolve the outstanding shuffle worker performance target.
