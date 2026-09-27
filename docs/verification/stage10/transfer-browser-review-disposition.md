# Transfer browser review disposition

This disposition checks `transfer-browser-review-raw.md` against the current
source. The raw review manifest predates the fixes below, so its hashes do not
describe the current tree. This is a focused source/evidence disposition, not
native-browser acceptance.

## Findings F1–F11

| Finding | Current disposition |
| --- | --- |
| F1 — Source needs destination connectivity to finish/cancel | **Fixed.** `OnlineTransferBrowser` creates the source exchange when reopening a saved source record (`online-transfer-browser.ts:90,314-344`), so source status/cancellation can run without an open channel. `#perform` durably finishes `cancelled-awaiting-receipt` even if delivery throws (`:346-372`); the cancellation itself is still reported as pending receipt, not as destination completion. The browser regression at `online-transfer-browser.test.ts:183` uses a fake worker and checks the next source attempt can open. |
| F2 — Lost receipt strands source and destination | **Fixed in local state handling.** Source progress is marked finished after a locally verified certified outcome (`online-transfer-browser.ts:356-362`). Destination calls `onPromoted` before sending the receipt and retries receipt delivery from its pinned terminal state (`online-transfer-exchange.ts:726-737`). A receipt still means the source confirmed the exact destination outcome; no UI should treat a missing receipt as proof the destination finished loading. |
| F3 — Approved but uncertified authorization cannot expire cleanly | **Fixed.** `P2PSession.getTransferStatus` returns `expiredBeforeCertification` only when no exact signed statement is in certified history and the certified head passed its validity sequence (`p2p-session.ts:795-860`). Source retry/cancel consumes this result (`online-transfer-exchange.ts:361-404,471-487`). `online-transfer-exchange.test.ts:426` covers the expired case. |
| F4 — Failed cancel can be followed by activation/private re-disclosure | **Fixed.** `cancelRequested` is pinned in the immutable source record and cannot be cleared (`online-transfer-records.ts:33,131`). Source readiness/retry routes back to cancellation before activation or private packet preparation (`online-transfer-exchange.ts:281-283,349-353`). Focused exchange tests cover failed cancel then readiness retry (`:375-424`). |
| F5 — Reconnect or destination persistence failure strands the offer | **Fixed for the reviewed retry paths.** An approved source resumes on `start` and duplicate offer (`online-transfer-exchange.ts:220-224,257-278`); destination retries preparing/sending its retained offer (`:680-714,776-827`). These are fake-worker/exchange tests, not a real reconnecting browser test. |
| F6 — Two large outcome bootstraps overflow exchange queue after ACK | **Fixed at the bounded queue.** Queue capacity now admits two maximum 16 MiB prefixes plus 64 KiB (`online-transfer-exchange.ts:25,181-195`); the exchange test admits two such prefixes and a small packet (`online-transfer-exchange.test.ts:829`). Channel ACK remains a delivery acknowledgement only; source certification and destination receipt are separate checks. |
| F7 — Exhausted channel IDs leave retry on a dead channel | **Fixed.** Hitting the bounded ID cap closes/notifies the channel (`online-transfer-channel.ts:137-141`); the channel test checks reconnect notification (`online-transfer-channel.test.ts:452`). |
| F8 — Late source readiness regresses a terminal phase | **Fixed.** Source ignores non-receipt artifacts after activated, cancelled, or cancelled-awaiting-receipt (`online-transfer-exchange.ts:227-256`). A late receipt is still checked against the exact authorization and worker-certified outcome (`:228-249`). |
| F9 — Failed saved-destination auto-select is swallowed | **Fixed.** Selection failure clears the channel, sets a visible error, and rethrows (`online-transfer-browser.ts:298-310`). `online-transfer-browser.test.ts:282` verifies the visible error when the link observer isolates callback errors. |
| F10 — Offer pinned before verification | **Possession-validation portion fixed; full source-context validation remains at explicit confirmation.** Before immutable save, the source verifies destination device/game signatures, every replacement-key signature, and the non-identity encryption point (`online-transfer-exchange.ts:103-125,257-275`). The latest focused exchange/browser/records/channel/query run passed 33/33 and includes tampered-signature refusal followed by a valid offer. Full validation against the source's current certified authority/head still occurs only when the human confirms through `authorizeLiveTransfer` (`:322-340`); receiving an offer is not approval that its anchor remains current. Keep this boundary explicit and verify it in the native handoff. |
| F11 — Pre-approval cancel leaves destination reservation/credentials indefinitely | **Unresolved.** Source pre-approval cancellation closes locally without notifying the destination (`online-transfer-exchange.ts:459-464`). Destination rejects invalidated/expired scope on subsequent operations (`online-transfer-destination.ts:685-699,750-767`) but no expiry cleanup releases its locator or reserved credentials. Root is implementing cleanup; do not mark it complete until a restart/expiry test proves durable release. |

## Conditional findings A1–A7

| Finding | Current contract and remaining evidence |
| --- | --- |
| A1 — Does `submitTransfer` wait for certification? | **Answered yes.** `P2PSession.submitTransfer` delegates to `ReplicatedLog.submitTransfer` (`p2p-session.ts:883-887`); membership submission stores an intent and its promise is resolved by `settleMembership` only when the matching certified membership entry commits (`replicated-log.ts:592-595,665-725,3691-3702`). This is source contract evidence. Transfer session tests cover certified membership, but the browser exchange tests use a fake worker. |
| A2 — Are repeated private packets byte-identical? | **Fixed by durable protocol outbox.** `prepareTransferPrivate` derives an authorization-scoped outbox key, loads and validates prior bytes before creating a new packet, and uses immutable `putIfAbsent` with exact-byte conflict rejection (`transfer-private.ts:774-805,902-915`). `transfer-private.test.ts:154` covers durable retries with identical bytes. This is a genuine protocol/storage test, not a browser crypto trace. |
| A3 — Can ordinary certified entries exhaust bootstrap refreshes? | **Partially unresolved.** Destination retains an eight-refresh bound (`online-transfer-destination.ts:41,771-773`). A cancellation can now be observed across ordinary children after that local refresh budget is exhausted (`online-transfer-destination.test.ts:420`), fixing the raw review’s “cannot observe cancellation” path. Activation still cannot refresh/import after the budget is spent; test bounded valid refresh progress and either justify the cap against the maximum live authorization window or remove the availability failure without weakening per-attempt bounds. |
| A4 — Does promotion take the active game writer lease? | **Unresolved.** Promotion validates the staged prefix, exact activation, binding, readiness, and an `expectedActive` journal comparison (`indexed-db-protocol-journal.ts:472-525`; `online-transfer-destination.ts:1110-1189`). The destination holds its transfer-attempt ceremony lock, but `observeActivation` does not acquire the per-game writer lease. A concurrent old-game worker can make promotion lose the expected-active race. Add a two-connection lease/promotion regression before calling the race handled. |
| A5 — Does the source runtime survive retirement long enough to export final evidence? | **Source code preserves the required path; native handoff is unverified.** Source status and final bootstrap export use the still-owned session/startup (`online-worker-runtime.ts:268-280,658-667`); transfer UI owns its browser coordinator while the online game route remains open. Explicit room/worker close is still terminal. Prove this in a real source-retirement browser trace through receipt or retry; current fake-worker exchange tests do not prove runtime lifetime. |
| A6 — Can staged destination attach gameplay transport or vote? | **Rejected by current runtime guards.** `initializeTransfer` requires an uninitialized worker and sets only identity plus destination (`online-worker-runtime.ts:464-488`). `attachTransport` additionally requires an invite and generation (`:510-515`), while gameplay/session calls require startup/session (`:658-667`). The genuine destination worker test is the stronger evidence for this isolation; it is not a two-browser handoff. |
| A7 — Does chunk transfer rely on ordered/reliable WebRTC? | **Source contract is satisfied.** Both negotiated channels are created with `ordered: true` and no partial-reliability limits (`packages/p2p/src/peer-link.ts:123-125`). The transfer channel also bounds each frame, retries chunks, validates duplicates, and re-ACKs the exact final duplicate (`online-transfer-channel.ts:127-150,235-270,305-323`). The channel tests exercise dropped-frame/ACK retries, but not a native browser/network interruption. |

## Evidence boundary

Earlier focused checkpoints reported browser/exchange/panel 20/20, destination
3/3, a real-worker transfer test 1/1, transfer query 6/6, and public records
2/2. The latest combined exchange/browser/records/channel/query checkpoint
reported 33/33. The new source regressions in
`online-transfer-browser.test.ts` use signed invitation material but a
schema-shaped fake worker for status/submission; they prove UI/coordinator
recovery behavior, not cryptographic authorization. The destination worker
test exercises genuine certified transfer material and promotion, but it is
not a native two-browser handoff. In the current native Chrome check,
two-human create/join/start and source-to-destination connection/candidate
selection succeeded, but the transfer was still in progress at report time.
No mixed-browser, phone-camera, or complete native transfer/return acceptance
is claimed here.

The destination route now exists at `apps/web/src/routes/transfer/$code.tsx`
and renders `TransferDestinationScreen`; this replaces the stale statement in
`remaining-acceptance.md` that destination routing was absent. A real browser
handoff and return remain the acceptance gap. F11 expired-reservation cleanup
remains implementation work; Sol's separate takeover implementation is not
counted as complete evidence here.
