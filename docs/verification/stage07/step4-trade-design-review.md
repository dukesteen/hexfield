# Trade proof delivery design review

**Verdict.** The consent model is sound. `handProofContext` already binds genesis, epoch, parent, and the full evidence-free body including seat and nonce. That binding is enough to stop proof reuse. Most of the added machinery is not needed for safety:

- `command-proofs-v2` in certified evidence
- the signed response inside the final command
- the two durable stores

The real risks are in routing, session liveness, and owner-side authorization. Findings are ordered by severity.

## Mandatory safety fixes

### M1 (High, liveness): the seat reservation blocks automatic inputs and has no cancel path

Trace:

1. Active seat A confirms offer 7 with B, who is remote and uncertain.
2. `submit` adds A to `inflight` and waits for B's host.
3. B's host goes offline.
4. The main-phase timer expires, and `getAutomaticInput` yields a command for A.
5. `submitAutomatic` returns early because `this.inflight.has(A)`.
6. A's turn cannot advance until something cancels the intent. `GameSession` has no cancel method, and the design names no timeout.

Fix:

- An automatic input for the reserved seat must cancel the trade intent and release the reservation before it runs.
- Add an explicit cancel entry point, such as `cancelPending(seat)`, or a bounded wait that resolves with `trade-proof-timeout`.
- The trade wait must not reuse the replica's `pending`/`inflight` semantics. Until the final signed command reaches `replica.submit`, nothing has been accepted, so cancellation is always a safe pre-admission failure.

### M2 (Medium–High, privacy): response routing is unspecified, and the existing replica broadcasts

Trace:

1. B's host answers A's request using the existing `broadcast`/`broadcastBytes` path, as `prepareSteal` does.
2. C receives the response and learns B can pay `offer.want` at parent P.
3. A then cancels, or P goes stale. The fact never becomes public through a commit, but C already has it.

Fix:

- Send the request only to the finalizer seat's owner host, and the response only to the transport-authenticated `from` that sent the request. Use `transport.send`; never broadcast either.
- On receipt, require that `from` is the genesis host of the claimed seat: `publicKey` for a human, `botHost` for a bot.
- Nothing except the final signed command ever enters `SUBMIT`.

### M3 (Medium, privacy boundary): owner-side authorization must be exact and must run where the secret lives

The design relies on `engine.validate`. The owner check is the privacy gate, so it should not depend on how the engine gates pendings. Before any `createHandSource` call, a pure `authorizeTradeProof(body, ownerSeat, context)` must require all of the following:

- `body.command` canonically equals exactly `{ type: 'CONFIRM_TRADE', offerId, withSeat }`, with no extra keys. `validateSignedCommand` accepts any `CommandShape` the engine tolerates. If the engine ignores unknown keys, a finalizer can mint unlimited distinct bodies at one parent, each needing a fresh proof and fresh cap accounting.
- `body.nonce === last + 1`, not merely `> last`, which is all `validateSignedCommand` checks.
- `body.seat === state.turn.activeSeat`.
- The sender is the finalizer seat's owner host (see M2).
- For an active offer: `offer.proposer === body.seat`, `withSeat === ownerSeat`, and `offer.acceptedBy.includes(ownerSeat)`.
- For a counter-offer: `offer.proposer === ownerSeat === withSeat` and `offer.to.includes(body.seat)`.
- The owned indices are derived locally as `plan.obligations` filtered by `seat === ownerSeat`, and that set is non-empty.

This check must live in the driver's producer, next to the existing `appliedHead` freshness check that `produceCountProof` and `produceStealContribution` use. The inbox is not the last line, so it must not be the only line.

### M4 (Medium, spec gap, only if v2 is kept): v2 must be mandatory and single-sourced

As written, the design admits two encodings and two copies of the same proofs:

- "Other owner" is ambiguous. It could mean another seat or another host.
- The v2 envelope "keeps the ordered hand sections and adds the signed response," so each foreign proof appears twice.

Trace:

1. A submits v1, containing B's proofs that A obtained (or could compute; see S1).
2. The current `readCommandProofs` accepts it.
3. Attribution is therefore optional and proves nothing.

Alternatively, the `hands[i]` entry and the proof at the response's index _i_ differ while both being valid, so certified evidence carries an unattributed proof.

If v2 is kept:

- "Other owner" means any seat other than `body.seat`. A same-host bot signs its response locally with its own key.
- v1 must be rejected whenever such an obligation exists.
- The hand list must be reconstructed from the signer's indexed proofs plus the response's indexed proofs, with no separate copy.
- Response indices must equal exactly the derived owner set. Missing indices must fail, not only unknown, duplicate, or extra ones.

### M5 (Medium, spec gap, only if v2 is kept): the request ID cannot be recomputed by validators

"Request ID is a hash of the signed request." Validators hold only the final command, so they cannot recompute that hash unless the request signature is embedded.

Either:

- define `requestId = H('trade-proof-request', evidenceFreeBody)`, or
- carry the request signature in v2 and verify it.

The first option is simpler, and the body is already the binding.

### M6 (Low–Medium): stale and future requests must be neither struck nor dropped permanently

A request can arrive when the owner is one entry behind (future head) or ahead (stale). In `attachTransport`, codes ending in `-signature`, and `command-proof-invalid`, strike the sender.

Fix:

- Stale and future outcomes must use non-strike codes.
- Future-head requests should be deferred to a bounded one-slot buffer, or the requester should retransmit on `pulse` while the intent is live.
- Only an authenticated request that is still invalid at the matching parent should strike.
- Charge request handling to `admitExpensiveRequest`, keyed by the body hash.

## Liveness trace needing a decision

### L1 (Medium): third parties can starve confirmations

A request must survive a full round trip with no certified entry landing in between. Trace:

1. C repeatedly submits `PROPOSE_TRADE` or `CANCEL_TRADE`, or beacon entries arrive.
2. Each commit moves the head.
3. A's request to B is always stale by the time the response arrives.
4. A trade needing B's proof never completes, while ordinary locally-prepared commands still do.

Nothing in this step can rebase, because the proof binds the anchor. That is correct and should stay. See D3.

## Decisions needed before implementation

**D1. Keep signed responses in certified evidence (v2), or use v1?** Recommendation: v1.

Signed responses are not necessary:

- Consent is already the certified acceptance or proposal.
- Soundness comes from each `HandProof` binding the exact body, nonce, and parent. Who produced the proof does not matter.

Signed responses are not sufficient for attribution either. The proof shows knowledge of an opening, not identity. A thief who knows the victim's transfer blindings, and whose other randomness is known, can produce the victim's range proofs. So a signed response adds no guarantee the proof lacks.

The payoff is large: the current `validateCommandForEntry` → `readCommandProofs` → `verifyHandProofs` path already accepts other-seat proofs in v1 with exact arity. Admission, voting, and replay need **zero** changes, and the same-host case needs no special encoding. M4 and M5 disappear.

**D2. Durable responder and requester stores?** Recommendation: none. `proofSeed(handProofContext(...))` is deterministic, and the private hand at a given parent is deterministic from certified replay. Regeneration therefore yields identical proof bytes. The same context cannot pair with a different witness, so there is no nonce-reuse hazard to guard against.

The requester intent is also safe to drop on restart:

- Before `replica.submit`, nothing is consumed.
- After it, the existing "outcome unknown" semantics apply.

Keep an in-memory cap and dedupe only. This also avoids pulling storage work forward from its later stage.

**D3. Starvation policy (L1).** Pick one:

- (a) Accept it and surface a clear `trade-proof-stale` retry.
- (b) Recommended: while the user's intent stands, the finalizer's host re-requests automatically at each new parent. Stop after N attempts or when the offer, `withSeat`, or terms change. This is not a "silent stale trade": standing consent and the user's selected offer are unchanged, and each attempt is freshly bound. The design currently forbids this, so it needs an explicit call.

**D4. Correct the privacy paragraph.** The paragraph overstates the per-parent leak. The owner's affordability of fixed terms changes only through hidden hand changes; public effects move the bounds visibly. Repeated requests between hidden changes return the same bit. The true added disclosure is at most one bit per hidden change to the owner's hand while the offer stands. Also state that the owner never sends a distinguishable "cannot pay" reply. Failure looks the same as an offline owner, apart from timing.

## Optional simplifications

- **S1.** Adopt D1 and D2. Then `command-proofs.ts` and `log.ts` stay unchanged, and `trade-proof-delivery.ts` shrinks to the authorization function, wire schemas, and an in-memory inbox.
- **S2.** Transport `from` is already authenticated (`checkLocalKey` ties `transport.self` to the voter key). Wire signatures on request and response become optional. If you keep them for defence in depth, sign the body hash instead of creating a separate request-ID domain.
- **S3.** Split `prepareCommand` into two methods:
  - `proveOwnedObligations(plan, indices, binding)`, shared by the finalizer's own proofs and the responder;
  - an assembler that inserts verified foreign proofs by index and then runs the full `validateCommandForEntry` locally before signing.

  The existing synchronous path keeps returning `hand-proof-owner`, as `hand-trade.test.ts` expects.

## Test additions beyond the design's list

- An automatic input or timer for the reserved seat cancels the intent, and the session proceeds (M1).
- A third peer receives no trade-proof bytes in any path, including a response to a request that later went stale (M2).
- Each of the following fails before any hand source is created (M3):
  - extra command key
  - nonce `last + 2`
  - non-active finalizer
  - `withSeat` set to a non-acceptor
  - sender that is not the finalizer's host
- A future-head request gets no strike and is served after sync (M6).
- If D1 is adopted: a v1 `CONFIRM_TRADE` carrying B's proofs, produced remotely or locally, passes admission, voting, and replay unchanged. The same bytes with one proof swapped between indices fail.
