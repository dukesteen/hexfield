# Trade proof delivery for uncertain hands

## Certified consent and proof scope

`CONFIRM_TRADE` is the only player-trade command that moves resources. An active seat's certified `OFFER_TRADE` needs a certified `RESPOND_TRADE` with `accept: true` from the chosen recipient. A non-active seat's certified `PROPOSE_TRADE` is its consent to a counter-offer addressed to the active seat. These terms remain standing consent until withdrawal, cancellation, or engine invalidation. The engine rechecks both parties' current affordability at confirmation. This design adds no confirmation UI.

`planHandTransition` derives gross debit obligations from the certified parent. A credit in the same trade cannot fund a debit. Public minima may already establish affordability. A peer requests another host's proof only when a legal `CONFIRM_TRADE` has an obligation for a seat whose private hand that other host owns. The request cannot specify resource amounts, commitments, or proof statements. The owner derives those from the certified offer and engine effects. When one host owns both seats, it prepares both proofs locally with the same `command-proofs-v1` evidence.

The final command keeps `command-proofs-v1`. Its ordered hand section contains one proof per required obligation, regardless of which host produced it. The existing `validateCommandForEntry` path calls `readCommandProofs` and mandatory `verifyHandProofs` during admission, voting, and replay. Each proof binds genesis, epoch, exact parent, complete evidence-free command body including seat and nonce, engine input and effects, obligation index, and parent commitment. The finalizer signs the assembled command and evidence. No trade response or duplicate proof list enters the certified log. Certified offer consent and the exact-body proof are the authority; a response signature authenticates the transient exchange before the finalizer uses it.

## Request and owner authorization

The active finalizer forms the complete command body without `evidence`: game ID, genesis digest, its seat, next nonce, exact `headSeq` and `headHash`, and exactly `{ type: 'CONFIRM_TRADE', offerId, withSeat }`. It signs the body under `trade-proof-request`. Define `requestId` as a domain-separated hash of the evidence-free body, so both peers can recompute it without a request signature in the final command. Wire signatures still authenticate both request and response.

Send the request only to the proof owner's genesis host. A human seat's host is its `publicKey`; a bot seat's host is its `botHost`. The receiving transport checks that its authenticated `from` is the finalizer seat's genesis host. `authorizeTradeProof(body, ownerSeat, context)` then runs inside the private driver's producer, before `createHandSource` or any witness read. It checks:

1. The command is the exact canonical three-field `CONFIRM_TRADE` shape, with no extra keys. `body.seat` is the active finalizer, and `body.nonce` equals its last certified nonce plus one.
2. Game, genesis digest, epoch, `headSeq`, and `headHash` match the current certified context. The driver's `appliedHead` matches that head. The signed requester is the finalizer's genesis identity, and the receiving host controls `ownerSeat`.
3. `engine.validate` and `engine.apply` accept this confirmation now. For an active-seat offer, the offer proposer is the finalizer, `withSeat` is `ownerSeat`, and `acceptedBy` contains that owner. For a counter-offer, the proposer and `withSeat` are `ownerSeat`, and the offer addresses the finalizer. The owner checks the exact certified `give` and `want` from the offer, including the side it owes.
4. The locally derived `planHandTransition` has at least one obligation for `ownerSeat`. The response indices equal all and only those obligations. No peer-provided plan or indices authorize a proof.

The owner uses its current private opening and `proofSeed(handProofContext(...))` to generate those indexed proofs. The response signs `requestId`, owner seat, and indexed proof bytes under `trade-proof-response`. Send it only to the authenticated finalizer host, never broadcast it. The finalizer verifies the owner signature, route, request ID, exact index set, and each proof before assembly. No request or response enters `SUBMIT`; only the final signed command does.

## Waiting, retries, and cancellation

Proof preparation is a cancellable pre-admission intent, separate from `replica.submit` and its pending command state. `P2PSession.submit` reserves the local seat while it waits, but an automatic command or timer for that seat cancels the intent and releases the reservation before it runs. Add `cancelPending(seat)` or an equivalent explicit cancellation method. Dispose also cancels. A 10-second overall wait returns `trade-proof-timeout`; a disconnected owner cannot stop the turn indefinitely. Nothing has reached consensus before the final command is submitted.

The coordinator may retry at a new certified parent while the user's selected `offerId`, `withSeat`, and exact certified terms remain unchanged and consent still stands. Allow at most three fresh-parent attempts after the initial request and stay within the same 10-second overall wait. Every attempt uses a new body, nonce, parent and hand-proof context. It never rebases or reuses an old proof. A changed offer, withdrawal, invalidation, automatic input, timer, cancellation, or disposal ends the intent. After each await, check liveness, ownership, parent, next nonce and command legality again before signing. A response arriving for an old attempt cannot enter the new command.

No new durable outbox is needed for this pre-admission exchange. For one certified parent, private state replay and `proofSeed(handProofContext(...))` regenerate identical proof bytes. Keep a bounded in-memory response cache keyed by `requestId` and owner seat; exact retries reuse the cached response. On restart, the pre-admission intent is dropped. A user may submit again against the restored certified parent; the owner can regenerate the same response. Once a final signed command reaches `replica.submit`, the existing submission and outcome-unknown rules apply. The owner checks `appliedHead` before private source use, and the finalizer signs and submits only after its last parent check. Neither peer votes for a stale operation.

The wire parser bounds message and proof counts before expensive checks. Admit only authenticated requests for an exact legal consented trade. Cap distinct request body hashes per finalizer and parent while allowing retries of the same body. A future-head request gets no peer strike; retain one bounded future request or retransmit while the intent is live so a catching-up owner can answer. A stale request gets no strike and no proof. Only an authenticated request that is invalid at a matching parent may count as abuse. Responses follow the same non-strike stale/future handling.

## Privacy boundary

The owner gives standing consent to the exact certified trade terms. A positive proof tells the authorized finalizer that the owner can pay those terms at that parent. The owner sends no distinguishable "cannot pay" response; failure is indistinguishable from an offline owner apart from timing. Exact command shape, signed finalizer identity, certified consent, owner-host routing, bounded distinct requests, and no third-party broadcast keep this from becoming a general hand-balance query service.

The remaining disclosure is current affordability for those consented terms at each fresh parent where the finalizer asks. Public gains and debits can change the threshold even without a hidden hand change, so there is no sound "one bit per hidden change" bound. The engine keeps accepted offers across hand changes and rechecks affordability at confirmation. Hiding later affordability would require different trade consent rules, such as expiring an acceptance after a hand change. That rule change is outside this delivery protocol.

## Suggested source ownership

- `trade-proof-delivery.ts`: strict wire schemas, request and response signatures, body-hash request ID, pure `authorizeTradeProof`, local obligation-index checks, and bounded in-memory deduplication.
- `trade-proof-inbox.ts`, `messages.ts`, and `replicated-log.ts`: authenticated host-only `transport.send` routing, message limits, non-strike stale/future handling, and retry on peer catch-up. Trade messages never become consensus candidates.
- `verified-session-driver.ts`: source-side authorization beside `appliedHead`, owner-only indexed proof production, and local assembly support. The existing synchronous `prepareCommand` still returns `hand-proof-owner` when it lacks a remote proof.
- `p2p-session.ts`: asynchronous confirm-only coordinator, pre-admission reservation, explicit cancellation, bounded fresh-parent attempts, overall timeout, stale checks after every await, and final v1 proof assembly and signing.
- `hand-transition.ts`, `command-proofs.ts`, and `log.ts`: retain their existing proof statement, v1 envelope, gross parent-debit plan, and mandatory command verdict. No trade-specific certified evidence branch is needed.

## Focused checks

1. Active offer plus certified acceptance and certified counter-offer each authorize only the exact finalizer, counterparty, offer ID, terms, and owned debit obligations. Extra command keys, nonce `last + 2`, a non-active finalizer, a non-acceptor, a wrong host, and a changed head fail before any hand source runs.
2. A signed response from the wrong owner, substituted request ID, missing, duplicate, extra, or reordered indices, and a proof for another commitment fail. A valid v1 confirmation with remotely produced proofs passes the unchanged admission, voting, and replay verifier; swapping two proof slots fails. Same-host proofs use the same v1 format without network messages.
3. A dropped response retries with identical bytes. A catching-up owner serves a future request after sync without a strike. Stale requests and responses are ignored without a strike. Restart drops an unsubmitted intent; a fresh user submit against the same parent regenerates identical proofs.
4. An automatic command or timer cancels a reserved trade intent and proceeds. Explicit cancellation, dispose, 10-second timeout, three-attempt cap, changed terms, and a late old-parent response all release the reservation without submitting the stale trade.
5. One legal two-peer session completes an accepted trade after a hidden steal. A third peer receives no request or response bytes. Both trade peers certify one confirmation, derive equal public commitments, and update only their owned private hands.
