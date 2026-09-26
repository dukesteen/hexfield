# Stage 07 Step 4 implementation proposal

This proposal implements committed resource hands under Stage 07 section 4.
It is not an acceptance report. The current verified driver has owned plaintext
hands but no public commitment ledger, resource proofs or count-reveal delivery.
The [foundation checkpoint](step4-foundation-local-checks.md) adds engine effects,
pure commitment arithmetic and accounting consistency checks. The ledger and
mandatory proof checks described below remain to be wired into certified replay.
Some Step 3 delivery recovery cases also remain open.

## Engine accounting

Add a required ordered typed `effects` sidecar to engine transitions, including
empty lists for inputs with no such effect. Propagate it through `advance` and
all delegating timeout paths. It must stay
outside `GameState`, UI events, saved state and `stateHash`. The protocol obtains
effects by applying the validated input to the current parent through the pure
engine. It must never accept an effect list supplied by another peer.

Emit effects where handlers already calculate and apply the arithmetic. Do not
introduce a second command-name switch that duplicates costs or rules. The base
effect vocabulary needs public resource debit/credit, count reveal, hidden
resource transfer, card-slot deal and card-slot reveal. Each resource movement
identifies both endpoints, bank or seat, and its relevant resource and count.
Resource amounts must be bounded
nonnegative integers. Zero-count reveals remain explicit effects.

Required base coverage:

- Setup grants use the actual second-settlement grant.
- Building and development-card purchases use the hook-adjusted cost already
  computed by the handler.
- Production uses actual payments after bank shortages and production hooks.
- Bank trades, player trades, public discards and Year of Plenty preserve gross
  debits and credits. Offer, accept and cancel do not move resources.
- A completed player trade checks both owners against their hands at the parent.
  Incoming cards cannot finance either owner's promised outgoing cards.
- Monopoly records each count reveal, including zero, followed by any debit and
  credit. The count proof must precede commitment changes.
- `CARD_DEALT` creates the slot; buying the card does not. `PLAY_DEV_CARD` and
  `CLAIM_VICTORY` identify consumed or revealed slots.
- A hidden `STEAL_RESULT` emits an opaque transfer marker. Verified mode must
  reject every `STEAL_RESULT`, including a named public resource, until Step 5
  evidence proves the beacon-selected transfer. The local mode remains unchanged.
- Timeout handlers reuse their ordinary handler's effects. An uncertain-hand
  discard continues to require the owner or an authorized recovered bot.

The current hooks `afterBuild`, `afterDiceRolled`, `onTurnStart` and `onTurnEnd`
return only state. Base hooks do not secretly move resources, but future modules
must not introduce such movements without effects. Check effects against every
seat's total, each bank resource and any exact per-resource bounds before voting.
Also compare declared slot deals/reveals with actual public slot changes. This
check detects omitted effects; it must not infer missing effects. Before enabling
another module in verified mode, define an effect-capable hook contract and
verify its accounting coverage. Reject inconsistent accounting.

Tests must compare effects with private changes on legal inputs and retain all
existing state hashes and golden replays. Include both trade owners, production
shortage, modified costs and zero monopoly reveals. Merely counting emitted
events is not sufficient.

## Pure commitment helpers

Use the existing Ristretto and Pedersen helpers. The base resource order is
`RESOURCES`, with one commitment per configured seat and resource. At genesis
all hands are empty and every commitment and private blinding is zero. Identity
points are valid commitments; deck point rules forbidding identity do not apply.

The public helper validates exact dimensions and canonical points, applies
public additions/subtractions of `count * G`, and checks owner openings. It
returns fresh values. Range width is six for the base resource cap; a wire field
cannot choose the width or grow verifier work. Missing, extra and repeated
resource proofs are rejected.

For each owner and resource, calculate gross debit obligations at the current
parent. Do not net a debit against a credit in the same trade. Multiple debits
must not each reuse the same public minimum as if the other debit did not exist.
Only when the parent minimum or a verified exact count reveal covers the entire
required debit can its range proof be omitted. Otherwise verify a range proof
for `C - debit * G`. A count reveal must precede any movement for that owner and
resource in the input, and opens the parent commitment. Credits do not raise the
known lower bound. This restriction fits base rules; a future credit-financed
module action needs an explicitly reviewed prefix-balance rule.

A count reveal verifies a Schnorr opening of `C - count * G` to `H`, including
count zero. Its context includes the full input and effect identity. A valid
range proof for one spend is not an opening proof for a count reveal.

## Certified public ledger

Add the hand ledger to `CryptoContext`. Initialize it only from checked genesis
and fold it from certified history. Check that actual genesis resource totals
and bounds are zero rather than assuming a module starts empty. Make the field
required so explicit `CryptoContext` reconstruction cannot drop it. Include it in the existing voting-context
and snapshot checks. A received snapshot or callback cannot authorize a hand.

The mandatory validation path must verify every resource obligation before
accepting the prospective engine transition or signing a vote. Generic policy
callbacks remain additional restrictions. They cannot approve a missing proof,
an overspend, a false count or a hidden transfer without Step 5 evidence.

Use one command-validation function for admission, entry validation and objective
invalid-command accusations. It checks the signed command, previews engine apply,
checks accounting and derives and verifies its obligations. Every system input
also passes accounting and the hand fold after prospective engine apply,
including beacon/deck inputs whose existing verification branch is `handled`.
In particular, production on `DICE_RESULT` cannot bypass the hand fold.

Keep command evidence composable with deck reveal evidence. Use one strictly
bounded versioned envelope whose sections are determined by the engine effects
and requested card reveals. Do not allow a hand-only envelope to bypass deck
verification, or a deck-only envelope to bypass resource verification. Inputs
with no private obligation need no empty proof packet.

Derive required deck reveals from slot-reveal effects as well. Migrate the current
`deck-reveal-v1` format explicitly; never accept it for an input with a resource
obligation, and never allow two competing evidence envelopes.

## Owned proof production and replay

Keep private blindings beside the verified driver's owned hands, never inside
public engine state or foreign-seat caches. Start at zero, leave them unchanged
for public effects, and later apply Step 5's authenticated transfer blindings.
After every certified effect, verify that each owned hand opens its public
commitment before publishing the private result. Replay performs the same
checks. A failure halts the local instance without rolling back certified state.

Introduce a master-backed hand proof source with explicit domain separation.
Its seed includes genesis, epoch, parent, seat, complete input, effect identity,
commitment and proof role. Do not use a voting key as the master, or adapt deck
position locks into resource secrets. Deterministic retries reproduce proofs;
different statements must never reuse a Sigma nonce.

## Other-owner trade proofs

Most public trades need no proof because public minima establish affordability.
When they do not, the finalizer needs the other owner's signed range proof before
submitting the final trade. A certified offer and acceptance authorize only those
terms, not arbitrary inquiries into the other owner's hand.

Account for both legal trade forms. If the active seat proposed, the counterparty
must have accepted and owes `offer.want`. If the other owner proposed a counter-
offer addressed to the active seat, that certified proposal is their consent and
they owe `offer.give`. Only the active finalizer requests a proof. Derive these
roles from the engine's `CONFIRM_TRADE` semantics and `withSeat`, not peer metadata.

A proof request must authenticate the finalizer and bind the complete proposed
command body, including its nonce, exact parent and both trade seats. The owner
checks the current certified offer, acceptance, terms, command legality and
required debit before preparing any secret-dependent response. The signed
response binds the request, commitments and exact proof obligations. The final
command signature covers that response too.

Preparation may wait for this response, but cannot block consensus or create a
certified trade before the proofs arrive. If preparation becomes asynchronous,
`P2PSession` must reserve local submission intent and recheck lifecycle, parent,
nonce and legal input after each await before signing. A parent change invalidates
the request and requires fresh evaluation. Missing peers leave a pending local
intent that can be cancelled; they cannot freeze unrelated certified progress.

Persist outgoing signed responses before sending. Key them by parent, finalizer
and complete command hash, with a small cap per parent and author. Replays reuse
the same response. A host prepares proofs only
for keys and private hands it owns. The receiver must not expose a generic
arbitrary-commitment proof service.

## Count-reveal delivery

The existing monopoly `REVEAL_COUNT` is an engine system input. Capture a frozen
operation when the certified monopoly phase begins, including its anchor,
monopolist, resource, requested victim set and those victims' commitments. Produce
bounded owner-signed contributions containing the requested count and opening
proof, bound to that operation and commitment. Before inclusion, require the
current victim commitment to equal the frozen commitment and the victim still
to owe a reveal. Earlier victims and proposer controls must not invalidate later
victims' proofs. Gossip to all peers and persist outgoing data before transmission.
Reject duplicate victim consumption. A certified game end may close the remaining
requests without inventing reveals or resource movements.

This path must continue collecting all required monopoly counts. Seats excluded
by public maximum zero need no contribution. A requested count of zero still
needs its opening proof. Built-in verification must precede any generic system
policy and must not use a callback as evidence for an unknown hand.

## Checkpoints and acceptance

1. Add pure helpers and complete engine accounting, preserving local behavior and
   goldens. Review accounting coverage before wiring it to consensus.
2. Add the replayed ledger, mandatory checks and owned proof generation. Test
   warm/replayed state, wrong contexts, overspends, missing and substituted proofs,
   exact public-minimum skips and zero counts.
3. Add bounded count-reveal delivery. Exercise signed messages, duplicate delivery,
   proposer controls and durable restart. Implement trade-proof delivery alongside
   Step 5's hidden transfers, when uncertain hands become reachable through legal
   play. Until then, return a distinct failure for a missing other-owner proof.
   That deferred integration remains required for Stage 07 acceptance.
4. Run a legal peer game segment through public production, spending, trades and
   monopoly, compare all public ledgers and owned openings, then restore each peer.

Use real hidden-hand fixtures for obligation tests, with independently checked
commitments and openings. Complete legal hidden transfers remain Step 5 work.
Peer-game segments use real beacon results and legal robber moves without a
victim where available; do not replace beacon outcomes to avoid a seven.
The project still needs that step, escrow, audit and full-game adversarial tests
before Stage 07 acceptance.
