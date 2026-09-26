# Signed Monopoly count review response

The [read-only review](step4-count-review.md) found no high-severity safety defect
in the submitted proof chain. Its [manifest](step4-count-review-manifest.json)
identifies the exact packet. The corrections and added tests below postdate that
packet; the final source manifest records the checked tree.

## Corrections

- M1: verified replica startup now requires a count proof producer and durable
  count store. Missing configuration fails before starting its journal or sending
  protocol messages. A corrupt runtime outbox still fails closed. Automatic
  overwrite would violate immutable retries; operator/browser recovery belongs
  in Stage 10. Applications must also configure a working master-backed hand
  source for their private driver. A source failure follows the same halt policy.
- L1: owner authentication now runs on the shared selected-input path before
  engine application. A synthetic extension with a real, valid signed beacon
  result returning `REVEAL_COUNT` passes the beacon handler but still fails the
  mandatory owner-count check. Built-in handling cannot skip it.
- L2: a rejected count candidate no longer suppresses engine-validated commands,
  including a terminal claim. It falls through after reporting the local
  derivation failure. The inbox retains verified evidence, rather than discarding
  it because a local accounting check failed. This fallback does not make an
  unsupported module or inconsistent hand state valid.
- L3: the session options type omits raw `countProof`, and runtime option copying
  removes an injected callback before installing the owned private driver's
  method. The startup regression passes a raw JavaScript-style callback with a
  driver that has no count method and verifies rejection without calling it.

## Test corrections

- T1: invalid-count cases now carry an otherwise correct post-state hash and
  assert the owner-verification error. The wrong amount uses a victim whose
  public bounds genuinely permit either zero or one, so the engine cannot mask
  a missing proof check.
- T2: the inbox comment now describes refresh and victim consumption. The
  separate validator test covers a signed, state-preserving control entry.
- T3: the driver test verifies the returned count proof. A stale head and a
  mismatched owned commitment fail before another hand-source call. Its zero
  blinding is stated by the fixture; the pure proof tests use nonzero blindings.
- T4: added a real losing `putIfAbsent` race with a different valid signed winner,
  missing and corrupt winners, rejected persistence, and caller-key mutation
  across an awaited load. The winning immutable bytes are returned exactly.
  These bounded tests do not claim a live replica disposal-during-write test.

- T5: the live trace now pauses with one victim unconsumed after storing its
  signed contribution. Both peers restore from retained journals/stores, compare
  their heads and hosted hands, resend the exact original bytes and finish the
  exchange. The test asserts the exact victim seat set, including exclusion of
  max-zero seats, rather than only counting entries.

The live base-game trace uses exact public hands, so its requested counts are
positive. Zero-count delivery is covered by the synthetic uncertain-hand
validator and private-driver cases. Those are deliberately separate claims.

## Remaining boundaries

L4 remains part of Stage 07 cheat handling: invalid count proposals are rejected,
but the existing objective `invalid-command` accusation only covers commands.
Extending objective accusations to system inputs requires binding the correct
certified parent and proof kind; generic peer strikes are not that evidence.

A withholding victim can still pause progress until authorized recovery exists.
Current zero blinding reflects publicly exact hands, not private hiding. Step 5
must deliver and replay hidden transfer blindings. Legacy verified journal and
wire-version migration remains a gate before production online release.
