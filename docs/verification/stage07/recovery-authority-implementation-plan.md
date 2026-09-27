# Recovery authority at frozen operations

This plan covers controller signatures when a certified recovery changes the
membership epoch during an existing cryptographic operation. It does not grant
release or activation authority. The certified prefix remains the only source
of controller state.

## Authority contract

Add a replayed `ControllerRecord` for every original seat to the membership
context: `{seat, publicKey, host, status, activatedAt}`. Keep original genesis
signing keys, encryption keys, master commitments, deck lock keys and beacon
chains in their existing immutable records. The voter list must be the human
subset of current controller records. Validate sorted seats, distinct current
keys, fresh replacement keys, host ownership and the exact certified
authorization/activation transition. At every replayed parent, require
`context.crypto.epoch === context.membership.epoch`; install the next epoch in
both objects atomically when the certified transition applies.

Provide one parent-scoped resolver:

```ts
controllerAt(parent: ProposalContext, seat: Seat): Result<{
  publicKey: string;
  host: string;
  status: 'active' | 'pending-recovery';
  activatedAt: EntryRef;
}>
```

Admission of a new command, vote, proposal, contribution, receipt or dispute
uses the controller at its **certified parent**, including a rule that a pending
recovery seat cannot produce ordinary inputs. The resolver never reads a key or
host from an incoming operation. An old controller signature arriving after
the activation parent fails even when its cryptographic proof is correct.
Historical accusations and old commit certificates replay to their own
parent and use that parent's controller/voter set. The cheap certificate gate
in `replicated-log.ts` may reject malformed signatures, but must defer unknown
historical voter authority to bounded prefix replay rather than checking it
against the latest voters.

Frozen operation IDs and proof transcripts stay byte-for-byte unchanged. The
embedded `publicKey` in a frozen count victim, steal participant, deck
participant or beacon chain records the creation-time signer. It remains part
of that operation's hash and is not a live signing key after activation.
Cryptographic verification still uses the frozen commitment, point, anchor,
index, recipient encryption key and operation ID. Signature verification takes
an explicit parent-scoped controller key for the seat that submits a **new**
artifact. New operations freeze current controller keys. Their original
encryption and master-derived keys remain unchanged.

Do not rewrite a saved operation epoch to the current epoch. For existing
count and steal operations, remove the `operation.epoch === crypto.epoch` tests
in `count-state.ts` and `steal-state.ts`. Replace regeneration from the latest
genesis roster with comparison against the exact operation captured at its
certified anchor, including its original epoch, hash and participants. Replay
establishes that capture once; subsequent validation checks continuity,
pending engine request and unconsumed commitments. A mere `<=` epoch check is
not provenance. `captureCryptoPending` creates a new operation with the current
membership epoch only when no operation is already frozen.

## Artifact rules

| Artifact                 | Frozen statement                                                           | Signature rule after activation                                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Count opening            | Original victim commitment, resource, anchor, victim list and operation ID | Each newly certified `REVEAL_COUNT` uses that victim's active controller at its entry parent. Previously certified victims remain historical entries.                                                                                                                                  |
| Steal fixed contribution | Original victim hand, chosen index, ciphertext and fixed-entry reference   | The already certified fixed contribution keeps its original signer. A new fixed contribution, receipt or dispute uses the submitting seat's active controller at its entry parent. Receipt verification must still authenticate the old fixed contribution under its certified signer. |
| Deck draw                | Original setup hash, lock keys, position, prefix math and operation ID     | The `CARD_DEALT` candidate checks every included unlock against current active controllers. An uncertified pre-activation prefix is discarded and regenerated under replacement keys. An already certified deal needs no new signatures.                                               |
| Beacon reveal/extension  | Original request, hash-chain link, chain epoch, anchor and operation ID    | A new aggregate candidate checks every included signature against current controllers. Previously certified extensions remain valid in replay. An uncertified old reveal cannot be mixed into a new-epoch aggregate.                                                                   |

The current helpers that compare directly with embedded signer keys are
`verifyCountContribution`, `verifyStealContribution`, `verifyStealReceipt`,
`verifyStealDispute`, `verifyDeckUnlockPrefix`, `verifyBeaconReveal` and
`verifyBeaconExtension`. Give them a required signature-authority argument at
admission. Preserve a separate historical verifier for a certified fixed steal
contribution so receipt validation does not reinterpret its signer. In
particular, `FixedSteal` must retain the signer key resolved at the parent of
its certified `steal-fixed` entry, or the verifier must replay to that parent.
The operation's old victim key cannot verify a contribution newly fixed after
activation, and the current key cannot verify one fixed before it. Proof
statement constructors and operation-ID functions must not consume the new
argument. No callback may replace these mandatory checks.

## Durable outgoing identity

The private driver still derives a recovered seat's original deck, beacon,
hand and escrow secrets from its reconstructed master. Its signing key comes
from the certified replacement-key record, never from that master. Before
production, compare the copied signing key and authenticated transport host to
`controllerAt(currentParent, seat)`, require active status, and recheck after
any asynchronous proof or storage work. Persist the membership transition and
voting safety before releasing a new signature. An older local key record must
not sign on restore.

Current outboxes store count bytes under `operationId/seat`, deck unlock bytes
under setup/position/seat, and steal response bytes under operation/fixed-entry
/seat. Those keys are insufficient after controller replacement: loading the
old record can resend a signature that is now stale. Add the certified
controller activation reference or generation to each outgoing record key and
stored metadata. On restore, verify the retained signature against the current
controller before returning it. A different generation gets a new immutable
record; the old one stays for historical audit and must never be overwritten.
Keep deck position and steal receipt/dispute mutual-exclusion reservations
keyed by the original operation/position, so a new key does not permit a second
conflicting logical output. The same rule applies to count and beacon retry
stores. Recovered signing keys need a durable, fenced browser lease before any
outbox write or send.

## Source sequence and tests

1. Root owns replayed membership transitions, `ControllerRecord`, the
   parent-scoped resolver, entry/command/vote/proposal authority, historical
   certificate checks and the atomic membership/crypto epoch update.
2. Protocol crypto integration updates count/steal/deck/beacon validators,
   inboxes, `crypto-context.ts`, and outbox keying without changing frozen proof
   statements. The private-driver owner wires replacement signing keys and
   master-derived proof sources to this resolver. Browser storage owns the
   fenced key/lease record.
3. Focused replay tests freeze each operation at epoch 0, certify a recovery,
   and finish it at epoch 1. Reject an old-key artifact after activation and a
   new-key artifact before it. Keep old certified count entries, a fixed steal
   contribution and an extension valid through replay. Check that an old
   uncertified deck/beacon aggregate cannot mix with new signatures, that
   outbox restore signs under the new generation without overwriting old
   records, and that historical accusation verification uses the old parent.

The first cut should wire one resolver through the mandatory admission path
before enabling recovery entries. Otherwise a callback or a direct helper can
still accept a stale controller signature.
