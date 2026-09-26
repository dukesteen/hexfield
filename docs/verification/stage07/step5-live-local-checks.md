# Certified hidden-steal integration

This checkpoint connects the reviewed transfer proofs to certified entries,
private hand replay, and peer delivery. Stage 07 and milestones C/D remain open.

## Implemented behavior

- The certified beacon result fixes the operation, participant identities,
  recipient encryption key, victim commitments, hand size and selected index.
  A `steal-fixed` entry certifies the signed victim contribution without moving
  any resources.
- The shared log validator requires a matching recipient receipt before applying
  a hidden `STEAL_RESULT`. The local engine must produce exactly the corresponding
  hidden transfer. Only then do public commitments change and the fixed beacon
  and steal state clear.
- An authenticated bad-opening dispute can be certified before completion. It
  preserves hands and blocks the result. Later cheat handling must decide the
  recovery/exclusion response; an untrusted failure is not accusation evidence.
- The private driver reconstructs an owned victim opening from retained secrets
  and decrypts for an owned recipient. It updates candidate counts and all five
  blindings, verifies the resulting commitments, and publishes the complete local
  update atomically. Certified replay reconstructs the same hands.
- Victim contributions and recipient responses use immutable write-before-send
  storage. One response slot holds a receipt or a dispute. Restore verifies and
  reuses stored bytes. Disposable inboxes ignore stale operations and duplicates;
  authoritative entry validation still checks every proposed result.
- Session startup rejects missing delivery stores/callbacks and checks each owned
  encryption source against its original genesis key. Raw session options cannot
  substitute proof callbacks for the owned private driver.

## Focused verification

The full two-peer trace starts at genesis and uses legal game inputs. It drops a
victim contribution, restarts both peers, verifies byte-identical retransmission,
completes exactly one hidden transfer, and verifies the same private hands after
another restart. The final full-suite run completes this trace in 25.08 seconds. While delivery is
held, retry pulses reuse identical persisted bytes without another store load or
transfer-proof generation.

Focused tests cover wrong fixed bindings, premature results, stale and replayed
receipts, a genuine DLEQ dispute for an authenticated malicious opening, atomic
private failure, store races/corruption, stale-message proof-work filtering, and
strict wire schemas. Privacy regressions reject copied ephemeral points/proofs,
refuse a dispute for an unauthenticated encryption point, and reject an old
transfer proof attached to a changed sealed payload.

## Final local gate and review

Verified on 2026-09-27 with Node 22.23.3 and pnpm 10.7.1. The combined
[local check](step5-live-check.txt) passes typechecking, lint, formatting,
dependency boundaries, engine purity, translations and **852 tests in 149 files**.
One opt-in draw timing benchmark is skipped. The test phase took 181.41 seconds
with at most two workers. The [production build](step5-live-build.txt) also passes.
No browser suite or large game batch was run for this protocol-only checkpoint.

The [254-file source manifest](step5-live-source-manifest.json) has fingerprint
`eb1cd1984fabc68483c0c4b44a1319c812a00cb4c435f23a3f0e89bd628b25f2`,
unchanged before and after the final check and build. Initial attempts caught two
new-test typing/lint issues before running the tests; the final gate includes
their corrections.

The initial Claude review found a shared-secret disclosure attack, reproduced
before its fix. Contributions now require authenticated knowledge of the sender's
ephemeral scalar before a recipient may disclose a shared point in a dispute.
The follow-up review confirms the fix and reports no concrete high or medium
issue in its attached code. A source audit checks its cross-protocol condition:
no other implemented path discloses a point under the genesis encryption secret;
deck unlocks use separate keys. The [review response](step5-live-review-response.md)
records the remaining hardening, test findings and future-protocol constraint.

## Remaining work

Other-owner spending-proof delivery for uncertain player trades, typed cheat
handling, escrow, end-game audit and adversarial full-game integration remain.
The eight-type Chromium proof performance target is still open. Real WebRTC,
lobby setup and durable browser recovery remain in stages 08–10. This mode is
not exposed in the production UI, and no public-release claim is made.
